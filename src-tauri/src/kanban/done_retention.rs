//! Manual, local-only retention. This module never invokes provider or Git effects.
use super::health::{db_error, unix_timestamp};
use super::*;
use super::{
    cards::{card_directory, safe_card_key},
    repository::*,
};

const RETENTION_SECONDS: i64 = 7 * 24 * 60 * 60;

// Serialize resource startup with the final runtime inventory and deletion.
// Lock order: resource startup -> board mutation -> runtime registries.
pub(crate) static CARD_RESOURCE_START_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoneCleanupCandidate {
    pub id: String,
    pub done_entered_at: i64,
}
#[derive(Debug, Serialize)]
pub struct DoneCleanupPreview {
    pub candidates: Vec<DoneCleanupCandidate>,
    pub pending_artifacts: usize,
}
#[derive(Debug, Serialize, Default)]
pub struct DoneCleanupResult {
    pub deleted: usize,
    pub removed_ids: Vec<String>,
    pub skipped: usize,
    pub failed: usize,
    pub details: Vec<String>,
}

pub(super) fn preview(connection: &Connection, now: i64) -> Result<DoneCleanupPreview, String> {
    let candidates = connection
        .prepare(
            "SELECT id,done_entered_at FROM kanban_cards
        WHERE status='done' AND done_entered_at < ?1 ORDER BY id",
        )
        .map_err(db_error)?
        .query_map([now - RETENTION_SECONDS], |row| {
            Ok(DoneCleanupCandidate {
                id: row.get(0)?,
                done_entered_at: row.get(1)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let pending_artifacts = connection
        .query_row("SELECT COUNT(*) FROM local_card_purge_jobs", [], |row| {
            row.get(0)
        })
        .map_err(db_error)?;
    Ok(DoneCleanupPreview {
        candidates,
        pending_artifacts,
    })
}

fn safety(connection: &Connection, id: &str) -> Result<(), String> {
    if connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM kanban_cards WHERE parent_id=?1)",
            [id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(db_error)?
    {
        return Err("retained or not-yet-deleted children".into());
    }
    lifecycle_safety(connection, id)
}

fn lifecycle_safety(connection: &Connection, id: &str) -> Result<(), String> {
    let checks = [
        ("SELECT EXISTS(SELECT 1 FROM card_environments WHERE card_id=?1)", "card environment still owns worktree/branch resources"),
        ("SELECT EXISTS(SELECT 1 FROM environment_creation_operations WHERE card_id=?1)", "unresolved environment creation"),
        ("SELECT EXISTS(SELECT 1 FROM card_target_merge_operations WHERE card_id=?1 AND phase!='source_merged')", "unresolved target merge"),
        ("SELECT EXISTS(SELECT 1 FROM provider_sync_operations WHERE card_id=?1 AND state NOT IN ('succeeded','stale','superseded'))", "unresolved provider operation"),
        ("SELECT EXISTS(SELECT 1 FROM card_cleanup_operations WHERE card_id=?1 AND status!='completed')", "incomplete resource cleanup"),
        ("SELECT EXISTS(SELECT 1 FROM scripted_delivery_operations WHERE card_id=?1 AND stage!='deployed')", "unresolved scripted delivery"),
        ("SELECT EXISTS(SELECT 1 FROM kanban_cards WHERE id=?1 AND (runtime_cleanup_status IN ('pending','failed') OR delivery_error IS NOT NULL OR delivery_operation_stage IS NOT NULL OR workspace_id IS NOT NULL))", "incomplete runtime/delivery cleanup"),
        ("SELECT EXISTS(SELECT 1 FROM card_pull_requests WHERE card_id=?1 AND state='open')", "open pull request"),
    ];
    for (sql, reason) in checks {
        if connection
            .query_row(sql, [id], |row| row.get::<_, bool>(0))
            .map_err(db_error)?
        {
            return Err(reason.into());
        }
    }
    // Card directory keys predate retention and are lossy. Never delete shared storage.
    let key = safe_card_key(id);
    let ids = connection
        .prepare("SELECT id FROM kanban_cards WHERE id!=?1")
        .map_err(db_error)?
        .query_map([id], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    if ids.iter().any(|other| safe_card_key(other) == key) {
        return Err("card storage key is shared with another card".into());
    }
    Ok(())
}

fn staged_directory(id: &str) -> Result<PathBuf, String> {
    let directory = card_directory(id)?;
    Ok(directory.with_file_name(format!(".done-cleanup-{}", safe_card_key(id))))
}

fn validate_directory(path: &Path) -> Result<(), String> {
    // Reject symlinked containers, including the cards root. remove_dir_all does
    // not follow inner symlinks, but an ancestor symlink would escape ownership.
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "Refusing symlinked storage: {}",
                    ancestor.display()
                ))
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(format!("Not a storage directory: {}", ancestor.display()))
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(format!("Could not inspect {}: {error}", ancestor.display())),
        }
    }
    Ok(())
}

// Card storage is not a resource cleanup mechanism. Even an unregistered Git
// checkout nested inside it must be preserved for explicit human cleanup.
fn validate_owned_storage(path: &Path) -> Result<(), String> {
    validate_directory(path)?;
    if !path.exists() {
        return Ok(());
    }
    let mut pending = vec![path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("Could not inspect {}: {error}", directory.display()))?
        {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry.file_name() == ".git" {
                return Err(format!(
                    "Git checkout found in card storage; explicit resource cleanup required: {}",
                    entry.path().display()
                ));
            }
            // Never follow an inner symlink to a project or external storage.
            if entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                pending.push(entry.path());
            }
        }
    }
    Ok(())
}

// Database deletion and a durable artifact job commit together. Staging is a
// rename on the same filesystem, not destructive removal before DB commit.
// A crash before commit leaves the card and deterministic staging directory;
// retry finds it. A crash after commit leaves a purge job, retried only manually.
fn stage_and_delete(connection: &mut Connection, id: &str) -> Result<(), String> {
    let directory = card_directory(id)?;
    let staged = staged_directory(id)?;
    stage_and_delete_at(connection, id, &directory, &staged)
}

fn stage_and_delete_at(
    connection: &mut Connection,
    id: &str,
    directory: &Path,
    staged: &Path,
) -> Result<(), String> {
    validate_owned_storage(directory)?;
    validate_owned_storage(staged)?;
    if directory.exists() && staged.exists() {
        return Err(format!(
            "Both live and staged storage exist; inspect {}",
            staged.display()
        ));
    }
    let transaction = connection.savepoint().map_err(db_error)?;
    transaction
        .execute(
            "INSERT INTO local_card_purge_jobs(card_id,storage_key) VALUES (?1,?2)",
            params![id, safe_card_key(id)],
        )
        .map_err(db_error)?;
    transaction
        .execute("DELETE FROM kanban_cards WHERE id=?1", [id])
        .map_err(db_error)?;
    if directory.exists() {
        fs::rename(directory, staged)
            .map_err(|error| format!("Could not stage card files: {error}"))?;
    }
    transaction.commit().map_err(db_error)
}

pub(super) fn delete_candidates(
    connection: &mut Connection,
    candidates: &[DoneCleanupCandidate],
    now: i64,
    mut runtime_safe: impl FnMut(&str) -> Result<(), String>,
    mut remove: impl FnMut(&mut Connection, &str) -> Result<(), String>,
) -> Result<DoneCleanupResult, String> {
    let mut result = DoneCleanupResult::default();
    let mut remaining: BTreeMap<String, i64> = candidates
        .iter()
        .map(|candidate| (candidate.id.clone(), candidate.done_entered_at))
        .collect();
    // Treat a linked hierarchy as a retention unit. A retained parent must not
    // lose child history, nor may a retained child lose its parent. Propagate
    // safety blockers before touching any member of the group.
    let mut blocked = BTreeMap::new();
    for (id, entered) in &remaining {
        let eligible: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM kanban_cards WHERE id=?1 AND status='done' AND done_entered_at=?2 AND done_entered_at<?3)", params![id,entered,now-RETENTION_SECONDS], |row| row.get(0)).map_err(db_error)?;
        if !eligible {
            blocked.insert(id.clone(), "no longer eligible".to_string());
            continue;
        }
        // Children are validated as a group below; all other lifecycle checks
        // must pass for every member before deleting the first leaf.
        if let Err(error) = lifecycle_safety(connection, id).and_then(|()| runtime_safe(id)) {
            blocked.insert(id.clone(), error);
        }
    }
    let links = connection
        .prepare("SELECT id,parent_id FROM kanban_cards WHERE parent_id IS NOT NULL")
        .map_err(db_error)?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    loop {
        let before = blocked.len();
        for (child, parent) in &links {
            if remaining.contains_key(child)
                && (!remaining.contains_key(parent) || blocked.contains_key(parent))
            {
                blocked
                    .entry(child.clone())
                    .or_insert_with(|| "retained or unsafe parent".into());
            }
            if remaining.contains_key(parent)
                && (!remaining.contains_key(child) || blocked.contains_key(child))
            {
                blocked
                    .entry(parent.clone())
                    .or_insert_with(|| "retained or unsafe child".into());
            }
        }
        if before == blocked.len() {
            break;
        }
    }
    for (id, reason) in blocked {
        remaining.remove(&id);
        result.skipped += 1;
        result.details.push(format!("{id}: skipped; {reason}"));
    }
    // One savepoint per connected hierarchy: even a filesystem/database failure
    // must not leave a retained parent missing some of its children.
    while let Some(first) = remaining.keys().next().cloned() {
        let mut group = HashSet::from([first]);
        loop {
            let before = group.len();
            for (child, parent) in &links {
                if group.contains(child) || group.contains(parent) {
                    if remaining.contains_key(child) {
                        group.insert(child.clone());
                    }
                    if remaining.contains_key(parent) {
                        group.insert(parent.clone());
                    }
                }
            }
            if before == group.len() {
                break;
            }
        }
        let mut pending = group.clone();
        let mut order = Vec::new();
        while !pending.is_empty() {
            let leaves: Vec<_> = pending
                .iter()
                .filter(|id| {
                    !links
                        .iter()
                        .any(|(child, parent)| parent == *id && pending.contains(child))
                })
                .cloned()
                .collect();
            if leaves.is_empty() {
                break;
            }
            for leaf in leaves {
                pending.remove(&leaf);
                order.push(leaf);
            }
        }
        for id in &group {
            remaining.remove(id);
        }
        if !pending.is_empty() {
            result.skipped += group.len();
            result.details.extend(
                group
                    .iter()
                    .map(|id| format!("{id}: skipped; cyclic hierarchy")),
            );
            continue;
        }
        connection
            .execute_batch("SAVEPOINT done_cleanup_group")
            .map_err(db_error)?;
        let operation = (|| {
            for id in &order {
                safety(connection, id)?;
                runtime_safe(id)?;
                remove(connection, id).map_err(|error| format!("{id}: {error}"))?;
            }
            Ok::<(), String>(())
        })();
        match operation {
            Ok(()) => {
                connection
                    .execute_batch("RELEASE done_cleanup_group")
                    .map_err(db_error)?;
                result.deleted += group.len();
                result.removed_ids.extend(group.iter().cloned());
            }
            Err(error) => {
                connection
                    .execute_batch("ROLLBACK TO done_cleanup_group; RELEASE done_cleanup_group")
                    .map_err(db_error)?;
                result.failed += group.len();
                result.details.extend(
                    group
                        .iter()
                        .map(|id| format!("{id}: failed; hierarchy retained: {error}")),
                );
            }
        }
    }
    Ok(result)
}

fn finish_purge(
    connection: &Connection,
    id: &str,
    staged: &Path,
    remove: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    validate_owned_storage(staged)?;
    if staged.exists() {
        remove(staged)?;
    }
    connection
        .execute("DELETE FROM local_card_purge_jobs WHERE card_id=?1", [id])
        .map(|_| ())
        .map_err(db_error)
}

fn restore_retained_storage(candidates: &[DoneCleanupCandidate]) -> Vec<String> {
    let mut failures = Vec::new();
    for candidate in candidates {
        let restore = (|| {
            let retained = with_read_connection(|connection| {
                connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM kanban_cards WHERE id=?1) AND NOT EXISTS(SELECT 1 FROM local_card_purge_jobs WHERE storage_key=?2)",
                params![candidate.id,safe_card_key(&candidate.id)], |row| row.get::<_, bool>(0)).map_err(db_error)
            })?;
            if retained {
                let directory = card_directory(&candidate.id)?;
                let staged = staged_directory(&candidate.id)?;
                validate_directory(&directory)?;
                validate_directory(&staged)?;
                if staged.exists() && !directory.exists() {
                    fs::rename(&staged, &directory).map_err(|error| {
                        format!(
                            "Restore {} failed; retry cleanup: {error}",
                            staged.display()
                        )
                    })?;
                }
            }
            Ok::<(), String>(())
        })();
        if let Err(error) = restore {
            failures.push(format!("{}: {error}", candidate.id));
        }
    }
    failures
}

#[cfg(test)]
#[path = "done_retention_tests.rs"]
mod tests;

pub(super) fn execute(
    candidates: Vec<DoneCleanupCandidate>,
    pi: &Mutex<PiRpcRegistry>,
    pty: &Mutex<PtyRegistry>,
) -> Result<DoneCleanupResult, String> {
    let _resources = CARD_RESOURCE_START_LOCK
        .lock()
        .map_err(|_| "Card resource lock failed".to_string())?;
    let result = with_board_mutation(|connection| {
        delete_candidates(
            connection,
            &candidates,
            unix_timestamp(),
            |id| {
                if !crate::pi_rpc::card_pi_runtime_ids(pi, id)?.is_empty()
                    || !crate::pty::card_pty_runtime_ids(pty, id)?.is_empty()
                {
                    return Err("active or starting card runtime".into());
                }
                validate_owned_storage(&card_directory(id)?)?;
                validate_owned_storage(&staged_directory(id)?)?;
                Ok(())
            },
            stage_and_delete,
        )
    });
    // On transaction failure the original records remain. Restore staged files
    // where possible; a failed restore remains discoverable on the next retry.
    let mut result = match result {
        Ok(result) => result,
        Err(error) => {
            let mut failures = vec![error];
            failures.extend(restore_retained_storage(&candidates));
            return Err(failures.join("; "));
        }
    };
    // Also restore staging from a rolled-back individual hierarchy.
    result.details.extend(restore_retained_storage(&candidates));
    let jobs = with_read_connection(|connection| {
        connection
            .prepare("SELECT card_id FROM local_card_purge_jobs")
            .map_err(db_error)?
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)
    })?;
    for id in jobs {
        let purge = (|| {
            let staged = staged_directory(&id)?;
            with_board_mutation(|connection| {
                finish_purge(connection, &id, &staged, |path| {
                    fs::remove_dir_all(path).map_err(|error| format!("{}: {error}", path.display()))
                })
            })
        })();
        if let Err(error) = purge {
            if result.removed_ids.contains(&id) && result.deleted > 0 {
                result.deleted -= 1;
            }
            result.failed += 1;
            result.details.push(format!(
                "{id}: local record removed, but file cleanup failed (retry this action): {error}"
            ));
        }
    }
    Ok(result)
}
