use super::*;
use super::{git_effects::*, health::*, repository::*};

pub(in crate::kanban) const CLEANUP_PHASES: [&str; 7] = [
    "runtime_sessions",
    "validate_repository",
    "remove_worktree",
    "delete_local_branch",
    "delete_remote_branch",
    "remove_metadata",
    "record_completion",
];

#[derive(Debug, Clone)]
pub(in crate::kanban) struct CleanupSnapshot {
    pub(in crate::kanban) card_id: String,
    pub(in crate::kanban) environment_id: String,
    pub(in crate::kanban) workflow_revision: i64,
    pub(in crate::kanban) environment_revision: i64,
    pub(in crate::kanban) status: String,
    pub(in crate::kanban) phase: String,
    pub(in crate::kanban) completion_outcome: String,
    pub(in crate::kanban) repository_id: String,
    pub(in crate::kanban) source_path: String,
    pub(in crate::kanban) target_path: String,
    pub(in crate::kanban) source_branch: String,
    pub(in crate::kanban) target_branch: String,
    pub(in crate::kanban) source_revision: String,
    pub(in crate::kanban) delete_local_branch: bool,
    pub(in crate::kanban) delete_remote_branch: bool,
    pub(in crate::kanban) merged_pr_head_revision: Option<String>,
    pub(in crate::kanban) pane_ids: Vec<(String, String)>,
    pub(in crate::kanban) registration_validated: bool,
}

pub(in crate::kanban) async fn kanban_cleanup_environment_operation(
    app: AppHandle,
    id: String,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pty_registry = app.state::<Mutex<PtyRegistry>>();
        let pi_registry = app.state::<Mutex<PiRpcRegistry>>();
        run_cleanup(
            &id,
            expected_workflow_revision,
            expected_environment_revision,
            pty_registry.inner(),
            pi_registry.inner(),
        )
    })
    .await
    .map_err(|error| format!("Cleanup worker failed: {error}"))?
}

pub(in crate::kanban) fn run_cleanup(
    id: &str,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
    pty_registry: &Mutex<PtyRegistry>,
    pi_registry: &Mutex<PiRpcRegistry>,
) -> Result<KanbanCard, String> {
    let _guard = REPOSITORY_OPERATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Repository operation lock failed".to_string())?;
    initialize_cleanup(
        id,
        expected_workflow_revision,
        expected_environment_revision,
    )?;
    loop {
        let operation = with_connection(|connection| load_cleanup_snapshot(connection, id))?;
        if operation.status == "completed" {
            return with_connection(|connection| {
                get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string())
            });
        }
        let phase = operation.phase.clone();
        if let Err(detail) = execute_cleanup_phase(&operation, pty_registry, pi_registry) {
            let code = cleanup_error_code(&phase, &detail);
            record_cleanup_failure(id, &phase, &code, &detail);
            return Err(detail);
        }
        if let Err(detail) = advance_cleanup_phase(&operation) {
            let code = cleanup_error_code(&phase, &detail);
            record_cleanup_failure(id, &phase, &code, &detail);
            return Err(detail);
        }
    }
}

pub(in crate::kanban) fn initialize_cleanup(
    card_id: &str,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
) -> Result<(), String> {
    with_connection(|connection| {
        if connection
            .query_row(
                "SELECT COUNT(*) FROM card_cleanup_operations WHERE card_id=?1",
                [card_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(db_error)?
            > 0
        {
            return Ok(());
        }
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let (status, outcome, workflow_revision, delivery_stage): (String, Option<String>, i64, Option<String>) = transaction.query_row(
            "SELECT status, completion_outcome, workflow_revision, delivery_operation_stage FROM kanban_cards WHERE id=?1", [card_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).map_err(db_error)?;
        if status != "done" {
            return Err("Only a Done card environment can be cleaned up".to_string());
        }
        if workflow_revision != expected_workflow_revision {
            return Err("Card changed; reload before cleanup".to_string());
        }
        let outcome =
            outcome.ok_or_else(|| "Done card has no recorded completion outcome".to_string())?;
        let ownership_valid: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM kanban_cards c JOIN card_environments e ON e.card_id=c.id JOIN projects p ON p.id=c.project_id WHERE c.id=?1 AND c.project_id=e.project_id",
            [card_id], |row| row.get(0),
        ).map_err(db_error)?;
        if ownership_valid != 1 {
            return Err("The card environment or project ownership is invalid".to_string());
        }
        let (environment_id, _project_id, source_path, source_branch, repository_id, target_path, target_branch, source_revision, target_revision, environment_revision): (String, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, i64) = transaction.query_row(
            "SELECT id, project_id, worktree_path, branch, repository_id, target_checkout_path, target_branch, source_revision, target_revision, revision FROM card_environments WHERE card_id=?1", [card_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?)),
        ).map_err(db_error)?;
        if environment_revision != expected_environment_revision {
            return Err("Card environment changed; reload before cleanup".to_string());
        }
        let repository_id = repository_id
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Cleanup requires a recorded repository identity".to_string())?;
        let target_path =
            target_path.ok_or_else(|| "Cleanup requires a recorded target checkout".to_string())?;
        let target_branch =
            target_branch.ok_or_else(|| "Cleanup requires a recorded target branch".to_string())?;
        let source_revision = source_revision
            .ok_or_else(|| "Cleanup requires a recorded source revision".to_string())?;
        let panes = {
            let mut statement = transaction
                .prepare("SELECT id, kind FROM card_panes WHERE environment_id=?1 ORDER BY id")
                .map_err(db_error)?;
            let rows = statement
                .query_map([&environment_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            rows
        };
        let pane_ids = serde_json::to_string(&panes).map_err(|error| error.to_string())?;
        let pr: Option<(String, i64, Option<String>)> = transaction.query_row(
            "SELECT repository, number, head_revision FROM card_pull_requests WHERE card_id=?1 AND state='merged'", [card_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(db_error)?;
        let (pr_repository, pr_number, pr_head) = pr
            .map(|value| (Some(value.0), Some(value.1), value.2))
            .unwrap_or_default();
        let now = unix_timestamp();
        transaction.execute(
            "INSERT INTO card_cleanup_operations (card_id,environment_id,workflow_revision,environment_revision,status,phase,completion_outcome,repository_id,source_path,target_path,source_branch,target_branch,source_revision,target_revision,delete_local_branch,delete_remote_branch,merged_pr_repository,merged_pr_number,merged_pr_head_revision,pane_ids,started_at,updated_at)
             VALUES (?1,?2,?3,?4,'pending','runtime_sessions',?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?19)",
            params![card_id, environment_id, workflow_revision, environment_revision, outcome, repository_id, source_path, target_path, source_branch, target_branch, source_revision, target_revision, (outcome == "merged") as i64, (delivery_stage.as_deref() == Some("deleting_remote_branch")) as i64, pr_repository, pr_number, pr_head, pane_ids, now],
        ).map_err(db_error)?;
        transaction.execute("UPDATE card_environments SET lifecycle_state='cleanup_pending', updated_at=?1 WHERE id=?2", params![now, environment_id]).map_err(db_error)?;
        transaction.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,summary) VALUES (?1,?2,'user','cleanup_started','success','Cleanup intent and safety snapshot recorded')", params![card_id, now]).map_err(db_error)?;
        transaction.commit().map_err(db_error)
    })
}

pub(in crate::kanban) fn load_cleanup_snapshot(
    connection: &Connection,
    card_id: &str,
) -> Result<CleanupSnapshot, String> {
    connection.query_row(
        "SELECT card_id,environment_id,workflow_revision,environment_revision,status,phase,completion_outcome,repository_id,source_path,target_path,source_branch,target_branch,source_revision,delete_local_branch,delete_remote_branch,merged_pr_head_revision,pane_ids,registration_validated FROM card_cleanup_operations WHERE card_id=?1",
        [card_id], |row| {
            let pane_json: String = row.get(16)?;
            Ok(CleanupSnapshot {
                card_id: row.get(0)?, environment_id: row.get(1)?, workflow_revision: row.get(2)?, environment_revision: row.get(3)?,
                status: row.get(4)?, phase: row.get(5)?, completion_outcome: row.get(6)?, repository_id: row.get(7)?,
                source_path: row.get(8)?, target_path: row.get(9)?, source_branch: row.get(10)?, target_branch: row.get(11)?, source_revision: row.get(12)?,
                delete_local_branch: row.get::<_, i64>(13)? != 0, delete_remote_branch: row.get::<_, i64>(14)? != 0,
                merged_pr_head_revision: row.get(15)?, pane_ids: serde_json::from_str(&pane_json).unwrap_or_default(), registration_validated: row.get::<_, i64>(17)? != 0,
            })
        },
    ).map_err(db_error)
}

pub(in crate::kanban) fn execute_cleanup_phase(
    operation: &CleanupSnapshot,
    pty_registry: &Mutex<PtyRegistry>,
    pi_registry: &Mutex<PiRpcRegistry>,
) -> Result<(), String> {
    match operation.phase.as_str() {
        "runtime_sessions" => cleanup_runtime_sessions(operation, pty_registry, pi_registry),
        "validate_repository" => validate_cleanup_repository(operation),
        "remove_worktree" => remove_cleanup_worktree(operation),
        "delete_local_branch" => delete_cleanup_local_branch(operation),
        "delete_remote_branch" => delete_cleanup_remote_branch(operation),
        "remove_metadata" => remove_cleanup_metadata(operation),
        "record_completion" => Ok(()),
        phase => Err(format!("Unknown cleanup phase {phase}")),
    }
}

pub(in crate::kanban) fn cleanup_runtime_sessions(
    operation: &CleanupSnapshot,
    pty_registry: &Mutex<PtyRegistry>,
    pi_registry: &Mutex<PiRpcRegistry>,
) -> Result<(), String> {
    let prefix = format!("kanban-card:{}:", operation.card_id);
    let mut pty_ids = operation
        .pane_ids
        .iter()
        .filter(|(_, kind)| kind == "terminal")
        .map(|(id, _)| id.clone())
        .collect::<HashSet<_>>();
    pty_ids.extend([
        format!("{prefix}terminal:server"),
        format!("{prefix}terminal:console"),
    ]);
    kill_ptys(pty_registry, &pty_ids.into_iter().collect::<Vec<_>>())
        .map_err(|error| format!("Could not stop card terminal sessions: {error}"))?;
    let mut pi_ids = operation
        .pane_ids
        .iter()
        .filter(|(_, kind)| kind == "pi")
        .map(|(id, _)| id.clone())
        .collect::<HashSet<_>>();
    pi_ids.extend([format!("{prefix}planning"), format!("{prefix}work")]);
    for pane_id in pi_ids {
        delete_pi_session_impl(pi_registry, &pane_id)
            .map_err(|error| format!("Could not delete Pi session {pane_id}: {error}"))?;
    }
    Ok(())
}

pub(in crate::kanban) fn validate_cleanup_repository(
    operation: &CleanupSnapshot,
) -> Result<(), String> {
    let target = validate_target_checkout(&operation.target_path, Some(&operation.repository_id))?;
    if target.target_branch != operation.target_branch {
        return Err(format!(
            "Target checkout is on {}, expected {}",
            target.target_branch, operation.target_branch
        ));
    }
    let source = validate_checkout(&operation.source_path, Some(&operation.repository_id))?;
    if source.target_checkout_path == target.target_checkout_path {
        return Err("Cleanup refuses to remove the primary checkout".to_string());
    }
    if source.target_branch != operation.source_branch {
        return Err(format!(
            "Source checkout is on {}, expected {}",
            source.target_branch, operation.source_branch
        ));
    }
    if source.target_revision != operation.source_revision {
        return Err("Source branch tip changed after cleanup intent was recorded".to_string());
    }
    ensure_registered_distinct_worktree(&operation.target_path, &operation.source_path)?;
    match local_ref_tip(&operation.target_path, &operation.source_branch)? {
        Some(tip) if tip == operation.source_revision => {}
        Some(_) => {
            return Err("Source branch tip changed after cleanup intent was recorded".to_string())
        }
        None => {
            return Err("The recorded source branch is absent before worktree removal".to_string())
        }
    }
    if operation.completion_outcome == "merged"
        && operation.merged_pr_head_revision.as_deref() != Some(&operation.source_revision)
    {
        let merged = git_status_success(
            &operation.target_path,
            &[
                "merge-base",
                "--is-ancestor",
                &operation.source_revision,
                "HEAD",
            ],
        )?;
        if !merged {
            return Err(
                "Source revision is not merged and no matching merged-PR evidence was recorded"
                    .to_string(),
            );
        }
    }
    Ok(())
}

pub(in crate::kanban) fn remove_cleanup_worktree(
    operation: &CleanupSnapshot,
) -> Result<(), String> {
    if Path::new(&operation.source_path).exists() {
        // Repeat the complete safety check immediately before the destructive
        // command; the worktree may have changed after the validation phase.
        validate_cleanup_repository(operation)?;
        let output = Command::new("git")
            .args([
                "-C",
                &operation.target_path,
                "worktree",
                "remove",
                "--",
                &operation.source_path,
            ])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "Git could not remove the source worktree: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        return Ok(());
    }
    if !operation.registration_validated {
        return Err(
            "Source worktree is absent without persisted successful registration validation"
                .to_string(),
        );
    }
    validate_cleanup_target(operation).map_err(|error| {
        format!("Target checkout changed while reconciling worktree removal: {error}")
    })?;
    match local_ref_tip(&operation.target_path, &operation.source_branch)? {
        Some(tip) if tip == operation.source_revision => Ok(()),
        Some(_) => Err("Source branch tip changed while reconciling worktree removal".to_string()),
        None if !operation.delete_local_branch => Ok(()),
        None => Err("Source branch disappeared before its deletion phase".to_string()),
    }
}

pub(in crate::kanban) fn delete_cleanup_local_branch(
    operation: &CleanupSnapshot,
) -> Result<(), String> {
    if !operation.delete_local_branch {
        return Ok(());
    }
    validate_cleanup_target(operation)?;
    let Some(tip) = local_ref_tip(&operation.target_path, &operation.source_branch)? else {
        return if operation.registration_validated {
            Ok(())
        } else {
            Err("Local branch is absent without persisted cleanup validation evidence".to_string())
        };
    };
    if tip != operation.source_revision {
        return Err("Local source branch tip changed; it was not deleted".to_string());
    }
    let rewritten =
        operation.merged_pr_head_revision.as_deref() == Some(&operation.source_revision);
    if !rewritten
        && !git_status_success(
            &operation.target_path,
            &[
                "merge-base",
                "--is-ancestor",
                &operation.source_revision,
                "HEAD",
            ],
        )?
    {
        return Err("Local source branch is not safely merged".to_string());
    }
    let flag = if rewritten { "-D" } else { "-d" };
    let output = Command::new("git")
        .args([
            "-C",
            &operation.target_path,
            "branch",
            flag,
            "--",
            &operation.source_branch,
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Git safely retained the local source branch: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

pub(in crate::kanban) fn delete_cleanup_remote_branch(
    operation: &CleanupSnapshot,
) -> Result<(), String> {
    if !operation.delete_remote_branch {
        return Ok(());
    }
    validate_cleanup_target(operation)?;
    if !operation.registration_validated
        || operation.merged_pr_head_revision.as_deref() != Some(&operation.source_revision)
    {
        return Err(
            "Remote deletion requires persisted validation and matching merged-PR head evidence"
                .to_string(),
        );
    }
    let remote_ref = format!("refs/heads/{}", operation.source_branch);
    let output = Command::new("git")
        .args([
            "-C",
            &operation.target_path,
            "ls-remote",
            "--heads",
            "origin",
            &remote_ref,
        ])
        .output()
        .map_err(|error| format!("Remote branch lookup failed: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Remote branch lookup failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let Some(tip) = text.split_whitespace().next() else {
        return Ok(());
    };
    if tip != operation.source_revision {
        return Err("Remote source branch tip changed; it was not deleted".to_string());
    }
    let lease = format!(
        "--force-with-lease={remote_ref}:{}",
        operation.source_revision
    );
    let deleted = Command::new("git")
        .args([
            "-C",
            &operation.target_path,
            "push",
            &lease,
            "origin",
            "--delete",
            &operation.source_branch,
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if deleted.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Remote branch deletion failed: {}",
            String::from_utf8_lossy(&deleted.stderr).trim()
        ))
    }
}

pub(in crate::kanban) fn validate_cleanup_target(
    operation: &CleanupSnapshot,
) -> Result<(), String> {
    let target = validate_target_checkout(&operation.target_path, Some(&operation.repository_id))?;
    if target.target_branch != operation.target_branch {
        return Err(format!(
            "Target checkout is on {}, expected {}",
            target.target_branch, operation.target_branch
        ));
    }
    Ok(())
}

pub(in crate::kanban) fn local_ref_tip(path: &str, branch: &str) -> Result<Option<String>, String> {
    let reference = format!("refs/heads/{branch}");
    let probe = Command::new("git")
        .args(["-C", path, "show-ref", "--verify", "--quiet", &reference])
        .output()
        .map_err(|error| error.to_string())?;
    if probe.status.code() == Some(1) {
        return Ok(None);
    }
    if !probe.status.success() {
        return Err(format!(
            "Could not inspect local source branch: {}",
            String::from_utf8_lossy(&probe.stderr).trim()
        ));
    }
    git_output(path, &["rev-parse", &reference]).map(Some)
}

pub(in crate::kanban) fn remove_cleanup_metadata(
    operation: &CleanupSnapshot,
) -> Result<(), String> {
    with_connection(|connection| {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let removed = transaction
            .execute(
                "DELETE FROM card_environments WHERE id=?1 AND card_id=?2 AND revision=?3",
                params![
                    operation.environment_id,
                    operation.card_id,
                    operation.environment_revision
                ],
            )
            .map_err(db_error)?;
        if removed == 0 {
            let still_exists = transaction
                .query_row(
                    "SELECT COUNT(*) FROM card_environments WHERE card_id=?1",
                    [&operation.card_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(db_error)?
                > 0;
            if still_exists {
                return Err("Environment metadata changed; cleanup will not remove it".to_string());
            }
        } else {
            let updated = transaction.execute("UPDATE kanban_cards SET workflow_revision=workflow_revision+1,updated_at=?1 WHERE id=?2 AND workflow_revision=?3", params![unix_timestamp(), operation.card_id, operation.workflow_revision]).map_err(db_error)?;
            if updated == 0 {
                return Err("Card changed before cleanup metadata removal".to_string());
            }
        }
        transaction.commit().map_err(db_error)
    })
}

pub(in crate::kanban) fn advance_cleanup_phase(operation: &CleanupSnapshot) -> Result<(), String> {
    with_connection(|connection| advance_cleanup_phase_in_connection(connection, operation))
}

pub(in crate::kanban) fn advance_cleanup_phase_in_connection(
    connection: &mut Connection,
    operation: &CleanupSnapshot,
) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    if operation.phase == "record_completion" {
        let now = unix_timestamp();
        let changed = transaction.execute("UPDATE card_cleanup_operations SET status='completed',error_code=NULL,error_detail=NULL,completed_at=?1,updated_at=?1 WHERE card_id=?2 AND phase=?3 AND status!='completed'", params![now, operation.card_id, operation.phase]).map_err(db_error)?;
        if changed == 0 {
            return Err("Cleanup operation changed while recording completion".to_string());
        }
        transaction.execute("UPDATE kanban_cards SET delivery_operation_stage=NULL,delivery_error=NULL WHERE id=?1", [&operation.card_id]).map_err(db_error)?;
        transaction.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,summary) VALUES (?1,?2,'user','cleanup','success',?3)", params![operation.card_id, now, if operation.completion_outcome == "closed" { "Removed source worktree and retained branches" } else { "Cleanup completed and safely deleted required branches" }]).map_err(db_error)?;
    } else {
        let next = next_cleanup_phase(&operation.phase)
            .ok_or_else(|| "Unknown or terminal cleanup phase".to_string())?;
        let now = unix_timestamp();
        let validation = (operation.phase == "validate_repository") as i64;
        let changed = transaction.execute("UPDATE card_cleanup_operations SET status='pending',phase=?1,error_code=NULL,error_detail=NULL,registration_validated=CASE WHEN ?2=1 THEN 1 ELSE registration_validated END,validation_completed_at=CASE WHEN ?2=1 THEN ?3 ELSE validation_completed_at END,updated_at=?3 WHERE card_id=?4 AND phase=?5 AND status!='completed'", params![next, validation, now, operation.card_id, operation.phase]).map_err(db_error)?;
        if changed == 0 {
            return Err("Cleanup operation changed while advancing its phase".to_string());
        }
        transaction.execute("UPDATE card_environments SET lifecycle_state='cleanup_pending',updated_at=?1 WHERE id=?2", params![now, operation.environment_id]).map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)
}

pub(in crate::kanban) fn next_cleanup_phase(phase: &str) -> Option<&'static str> {
    let index = CLEANUP_PHASES
        .iter()
        .position(|candidate| *candidate == phase)?;
    CLEANUP_PHASES.get(index + 1).copied()
}

pub(in crate::kanban) fn cleanup_error_code(phase: &str, _detail: &str) -> String {
    format!("cleanup_{}_failed", phase)
}

pub(in crate::kanban) fn record_cleanup_failure(
    card_id: &str,
    phase: &str,
    code: &str,
    detail: &str,
) {
    let _ = with_connection(|connection| {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        transaction.execute("UPDATE card_cleanup_operations SET status='failed',error_code=?1,error_detail=?2,updated_at=?3 WHERE card_id=?4 AND phase=?5", params![code, detail, unix_timestamp(), card_id, phase]).map_err(db_error)?;
        transaction.execute("UPDATE card_environments SET lifecycle_state='cleanup_failed',updated_at=?1 WHERE card_id=?2", params![unix_timestamp(), card_id]).map_err(db_error)?;
        transaction.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,summary,error_code,error_detail) VALUES (?1,?2,'user','cleanup','failure',?3,?4,?5)", params![card_id, unix_timestamp(), format!("Cleanup failed during {phase}"), code, detail]).map_err(db_error)?;
        transaction.commit().map_err(db_error)
    });
}

pub(in crate::kanban) fn feature_environment_title(title: &str) -> String {
    let mut title = title.trim();
    while let Some(rest) = title.strip_prefix("[FE]") {
        title = rest.trim_start();
    }
    format!("[FE] {title}")
}
