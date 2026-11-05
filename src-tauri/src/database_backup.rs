//! Pre-migration snapshots, verification, restore, and the startup recovery dialog.
//!
//! `workflow.sqlite3` is the user's only copy of their data. Before this build migrates a
//! database it keeps a verified copy of that exact database under `backups/`, so a failed
//! migration or a corrupt file is recoverable. Recovery is a native startup dialog; there is
//! no IPC or frontend surface for it.

use crate::{fs_paths::app_data_dir, kanban::CURRENT_SCHEMA_MIGRATION};
use rusqlite::{backup::Backup, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use uuid::Uuid;

pub(crate) const DATABASE_FILE: &str = "workflow.sqlite3";
pub(crate) const BACKUPS_DIR: &str = "backups";
pub(crate) const SNAPSHOT_RETENTION: usize = 5;

const SNAPSHOT_PREFIX: &str = "workflow-";
const SNAPSHOT_SUFFIX: &str = ".sqlite3";
const STATE_MARKER: &str = ".schema-state.json";
const TEMP_PREFIX: &str = ".tmp-";

/// What the startup recovery dialog decided.
pub(crate) enum RecoveryAction {
    Restore(PathBuf),
    Quit,
}

/// Copy a database with SQLite's online backup API. The source is opened read-only and never
/// written; the destination is replaced wholesale.
pub(crate) fn online_backup(source_path: &Path, destination_path: &Path) -> Result<(), String> {
    let source = Connection::open_with_flags(
        source_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| {
        format!(
            "Could not open {} read-only for backup: {error}",
            source_path.display()
        )
    })?;
    let mut destination = Connection::open(destination_path).map_err(|error| {
        format!(
            "Could not create the database copy at {}: {error}",
            destination_path.display()
        )
    })?;
    let backup = Backup::new(&source, &mut destination).map_err(|error| {
        format!(
            "Could not start the SQLite online backup of {}: {error}",
            source_path.display()
        )
    })?;
    backup
        .run_to_completion(128, Duration::from_millis(10), None)
        .map_err(|error| {
            format!(
                "Could not complete the SQLite online backup of {}: {error}",
                source_path.display()
            )
        })
}

/// FNV-1a 64 over every `sqlite_master` row. Cheap, dependency-free, and stable enough to
/// notice a schema that changed without a `schema_migrations` row.
fn schema_fingerprint(connection: &Connection) -> Result<String, String> {
    let mut statement = connection
        .prepare(
            "SELECT type, name, COALESCE(sql, '') FROM sqlite_master ORDER BY name, type",
        )
        .map_err(|error| format!("Could not inspect the database schema: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("Could not read the database schema: {error}"))?;
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for row in rows {
        let (kind, name, sql) =
            row.map_err(|error| format!("Could not read a database schema row: {error}"))?;
        for byte in format!("{kind}|{name}|{sql}").as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    Ok(format!("{hash:016x}"))
}

/// Highest applied `schema_migrations` version, or `0` when the table does not exist yet.
fn schema_revision(connection: &Connection) -> Result<i64, String> {
    let has_migrations: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect the database migrations: {error}"))?;
    if !has_migrations {
        return Ok(0);
    }
    connection
        .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |row| row.get(0))
        .map_err(|error| format!("Could not read the database schema revision: {error}"))
}

fn open_read_only(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Could not open {}: {error}", path.display()))
}

/// Full validation for snapshot copies: `integrity_check` plus `foreign_key_check`.
fn verify_database(path: &Path) -> Result<(), String> {
    let connection = open_read_only(path)?;
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("Could not verify {}: {error}", path.display()))?;
    if integrity != "ok" {
        return Err(format!(
            "{} failed integrity_check: {integrity}",
            path.display()
        ));
    }
    let violations: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Could not verify foreign keys in {}: {error}", path.display()))?;
    if violations != 0 {
        return Err(format!(
            "{} has {violations} foreign-key violation(s)",
            path.display()
        ));
    }
    Ok(())
}

/// Cheap launch check for the live database. Full `integrity_check` is reserved for snapshot
/// copies and for the copy taken before a restore.
fn verify_live_database(path: &Path) -> Result<(), String> {
    let connection = open_read_only(path)?;
    let quick: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| format!("Could not open the database at {}: {error}", path.display()))?;
    if quick != "ok" {
        return Err(format!(
            "{} failed quick_check: {quick}",
            path.display()
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SchemaState {
    schema_revision: i64,
    fingerprint: String,
    snapshot: Option<String>,
    app_version: String,
}

fn read_schema_state(backups: &Path) -> Option<SchemaState> {
    let text = fs::read_to_string(backups.join(STATE_MARKER)).ok()?;
    serde_json::from_str(&text).ok()
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Snapshot files in `backups/`, newest first.
fn snapshot_files(backups: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = match fs::read_dir(backups) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "Could not read the backups directory at {}: {error}",
                backups.display()
            ))
        }
    };
    let mut snapshots = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not read a database backup entry: {error}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(SNAPSHOT_PREFIX) || !name.ends_with(SNAPSHOT_SUFFIX) {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH);
        snapshots.push((modified, name, entry.path()));
    }
    snapshots.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    Ok(snapshots.into_iter().map(|(_, _, path)| path).collect())
}

fn has_snapshot_with_prefix(backups: &Path, prefix: &str) -> Result<bool, String> {
    Ok(snapshot_files(backups)?.iter().any(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(prefix))
    }))
}

fn prune_backups(backups: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(backups) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Could not read the backups directory at {}: {error}",
                backups.display()
            ))
        }
    };
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not read a database backup entry: {error}"))?;
        let name = entry.file_name();
        if name.to_string_lossy().starts_with(TEMP_PREFIX) {
            if let Err(error) = fs::remove_file(entry.path()) {
                eprintln!("Could not remove the stale database temp file: {error}");
            }
        }
    }
    let snapshots = snapshot_files(backups)?;
    for stale in snapshots.into_iter().skip(SNAPSHOT_RETENTION) {
        fs::remove_file(&stale)
            .map_err(|error| format!("Could not prune the old backup {}: {error}", stale.display()))?;
    }
    Ok(())
}

fn write_snapshot(database: &Path, backups: &Path, prefix: &str) -> Result<PathBuf, String> {
    let temporary = backups.join(format!("{TEMP_PREFIX}{}{SNAPSHOT_SUFFIX}", Uuid::new_v4()));
    let result = (|| {
        online_backup(database, &temporary)?;
        verify_database(&temporary)?;
        let destination = backups.join(format!("{prefix}{}{SNAPSHOT_SUFFIX}", unix_timestamp()));
        fs::rename(&temporary, &destination).map_err(|error| {
            format!(
                "Could not store the database snapshot at {}: {error}",
                destination.display()
            )
        })?;
        Ok(destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Write a verified pre-migration snapshot when this launch could change the schema.
///
/// Snapshots happen when the applied schema revision is behind this build, when no schema
/// state marker exists, or when the live schema fingerprint differs from the recorded one.
pub(crate) fn ensure_pre_migration_snapshot(root: &Path) -> Result<Option<PathBuf>, String> {
    let database = root.join(DATABASE_FILE);
    let backups = root.join(BACKUPS_DIR);
    let has_database = database
        .metadata()
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false);
    if !has_database {
        prune_backups(&backups)?;
        return Ok(None);
    }
    // Diagnose a corrupt or unreadable database before anything opens it read-write.
    verify_live_database(&database)?;
    let (revision, fingerprint) = {
        let connection = open_read_only(&database)?;
        let revision = schema_revision(&connection)?;
        let fingerprint = schema_fingerprint(&connection)?;
        (revision, fingerprint)
    };
    let marker = read_schema_state(&backups);
    let needed = revision < CURRENT_SCHEMA_MIGRATION
        || marker
            .as_ref()
            .map_or(true, |state| state.fingerprint != fingerprint);
    let mut snapshot = None;
    if needed {
        fs::create_dir_all(&backups).map_err(|error| {
            format!(
                "Could not create the backups directory at {}: {error}",
                backups.display()
            )
        })?;
        let prefix = format!("{SNAPSHOT_PREFIX}{revision}-{fingerprint}-");
        // A crash mid-migration can leave a snapshot for this exact schema state already.
        if !has_snapshot_with_prefix(&backups, &prefix)? {
            snapshot = Some(write_snapshot(&database, &backups, &prefix)?);
        }
    }
    prune_backups(&backups)?;
    Ok(snapshot)
}

/// Record the schema revision and fingerprint this build just initialized.
pub(crate) fn record_schema_state(root: &Path) -> Result<(), String> {
    let database = root.join(DATABASE_FILE);
    let backups = root.join(BACKUPS_DIR);
    fs::create_dir_all(&backups).map_err(|error| {
        format!(
            "Could not create the backups directory at {}: {error}",
            backups.display()
        )
    })?;
    let (revision, fingerprint) = {
        let connection = open_read_only(&database)?;
        (schema_revision(&connection)?, schema_fingerprint(&connection)?)
    };
    let snapshot = snapshot_files(&backups)?.first().and_then(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string)
    });
    let state = SchemaState {
        schema_revision: revision,
        fingerprint,
        snapshot,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    let temporary = backups.join(format!("{TEMP_PREFIX}{}.json", Uuid::new_v4()));
    let text = serde_json::to_string_pretty(&state)
        .map_err(|error| format!("Could not serialize the schema state: {error}"))?;
    fs::write(&temporary, text).map_err(|error| {
        format!(
            "Could not write the schema state at {}: {error}",
            temporary.display()
        )
    })?;
    fs::rename(&temporary, backups.join(STATE_MARKER)).map_err(|error| {
        format!(
            "Could not record the schema state in {}: {error}",
            backups.display()
        )
    })
}

/// Newest snapshot that still passes full verification; bad copies are skipped.
pub(crate) fn newest_verified_snapshot() -> Result<Option<PathBuf>, String> {
    newest_verified_snapshot_in(&app_data_dir()?)
}

fn newest_verified_snapshot_in(root: &Path) -> Result<Option<PathBuf>, String> {
    for snapshot in snapshot_files(&root.join(BACKUPS_DIR))? {
        if verify_database(&snapshot).is_ok() {
            return Ok(Some(snapshot));
        }
    }
    Ok(None)
}

fn sidecar(database: &Path, suffix: &str) -> PathBuf {
    match database.file_name() {
        Some(name) => database.with_file_name(format!("{}{suffix}", name.to_string_lossy())),
        None => database.with_extension(format!("sqlite3{suffix}")),
    }
}

/// Replace the live database with a verified snapshot. Sidecars belong to the replaced
/// database and are removed so the restored file is not mixed with a stale WAL.
pub(crate) fn restore_snapshot(snapshot: &Path) -> Result<(), String> {
    restore_snapshot_in(&app_data_dir()?, snapshot)
}

fn restore_snapshot_in(root: &Path, snapshot: &Path) -> Result<(), String> {
    verify_database(snapshot)?;
    let database = root.join(DATABASE_FILE);
    let staging = root.join(format!("{TEMP_PREFIX}restore-{}{SNAPSHOT_SUFFIX}", Uuid::new_v4()));
    let result = (|| {
        fs::copy(snapshot, &staging).map_err(|error| {
            format!(
                "Could not stage the snapshot {}: {error}",
                snapshot.display()
            )
        })?;
        verify_database(&staging)?;
        for suffix in ["-wal", "-shm", "-journal"] {
            let path = sidecar(&database, suffix);
            if let Err(error) = fs::remove_file(&path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!("Could not remove {}: {error}", path.display()));
                }
            }
        }
        fs::rename(&staging, &database).map_err(|error| {
            format!(
                "Could not replace {} with the snapshot: {error}",
                database.display()
            )
        })?;
        let marker = root.join(BACKUPS_DIR).join(STATE_MARKER);
        if let Err(error) = fs::remove_file(&marker) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("Could not reset {}: {error}", marker.display()));
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

fn describe_age(modified: SystemTime) -> String {
    let Ok(age) = SystemTime::now().duration_since(modified) else {
        return "an unknown time ago".to_string();
    };
    let minutes = age.as_secs() / 60;
    if minutes < 1 {
        "just now".to_string()
    } else if minutes < 60 {
        format!("{minutes} minute(s) ago")
    } else if minutes < 60 * 24 {
        format!("{} hour(s) ago", minutes / 60)
    } else {
        format!("{} day(s) ago", minutes / (60 * 24))
    }
}

fn reveal_backups(backups: &Path) {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    if let Err(error) = Command::new(opener).arg(backups).status() {
        eprintln!("Could not reveal the backups folder: {error}");
    }
}

/// Native startup recovery prompt. Blocks the calling thread, so it must run on a worker
/// thread, never on the main thread.
pub(crate) fn run_recovery_dialog(app: &AppHandle, error: &str) -> RecoveryAction {
    let backups = app_data_dir()
        .map(|root| root.join(BACKUPS_DIR))
        .unwrap_or_else(|_| PathBuf::from(BACKUPS_DIR));
    let snapshot = newest_verified_snapshot().ok().flatten();
    match snapshot {
        Some(snapshot) => {
            let name = snapshot
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| snapshot.display().to_string());
            let age = snapshot
                .metadata()
                .and_then(|metadata| metadata.modified())
                .map(describe_age)
                .unwrap_or_else(|_| "an unknown time ago".to_string());
            let message = format!(
                "Stacks could not open its database.\n\n{error}\n\n\
                 Last verified snapshot: {name} ({age}).\n\n\
                 Restoring replaces {DATABASE_FILE} and its -wal, -shm, and -journal files. \
                 Card directories, setup results, releases, and worktrees are not restored.\n\n\
                 Backups: {}",
                backups.display()
            );
            let restore = app
                .dialog()
                .message(message)
                .title("Stacks could not start")
                .kind(MessageDialogKind::Error)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Restore last verified snapshot".to_string(),
                    "Quit".to_string(),
                ))
                .blocking_show();
            if restore {
                RecoveryAction::Restore(snapshot)
            } else {
                RecoveryAction::Quit
            }
        }
        None => {
            let message = format!(
                "Stacks could not open its database.\n\n{error}\n\n\
                 No verified snapshot was found in {}, so restoring is not possible.\n\n\
                 Restoring a snapshot only replaces {DATABASE_FILE} and its -wal, -shm, and -journal files.",
                backups.display()
            );
            let quit = app
                .dialog()
                .message(message)
                .title("Stacks could not start")
                .kind(MessageDialogKind::Error)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Quit".to_string(),
                    "Show backups folder".to_string(),
                ))
                .blocking_show();
            if !quit {
                reveal_backups(&backups);
            }
            RecoveryAction::Quit
        }
    }
}

/// Final, non-recoverable startup failure. Also runs off the main thread.
pub(crate) fn show_fatal_error(app: &AppHandle, error: &str) {
    app.dialog()
        .message(format!("Stacks could not start.\n\n{error}"))
        .title("Stacks could not start")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::Ok)
        .blocking_show();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kanban::{
        initialize_connection, initialize_database_in, initialize_once, migrate, DatabaseState,
        CURRENT_SCHEMA_MIGRATION,
    };
    use std::sync::{atomic::{AtomicUsize, Ordering}, Mutex};

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("stacks-backup-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn initialized_database(root: &Path) -> PathBuf {
        let path = root.join(DATABASE_FILE);
        let mut connection = Connection::open(&path).unwrap();
        migrate(&connection).unwrap();
        initialize_connection(&mut connection).unwrap();
        drop(connection);
        path
    }

    fn backup_names(root: &Path) -> Vec<String> {
        let mut names = fs::read_dir(root.join(BACKUPS_DIR))
            .map(|entries| {
                entries
                    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn current_schema_writes_no_snapshot_and_stale_schema_writes_exactly_one() {
        // An ordinary relaunch at the current revision does no copy work.
        let current = temp_root();
        initialized_database(&current);
        record_schema_state(&current).unwrap();
        assert_eq!(ensure_pre_migration_snapshot(&current).unwrap(), None);
        assert!(snapshot_files(&current.join(BACKUPS_DIR)).unwrap().is_empty());
        assert_eq!(ensure_pre_migration_snapshot(&current).unwrap(), None);
        assert!(snapshot_files(&current.join(BACKUPS_DIR)).unwrap().is_empty());

        // A stale revision snapshots once and never twice for the same schema state.
        let stale = temp_root();
        let database = initialized_database(&stale);
        {
            let connection = Connection::open(&database).unwrap();
            connection
                .execute("DELETE FROM schema_migrations WHERE version > 70", [])
                .unwrap();
        }
        let snapshot = ensure_pre_migration_snapshot(&stale).unwrap().unwrap();
        let name = snapshot.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("workflow-70-"), "{name}");
        verify_database(&snapshot).unwrap();
        assert_eq!(ensure_pre_migration_snapshot(&stale).unwrap(), None);
        assert_eq!(backup_names(&stale).len(), 1);

        // A newer, corrupt copy is skipped in favour of the verified one.
        let corrupt = stale
            .join(BACKUPS_DIR)
            .join(format!("workflow-70-ffffffffffffffff-{}.sqlite3", unix_timestamp() + 5));
        fs::write(&corrupt, b"SQLite format 3\0not really").unwrap();
        assert_eq!(
            newest_verified_snapshot_in(&stale).unwrap().as_deref(),
            Some(snapshot.as_path())
        );
    }

    #[test]
    fn corrupt_source_leaves_no_snapshot_temp_file() {
        let root = temp_root();
        let backups = root.join(BACKUPS_DIR);
        fs::create_dir_all(&backups).unwrap();
        let source = root.join("corrupt.sqlite3");
        fs::write(&source, b"SQLite format 3\0this is not a database").unwrap();
        assert!(write_snapshot(&source, &backups, "workflow-1-deadbeefdeadbeef-").is_err());
        assert!(fs::read_dir(&backups).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(TEMP_PREFIX)
        }));

        // A database path that cannot be read at all also routes to recovery instead of a copy.
        fs::write(root.join(DATABASE_FILE), b"still not a database").unwrap();
        assert!(ensure_pre_migration_snapshot(&root).is_err());
    }

    #[test]
    fn retention_keeps_the_five_newest_snapshots_and_removes_temps() {
        let root = temp_root();
        let backups = root.join(BACKUPS_DIR);
        fs::create_dir_all(&backups).unwrap();
        fs::write(backups.join(format!("{TEMP_PREFIX}leftover.sqlite3")), b"x").unwrap();
        let mut created = Vec::new();
        for index in 0..7 {
            let path = backups.join(format!("workflow-70-abc{index}-{index}.sqlite3"));
            fs::write(&path, b"x").unwrap();
            std::thread::sleep(Duration::from_millis(20));
            created.push(path);
        }
        prune_backups(&backups).unwrap();
        let names = backup_names(&root);
        assert_eq!(names.len(), SNAPSHOT_RETENTION);
        assert!(names.iter().all(|name| !name.starts_with(TEMP_PREFIX)));
        for stale in &created[..2] {
            assert!(!stale.exists(), "{} should have been pruned", stale.display());
        }
        assert!(created[6].exists());
    }

    #[test]
    fn restore_replaces_a_corrupt_database_and_allows_retry() {
        let root = temp_root();
        let database = initialized_database(&root);
        record_schema_state(&root).unwrap();
        let backups = root.join(BACKUPS_DIR);
        let snapshot = backups.join(format!(
            "workflow-{CURRENT_SCHEMA_MIGRATION}-0000000000000000-{}.sqlite3",
            unix_timestamp()
        ));
        online_backup(&database, &snapshot).unwrap();
        verify_database(&snapshot).unwrap();

        fs::write(&database, b"SQLite format 3\0corrupted").unwrap();
        for suffix in ["-wal", "-shm", "-journal"] {
            fs::write(sidecar(&database, suffix), b"stale").unwrap();
        }

        let calls = AtomicUsize::new(0);
        let state = Mutex::new(DatabaseState::Uninitialized);
        let first = initialize_once(&state, || {
            calls.fetch_add(1, Ordering::Relaxed);
            initialize_database_in(&root)
        })
        .unwrap_err();
        assert_eq!(
            initialize_once(&state, || {
                calls.fetch_add(1, Ordering::Relaxed);
                initialize_database_in(&root)
            })
            .unwrap_err(),
            first
        );
        assert_eq!(calls.load(Ordering::Relaxed), 1);

        restore_snapshot_in(&root, &snapshot).unwrap();
        for suffix in ["-wal", "-shm", "-journal"] {
            assert!(!sidecar(&database, suffix).exists());
        }
        verify_database(&database).unwrap();
        assert!(!backups.join(STATE_MARKER).exists());

        // Blocked initialization is still not retried implicitly, even once the file is healthy.
        assert_eq!(
            initialize_once(&state, || {
                calls.fetch_add(1, Ordering::Relaxed);
                initialize_database_in(&root)
            })
            .unwrap_err(),
            first
        );
        assert_eq!(calls.load(Ordering::Relaxed), 1);

        *state.lock().unwrap() = DatabaseState::Uninitialized;
        initialize_once(&state, || {
            calls.fetch_add(1, Ordering::Relaxed);
            initialize_database_in(&root)
        })
        .unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        assert!(backups.join(STATE_MARKER).exists());
    }
}
