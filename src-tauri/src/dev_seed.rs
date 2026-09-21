use crate::{
    fs_paths::{app_data_dir_for, AppProfile},
    settings_model::AppSettings,
};
use rusqlite::{backup::Backup, Connection, OpenFlags};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Write},
    path::Path,
    time::Duration,
};
use uuid::Uuid;

const DATABASE_FILE: &str = "workflow.sqlite3";
const SETTINGS_FILE: &str = "settings.json";
const SEEDED_MARKER_FILE: &str = "seeded-from-production";
const MAX_SUPPORTED_SCHEMA_MIGRATION: i64 = 77;

const EXPECTED_TABLES: &[&str] = &[
    "card_cleanup_evidence",
    "card_cleanup_operations",
    "card_cleanup_phase_outcomes",
    "card_environments",
    "card_events",
    "card_layouts",
    "card_panes",
    "card_pi_lifecycle",
    "card_pi_lifecycle_events",
    "card_pull_requests",
    "card_service_definitions",
    "card_target_merge_operations",
    "environment_creation_operations",
    "global_terminal_state",
    "kanban_board_metadata",
    "kanban_cards",
    "kanban_project_sequences",
    "legacy_workspaces",
    "project_direct_panes",
    "project_direct_work",
    "projects",
    "provider_sync_attempts",
    "provider_sync_operations",
    "release_attempts",
    "release_operations",
    "schema_migrations",
    "scripted_delivery_operations",
    "superthread_bindings",
];

/// Seed the isolated development profile from production. This function never opens the
/// production database for writing and only replaces the destination after full validation.
pub fn seed_development_data(production: &Path, development: &Path) -> Result<(), String> {
    refuse_running_development_instance(development)?;
    let source_database = production.join(DATABASE_FILE);
    if !source_database.is_file() {
        return Err(format!(
            "Production database was not found at {}",
            source_database.display()
        ));
    }
    let parent = development
        .parent()
        .ok_or_else(|| "Development data directory has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(io_error("Could not create the app-data parent"))?;
    let staged = parent.join(format!(".stacks-tauri-dev-seed-{}", Uuid::new_v4()));
    fs::create_dir(&staged).map_err(io_error("Could not create the seed staging directory"))?;

    let result = (|| {
        let staged_database = staged.join(DATABASE_FILE);
        online_backup(&source_database, &staged_database)?;
        sanitize_database(&staged_database)?;
        copy_sanitized_settings(&production.join(SETTINGS_FILE), &staged.join(SETTINGS_FILE))?;
        fs::write(
            staged.join(SEEDED_MARKER_FILE),
            "Production records were copied without sessions, runtime state, operations, or worktree ownership.\n",
        ).map_err(io_error("Could not write the seeded-profile marker"))?;
        validate_staged_seed(&staged_database, &staged)?;
        atomic_replace_directory(&staged, development)
    })();

    if staged.exists() {
        let _ = fs::remove_dir_all(&staged);
    }
    result
}

#[tauri::command]
pub fn startup_card_recovery_allowed() -> bool {
    app_data_dir_for(crate::fs_paths::current_app_profile())
        .map(|path| startup_card_recovery_allowed_in(&path))
        .unwrap_or(true)
}

fn startup_card_recovery_allowed_in(app_data: &Path) -> bool {
    !app_data.join(SEEDED_MARKER_FILE).exists()
}

fn online_backup(source_path: &Path, destination_path: &Path) -> Result<(), String> {
    let source = Connection::open_with_flags(
        source_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(db_error("Could not open the production database read-only"))?;
    let mut destination = Connection::open(destination_path)
        .map_err(db_error("Could not create the staged database"))?;
    let backup = Backup::new(&source, &mut destination)
        .map_err(db_error("Could not start the SQLite online backup"))?;
    backup
        .run_to_completion(128, Duration::from_millis(10), None)
        .map_err(db_error("Could not complete the SQLite online backup"))
}

fn sanitize_database(path: &Path) -> Result<(), String> {
    let mut connection =
        Connection::open(path).map_err(db_error("Could not open the staged database"))?;
    validate_schema(&connection)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(db_error("Could not enable staged foreign keys"))?;
    let transaction = connection
        .transaction()
        .map_err(db_error("Could not begin seed sanitization"))?;
    transaction
        .execute_batch(
            "DELETE FROM card_cleanup_evidence;
         DELETE FROM card_cleanup_phase_outcomes;
         DELETE FROM card_cleanup_operations;
         DELETE FROM provider_sync_attempts;
         DELETE FROM provider_sync_operations;
         DELETE FROM release_attempts;
         DELETE FROM release_operations;
         DELETE FROM card_pi_lifecycle_events;
         DELETE FROM card_pi_lifecycle;
         DELETE FROM card_target_merge_operations;
         DELETE FROM scripted_delivery_operations;
         DELETE FROM environment_creation_operations;
         DELETE FROM card_service_definitions;
         DELETE FROM card_panes;
         DELETE FROM card_layouts;
         DELETE FROM card_environments;
         DELETE FROM global_terminal_state;
         UPDATE kanban_cards SET
           workspace_id=NULL,
           delivery_operation_stage=NULL,
           delivery_error=NULL,
           runtime_cleanup_status=NULL,
           runtime_cleanup_error=NULL;",
        )
        .map_err(db_error("Could not sanitize runtime and operation data"))?;
    transaction
        .commit()
        .map_err(db_error("Could not commit seed sanitization"))?;
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; VACUUM;")
        .map_err(db_error("Could not compact the staged database"))?;
    Ok(())
}

fn validate_schema(connection: &Connection) -> Result<(), String> {
    let migration: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(db_error("Could not read the production schema version"))?;
    if migration > MAX_SUPPORTED_SCHEMA_MIGRATION {
        return Err(format!(
            "Production schema migration {migration} is newer than the seeder supports ({MAX_SUPPORTED_SCHEMA_MIGRATION}); update the seed policy first"
        ));
    }
    let actual = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).map_err(db_error("Could not inspect the production schema"))?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_error("Could not list production tables"))?
        .collect::<Result<BTreeSet<_>, _>>()
        .map_err(db_error("Could not read production table names"))?;
    let expected = EXPECTED_TABLES
        .iter()
        .map(|name| (*name).to_string())
        .collect::<BTreeSet<_>>();
    if actual != expected {
        let missing = expected.difference(&actual).cloned().collect::<Vec<_>>();
        let unknown = actual.difference(&expected).cloned().collect::<Vec<_>>();
        return Err(format!("Production schema is incompatible with this seeder (missing: {missing:?}; unknown: {unknown:?})"));
    }
    Ok(())
}

fn copy_sanitized_settings(source: &Path, destination: &Path) -> Result<(), String> {
    let settings = if source.is_file() {
        let text =
            fs::read_to_string(source).map_err(io_error("Could not read production settings"))?;
        serde_json::from_str::<AppSettings>(&text)
            .map_err(|error| format!("Could not parse production settings: {error}"))?
    } else {
        AppSettings::default()
    };
    let text = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("Could not sanitize production settings: {error}"))?;
    fs::write(destination, text).map_err(io_error("Could not write staged settings"))
}

fn validate_staged_seed(database: &Path, directory: &Path) -> Result<(), String> {
    let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(db_error("Could not reopen the staged database"))?;
    validate_schema(&connection)?;
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(db_error("Could not validate staged database integrity"))?;
    if integrity != "ok" {
        return Err(format!(
            "Staged database failed integrity_check: {integrity}"
        ));
    }
    let foreign_key_violations: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .map_err(db_error("Could not validate staged foreign keys"))?;
    if foreign_key_violations != 0 {
        return Err(format!(
            "Staged database has {foreign_key_violations} foreign-key violation(s)"
        ));
    }
    for table in [
        "card_cleanup_evidence",
        "card_cleanup_operations",
        "card_cleanup_phase_outcomes",
        "card_environments",
        "card_layouts",
        "card_panes",
        "card_pi_lifecycle",
        "card_pi_lifecycle_events",
        "card_service_definitions",
        "card_target_merge_operations",
        "environment_creation_operations",
        "global_terminal_state",
        "provider_sync_attempts",
        "provider_sync_operations",
        "release_attempts",
        "release_operations",
        "scripted_delivery_operations",
    ] {
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .map_err(db_error("Could not validate excluded seed data"))?;
        if count != 0 {
            return Err(format!(
                "Staged database still contains excluded rows in {table}"
            ));
        }
    }
    let unsafe_cards: i64 = connection.query_row(
        "SELECT COUNT(*) FROM kanban_cards WHERE workspace_id IS NOT NULL OR delivery_operation_stage IS NOT NULL OR delivery_error IS NOT NULL OR runtime_cleanup_status IS NOT NULL OR runtime_cleanup_error IS NOT NULL",
        [], |row| row.get(0),
    ).map_err(db_error("Could not validate sanitized card state"))?;
    if unsafe_cards != 0 {
        return Err("Staged database still contains active card operation state".into());
    }
    let allowed_files = [DATABASE_FILE, SETTINGS_FILE, SEEDED_MARKER_FILE]
        .into_iter()
        .collect::<BTreeSet<_>>();
    for entry in fs::read_dir(directory).map_err(io_error("Could not inspect the staged seed"))? {
        let entry = entry.map_err(io_error("Could not inspect a staged seed entry"))?;
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| "Staged seed contains a non-UTF-8 file name".to_string())?;
        if !allowed_files.contains(name) {
            return Err(format!("Staged seed contains unapproved file: {name}"));
        }
    }
    Ok(())
}

fn refuse_running_development_instance(development: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::net::UnixStream;
        let socket = development.join("automation.sock");
        if socket.exists() && UnixStream::connect(&socket).is_ok() {
            return Err("The development Stacks app is running. Quit it before seeding.".into());
        }
    }
    Ok(())
}

fn atomic_replace_directory(staged: &Path, destination: &Path) -> Result<(), String> {
    if !destination.exists() {
        return fs::rename(staged, destination)
            .map_err(io_error("Could not install the staged development data"));
    }
    atomic_exchange(staged, destination)?;
    // The exchange is the commit point. A cleanup problem must not turn a
    // completed atomic replacement into a reported seed failure.
    let _ = fs::remove_dir_all(staged);
    Ok(())
}

#[cfg(target_os = "macos")]
fn atomic_exchange(left: &Path, right: &Path) -> Result<(), String> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    const RENAME_SWAP: u32 = 0x0000_0002;
    extern "C" {
        fn renameatx_np(
            fromfd: i32,
            from: *const libc::c_char,
            tofd: i32,
            to: *const libc::c_char,
            flags: u32,
        ) -> i32;
    }
    let left = CString::new(left.as_os_str().as_bytes())
        .map_err(|_| "Seed staging path contains a NUL byte".to_string())?;
    let right = CString::new(right.as_os_str().as_bytes())
        .map_err(|_| "Development data path contains a NUL byte".to_string())?;
    let result = unsafe {
        renameatx_np(
            libc::AT_FDCWD,
            left.as_ptr(),
            libc::AT_FDCWD,
            right.as_ptr(),
            RENAME_SWAP,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "Could not atomically replace development data: {}",
            io::Error::last_os_error()
        ))
    }
}

#[cfg(target_os = "linux")]
fn atomic_exchange(left: &Path, right: &Path) -> Result<(), String> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let left = CString::new(left.as_os_str().as_bytes())
        .map_err(|_| "Seed staging path contains a NUL byte".to_string())?;
    let right = CString::new(right.as_os_str().as_bytes())
        .map_err(|_| "Development data path contains a NUL byte".to_string())?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            left.as_ptr(),
            libc::AT_FDCWD,
            right.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "Could not atomically replace development data: {}",
            io::Error::last_os_error()
        ))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn atomic_exchange(_left: &Path, _right: &Path) -> Result<(), String> {
    Err("Atomic development-data replacement is not supported on this platform".into())
}

pub fn run_cli() -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("The development-data seeder must be built in debug mode".into());
    }
    let production = app_data_dir_for(AppProfile::Production)?;
    let development = app_data_dir_for(AppProfile::Development)?;
    println!("This will replace ALL isolated development data at:\n  {}\n\nfrom a read-only, sanitized snapshot of production at:\n  {}\n\nProduction data will not be modified. Pi transcripts, sessions, runtime operations, process state, and worktree ownership will not be copied.", development.display(), production.display());
    print!("Type 'seed dev' to continue: ");
    io::stdout().flush().map_err(|error| error.to_string())?;
    let mut confirmation = String::new();
    io::stdin()
        .read_line(&mut confirmation)
        .map_err(|error| error.to_string())?;
    if confirmation.trim() != "seed dev" {
        return Err("Seed cancelled; development data was not changed".into());
    }
    seed_development_data(&production, &development)?;
    println!("Development data seeded successfully. Automatic recovery is disabled for this seeded profile.");
    Ok(())
}

fn db_error(context: &'static str) -> impl FnOnce(rusqlite::Error) -> String {
    move |error| format!("{context}: {error}")
}
fn io_error(context: &'static str) -> impl FnOnce(io::Error) -> String {
    move |error| format!("{context}: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("stacks-seed-test-{}", Uuid::new_v4()))
    }

    fn production_fixture(directory: &Path) -> Connection {
        fs::create_dir_all(directory).unwrap();
        let mut connection = Connection::open(directory.join(DATABASE_FILE)).unwrap();
        crate::kanban::initialize_connection(&mut connection, false).unwrap();
        connection
            .execute(
                "INSERT INTO projects(id,name,path) VALUES ('p','Project','/prod/repo')",
                [],
            )
            .unwrap();
        connection.execute("INSERT INTO kanban_cards(id,external_provider,external_id,title,status,project_id,parent_id,created_at,updated_at,sort_order,delivery_operation_stage,runtime_cleanup_status) VALUES ('parent','local','1','Parent','refining','p',NULL,1,2,4,'deploying','pending'),('child','local','2','Child','agent_working','p','parent',2,3,5,NULL,NULL)", []).unwrap();
        connection.execute("INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,summary) VALUES ('parent',2,'user','transition','success','history')", []).unwrap();
        connection.execute("INSERT INTO card_pi_lifecycle(card_id,thread,generation) VALUES ('parent','planning','prod-generation')", []).unwrap();
        connection.execute("INSERT INTO card_environments(id,card_id,project_id,worktree_path,created_at,updated_at) VALUES ('e','child','p','/prod/worktree',1,1)", []).unwrap();
        connection.execute("INSERT INTO release_operations(id,project_id,repository_identity,status,revision,state_json,created_at,updated_at) VALUES ('r','p','repo','running',1,'{}',1,1)", []).unwrap();
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        connection
            .execute(
                "INSERT INTO kanban_project_sequences(project_id,next_number) VALUES ('p',9)",
                [],
            )
            .unwrap();
        fs::write(
            directory.join(SETTINGS_FILE),
            r#"{"ui_font_size":15,"kanban_project_id":"p","unknown_startup_state":"unsafe"}"#,
        )
        .unwrap();
        connection
    }

    #[test]
    fn live_wal_seed_preserves_records_and_removes_runtime_control() {
        let root = temp_root();
        let production = root.join("production");
        let development = root.join("development");
        let live_production_connection = production_fixture(&production);
        fs::create_dir_all(&development).unwrap();
        fs::write(development.join("old-data"), "replace me").unwrap();
        seed_development_data(&production, &development).unwrap();
        let connection = Connection::open(development.join(DATABASE_FILE)).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM kanban_cards", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id FROM kanban_cards WHERE id='child'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "parent"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM kanban_cards WHERE id='parent'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "refining"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM card_events", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM card_environments", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM card_pi_lifecycle", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM release_operations", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let settings = fs::read_to_string(development.join(SETTINGS_FILE)).unwrap();
        assert!(settings.contains("\"ui_font_size\": 15"));
        assert!(!settings.contains("unknown_startup_state"));
        assert!(development.join(SEEDED_MARKER_FILE).exists());
        assert!(!startup_card_recovery_allowed_in(&development));
        assert!(!development.join("old-data").exists());
        drop(live_production_connection);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_seed_keeps_previous_development_data() {
        let root = temp_root();
        let production = root.join("production");
        let development = root.join("development");
        fs::create_dir_all(&production).unwrap();
        fs::create_dir_all(&development).unwrap();
        fs::write(production.join(DATABASE_FILE), "not sqlite").unwrap();
        fs::write(development.join("keep"), "previous").unwrap();
        assert!(seed_development_data(&production, &development).is_err());
        assert_eq!(
            fs::read_to_string(development.join("keep")).unwrap(),
            "previous"
        );
        let _ = fs::remove_dir_all(root);
    }
}
