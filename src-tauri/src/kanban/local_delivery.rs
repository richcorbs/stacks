use super::*;
#[allow(unused_imports)]
use super::{
    cards::*, cleanup::*, domain::*, environment::*, git_effects::*, github_delivery::*, health::*,
    repository::*, sync::*,
};

pub(in crate::kanban) async fn kanban_approve_and_commit_operation(
    id: String,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
) -> Result<WorkflowOperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        coordinate_card_repository(&id, true, || {
            with_board_mutation(|connection| {
                approve_and_commit_with_failure_record(
                    connection,
                    &id,
                    expected_workflow_revision,
                    expected_environment_revision,
                )
            })
        })
    })
    .await
    .map_err(|error| format!("Approval worker failed: {error}"))?
}

pub(in crate::kanban) fn approve_and_commit_with_failure_record(
    connection: &mut Connection,
    id: &str,
    expected_card: i64,
    expected_environment: i64,
) -> Result<WorkflowOperationResult, String> {
    let result = approve_and_commit(connection, id, expected_card, expected_environment);
    if let Err(detail) = &result {
        let _ = connection.execute(
            "INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, error_code, error_detail) VALUES (?1, ?2, 'user', 'approve_and_commit', 'failure', 'approval_failed', ?3)",
            params![id, unix_timestamp(), detail],
        );
    }
    result
}

pub(in crate::kanban) fn approve_and_commit(
    connection: &mut Connection,
    id: &str,
    expected_card: i64,
    expected_environment: i64,
) -> Result<WorkflowOperationResult, String> {
    validate_card_environment_project(connection, id)?;
    let (status, card_revision): (CardStatus, i64) = connection
        .query_row(
            "SELECT status, workflow_revision FROM kanban_cards WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Kanban card was not found".to_string())?;
    let expected_agent_cycle = match status.as_str() {
        "needs_human" => card_revision == expected_card || card_revision == expected_card + 2,
        "agent_working" => card_revision == expected_card + 1,
        "approved" => card_revision == expected_card,
        _ => false,
    };
    if !expected_agent_cycle {
        return Err(
            if status == "needs_human" || status == "agent_working" || status == "approved" {
                "Card changed; reload before approving".to_string()
            } else {
                "Only a Needs you or Ready to merge card can be approved".to_string()
            },
        );
    }
    if status != CardStatus::AgentWorking {
        require_structural_capability(connection, id, WorkflowAction::Ship)?;
    }
    let (source_path, source_branch, repository_id, environment_revision, lifecycle_state): (String, String, Option<String>, i64, String) = connection
        .query_row(
            "SELECT worktree_path, branch, repository_id, revision, lifecycle_state FROM card_environments WHERE card_id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "This card has no work environment to approve".to_string())?;
    if environment_revision != expected_environment {
        return Err("Card environment changed; reload before approving".to_string());
    }
    if lifecycle_state != "ready" {
        return Err("Card work environment is not ready for approval".to_string());
    }
    let repository_id = repository_id
        .ok_or_else(|| "Card work environment has no recorded repository".to_string())?;
    let canonical_path = Path::new(&source_path)
        .canonicalize()
        .map_err(|error| format!("Source checkout does not exist at {source_path}: {error}"))?;
    let canonical_path = canonical_path
        .to_str()
        .ok_or_else(|| "Source checkout path is not valid UTF-8".to_string())?;
    if repository_identity(canonical_path)? != repository_id {
        return Err("Source checkout belongs to a different repository".to_string());
    }
    let current_branch = git_output(
        canonical_path,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )
    .map_err(|_| "Source checkout is detached; a named branch is required".to_string())?;
    if current_branch != source_branch {
        return Err(format!(
            "Source checkout is on {current_branch}, expected {source_branch}"
        ));
    }
    if has_git_operation(canonical_path)? {
        return Err("Source checkout has an in-progress Git operation".to_string());
    }
    let status_output = git_output(
        canonical_path,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )?;
    let (created, changed, deleted) = git_status_counts(&status_output);
    if created + changed + deleted > 0 {
        return Err(format!(
            "Approval failed: worktree is not clean ({created} new, {changed} modified, {deleted} deleted files remain)"
        ));
    }
    let source_tip = git_output(canonical_path, &["rev-parse", "HEAD"])?;
    let now = unix_timestamp();
    let transaction = connection
        .savepoint()
        .map_err(db_error)?;
    let workflow_changed = apply_workflow_transition(
        &transaction,
        id,
        WorkflowActor::User,
        WorkflowAction::Ship,
        Some(card_revision),
        "approve_and_commit",
        Some("Verified clean source worktree"),
    )?;
    transaction
        .execute(
            "UPDATE kanban_cards SET delivery_error=NULL WHERE id=?1",
            [id],
        )
        .map_err(db_error)?;
    let environment_rows = transaction.execute(
        "UPDATE card_environments SET source_revision=?1, revision=revision+1, updated_at=?2 WHERE card_id=?3 AND revision=?4 AND worktree_path=?5 AND branch=?6 AND repository_id=?7 AND lifecycle_state='ready'",
        params![source_tip, now, id, expected_environment, source_path, source_branch, repository_id],
    ).map_err(db_error)?;
    if environment_rows != 1 {
        return Err("Card environment changed; reload before approving".to_string());
    }
    if !workflow_changed {
        transaction.execute(
            "INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,from_status,to_status,summary) VALUES (?1,?2,'user','approve_and_commit','success','approved','approved','Re-verified clean source worktree')",
            params![id, now],
        ).map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)?;
    let card = get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string())?;
    Ok(WorkflowOperationResult {
        card,
        message: if status == "approved" {
            "Work re-verified; source revision refreshed for merging".to_string()
        } else {
            "Work committed and verified; card is Ready to merge".to_string()
        },
        idempotent: false,
    })
}

pub(in crate::kanban) fn git_status_counts(text: &str) -> (u32, u32, u32) {
    let mut created = 0;
    let mut changed = 0;
    let mut deleted = 0;
    for line in text.lines().filter(|line| line.len() >= 2) {
        let status = &line[..2];
        let index = status.as_bytes()[0] as char;
        let worktree = status.as_bytes()[1] as char;
        if status == "??" || index == 'A' || worktree == 'A' {
            created += 1;
        } else if index == 'D' || worktree == 'D' {
            deleted += 1;
        } else if [index, worktree]
            .iter()
            .any(|value| matches!(value, 'M' | 'R' | 'C' | 'T' | 'U'))
        {
            changed += 1;
        }
    }
    (created, changed, deleted)
}

pub(in crate::kanban) async fn kanban_merge_card_operation(
    id: String,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
) -> Result<WorkflowOperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = coordinate_card_repository(&id, true, || {
            with_board_mutation(|connection| {
                merge_card(
                    connection,
                    &id,
                    expected_workflow_revision,
                    expected_environment_revision,
                )
            })
        });
        if let Err(detail) = &result {
            if !detail.starts_with("Git merge failed") {
                record_operation_failure(&id, "merge", "merge_preflight_failed", detail);
            }
        }
        result
    })
    .await
    .map_err(|error| format!("Merge worker failed: {error}"))?
}

pub(in crate::kanban) fn merge_card(
    connection: &mut Connection,
    id: &str,
    expected_card: i64,
    expected_environment: i64,
) -> Result<WorkflowOperationResult, String> {
    validate_card_environment_project(connection, id)?;
    let (status, card_revision): (CardStatus, i64) = connection
        .query_row(
            "SELECT status, workflow_revision FROM kanban_cards WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Kanban card was not found".to_string())?;
    if card_revision != expected_card {
        return Err("Card changed; reload before merging".to_string());
    }
    let _ = status;
    require_structural_capability(connection, id, WorkflowAction::MergeLocal)?;
    let (source_path, source_branch, repository_id, target_path, target_branch, recorded_source_revision, environment_revision): (String, String, Option<String>, Option<String>, Option<String>, Option<String>, i64) = connection.query_row(
        "SELECT worktree_path, branch, repository_id, target_checkout_path, target_branch, source_revision, revision FROM card_environments WHERE card_id=?1", [id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
    ).optional().map_err(db_error)?.ok_or_else(|| "This card has no environment to merge".to_string())?;
    if environment_revision != expected_environment {
        return Err("Card environment changed; reload before merging".to_string());
    }
    let settings = project_delivery_settings(connection, id)?;
    if !matches!(
        settings.workflow,
        DeliveryWorkflow::LocalMerge | DeliveryWorkflow::ScriptedDelivery
    ) {
        return Err("This project uses GitHub pull request delivery".to_string());
    }
    let scripted = settings.workflow == DeliveryWorkflow::ScriptedDelivery;
    let repository_id = repository_id
        .ok_or_else(|| "Set merge target before merging this legacy environment".to_string())?;
    let target_path = target_path
        .ok_or_else(|| "Set merge target before merging this legacy environment".to_string())?;
    let target_branch = target_branch
        .ok_or_else(|| "Set merge target before merging this legacy environment".to_string())?;
    let configured_path = Path::new(&settings.path)
        .canonicalize()
        .map_err(|error| format!("Project checkout does not exist: {error}"))?;
    let recorded_path = Path::new(&target_path)
        .canonicalize()
        .map_err(|error| format!("Recorded target checkout does not exist: {error}"))?;
    if configured_path != recorded_path {
        return Err(
            "The recorded target is not the project's current primary checkout".to_string(),
        );
    }
    if target_branch != settings.target_branch {
        return Err(format!(
            "Project target branch changed to {}; revalidate the card environment before merging",
            settings.target_branch
        ));
    }
    let source = validate_checkout(&source_path, Some(&repository_id))?;
    let target = validate_checkout(&target_path, Some(&repository_id))?;
    if source.target_branch != source_branch {
        return Err(format!(
            "Source checkout is on {}, expected {source_branch}",
            source.target_branch
        ));
    }
    if target.target_branch != target_branch {
        return Err(format!(
            "Target checkout is on {}, expected {target_branch}",
            target.target_branch
        ));
    }
    ensure_registered_distinct_worktree(&target_path, &source_path)?;
    git_output(
        &target_path,
        &[
            "show-ref",
            "--verify",
            &format!("refs/heads/{source_branch}"),
        ],
    )?;
    git_output(
        &target_path,
        &[
            "show-ref",
            "--verify",
            &format!("refs/heads/{target_branch}"),
        ],
    )?;
    let source_tip = git_output(&source_path, &["rev-parse", "HEAD"])?;
    if recorded_source_revision.as_deref() != Some(source_tip.as_str()) {
        return Err(
            "The source revision changed after Commit; commit updates before merging".to_string(),
        );
    }
    let already = Command::new("git")
        .args([
            "-C",
            &target_path,
            "merge-base",
            "--is-ancestor",
            &source_tip,
            "HEAD",
        ])
        .status()
        .map_err(|error| error.to_string())?
        .success();
    if !already {
        let output = Command::new("git")
            .args(["-C", &target_path, "merge", "--no-ff", "--", &source_branch])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if has_git_operation(&target_path).unwrap_or(false) {
                let _ = Command::new("git")
                    .args(["-C", &target_path, "merge", "--abort"])
                    .status();
            }
            connection.execute("INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, error_code, error_detail) VALUES (?1, ?2, 'user', 'merge', 'failure', 'git_merge_failed', ?3)", params![id, unix_timestamp(), detail]).map_err(db_error)?;
            return Err(format!(
                "Git merge failed; the Stacks merge was aborted. {detail}"
            ));
        }
    }
    let verified = Command::new("git")
        .args([
            "-C",
            &target_path,
            "merge-base",
            "--is-ancestor",
            &source_tip,
            "HEAD",
        ])
        .status()
        .map_err(|error| error.to_string())?
        .success();
    if !verified {
        return Err(
            "Merge completed but ancestry verification failed; card remains Ready to merge"
                .to_string(),
        );
    }
    let target_tip = git_output(&target_path, &["rev-parse", "HEAD"])?;
    let transaction = connection
        .savepoint()
        .map_err(db_error)?;
    let environment_rows = transaction.execute("UPDATE card_environments SET source_revision=?1, target_revision=?2, revision=revision+1, updated_at=?3 WHERE card_id=?4 AND revision=?5 AND worktree_path=?6 AND branch=?7 AND repository_id=?8 AND target_checkout_path=?9 AND target_branch=?10 AND source_revision=?11", params![source_tip, target_tip, unix_timestamp(), id, expected_environment, source_path, source_branch, repository_id, target_path, target_branch, recorded_source_revision]).map_err(db_error)?;
    if environment_rows != 1 {
        return Err("Card environment changed; reload before recording the merge".to_string());
    }
    transaction
        .execute(
            "UPDATE kanban_cards SET delivery_error=NULL, delivery_operation_stage=?2 WHERE id=?1",
            params![
                id,
                if scripted {
                    Some("merged")
                } else {
                    None::<&str>
                }
            ],
        )
        .map_err(db_error)?;
    if scripted {
        let now = unix_timestamp();
        transaction.execute(
            "INSERT INTO scripted_delivery_operations(card_id,project_id,environment_id,repository_id,primary_checkout_path,target_branch,source_revision,merge_revision,stage,started_at,updated_at)
             SELECT c.id,c.project_id,e.id,?2,?3,?4,?5,?6,'merged',?7,?7 FROM kanban_cards c JOIN card_environments e ON e.card_id=c.id WHERE c.id=?1
             ON CONFLICT(card_id) DO UPDATE SET source_revision=excluded.source_revision,merge_revision=excluded.merge_revision,stage='merged',verified_push_revision=NULL,deployed_revision=NULL,failure_class=NULL,summary=NULL,updated_at=excluded.updated_at,revision=scripted_delivery_operations.revision+1",
            params![id, repository_id, target_path, target_branch, source_tip, target_tip, now],
        ).map_err(db_error)?;
        transaction.execute(
            "INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,from_status,to_status,summary) VALUES (?1,?2,'user','scripted_merge','success','approved','approved',?3)",
            params![id, now, if already { "Verified source already reachable from target" } else { "Merged source locally; push and deploy remain separate" }],
        ).map_err(db_error)?;
    } else {
        apply_workflow_transition(
            &transaction,
            id,
            WorkflowActor::User,
            WorkflowAction::MergeLocal,
            Some(expected_card),
            "merge_local",
            Some(if already {
                "Source was already reachable from target"
            } else {
                "Created explicit merge commit"
            }),
        )?;
    }
    transaction.commit().map_err(db_error)?;
    let card = get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string())?;
    Ok(WorkflowOperationResult {
        card,
        message: if already {
            format!("{source_branch} was already merged into {target_branch}")
        } else {
            format!("Merged {source_branch} into {target_branch}")
        },
        idempotent: already,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct TargetMergePrepareResult {
    pub(in crate::kanban) operation_id: Option<String>,
    pub(in crate::kanban) state: String,
    pub(in crate::kanban) checkout_path: Option<String>,
    pub(in crate::kanban) card: KanbanCard,
    pub(in crate::kanban) message: String,
    pub(in crate::kanban) idempotent: bool,
}

#[derive(Debug, Clone)]
pub(in crate::kanban) struct TargetMergeOperation {
    pub(in crate::kanban) id: String,
    pub(in crate::kanban) card_id: String,
    pub(in crate::kanban) environment_id: String,
    pub(in crate::kanban) workflow_revision: i64,
    pub(in crate::kanban) environment_revision: i64,
    pub(in crate::kanban) initial_status: String,
    pub(in crate::kanban) repository_id: String,
    pub(in crate::kanban) source_path: String,
    pub(in crate::kanban) source_branch: String,
    pub(in crate::kanban) target_path: String,
    pub(in crate::kanban) target_branch: String,
    pub(in crate::kanban) upstream_remote: String,
    pub(in crate::kanban) upstream_merge_ref: String,
    pub(in crate::kanban) source_revision: String,
    pub(in crate::kanban) initial_target_revision: String,
    pub(in crate::kanban) target_revision: String,
    pub(in crate::kanban) remote_revision: Option<String>,
    pub(in crate::kanban) pushed_target_revision: Option<String>,
    pub(in crate::kanban) push_attempts: i64,
    pub(in crate::kanban) phase: String,
    pub(in crate::kanban) conflict_paths: Vec<String>,
}

pub(in crate::kanban) fn load_target_merge_operation(
    connection: &Connection,
    card_id: &str,
) -> Result<Option<TargetMergeOperation>, String> {
    connection.query_row(
        "SELECT id,card_id,environment_id,workflow_revision,environment_revision,initial_status,repository_id,source_path,source_branch,target_checkout_path,target_branch,upstream_remote,upstream_merge_ref,source_revision,initial_target_revision,target_revision,remote_revision,pushed_target_revision,push_attempts,phase,conflict_paths FROM card_target_merge_operations WHERE card_id=?1",
        [card_id], |row| Ok(TargetMergeOperation {
            id: row.get(0)?, card_id: row.get(1)?, environment_id: row.get(2)?, workflow_revision: row.get(3)?, environment_revision: row.get(4)?, initial_status: row.get(5)?, repository_id: row.get(6)?, source_path: row.get(7)?, source_branch: row.get(8)?, target_path: row.get(9)?, target_branch: row.get(10)?, upstream_remote: row.get(11)?, upstream_merge_ref: row.get(12)?, source_revision: row.get(13)?, initial_target_revision: row.get(14)?, target_revision: row.get(15)?, remote_revision: row.get(16)?, pushed_target_revision: row.get(17)?, push_attempts: row.get(18)?, phase: row.get(19)?, conflict_paths: serde_json::from_str::<Vec<String>>(&row.get::<_, String>(20)?).unwrap_or_default(),
        }),
    ).optional().map_err(db_error)
}

pub(in crate::kanban) fn current_target_merge_result(
    connection: &Connection,
    operation: &TargetMergeOperation,
) -> Result<TargetMergePrepareResult, String> {
    let target_conflict = operation.phase == "target_conflicted";
    let source_conflict = operation.phase == "source_conflicted";
    Ok(TargetMergePrepareResult {
        operation_id: Some(operation.id.clone()),
        state: operation.phase.clone(),
        checkout_path: if target_conflict {
            Some(operation.target_path.clone())
        } else if source_conflict {
            Some(operation.source_path.clone())
        } else {
            None
        },
        card: get_card(connection, &operation.card_id)?
            .ok_or_else(|| "Kanban card was not found".to_string())?,
        message: if target_conflict {
            format!("The primary target checkout at {} has reconciliation conflicts that need the work agent", operation.target_path)
        } else if source_conflict {
            format!(
                "The card worktree at {} has conflicts while merging synchronized {}",
                operation.source_path, operation.target_branch
            )
        } else if operation.phase == "source_merged" {
            format!(
                "Synchronized and pushed {}; the card-worktree merge is ready for verification",
                operation.target_branch
            )
        } else {
            format!(
                "Target synchronization is pending for {}",
                operation.target_branch
            )
        },
        idempotent: false,
    })
}

pub(in crate::kanban) async fn kanban_prepare_target_merge_operation(
    id: String,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
) -> Result<TargetMergePrepareResult, String> {
    tauri::async_runtime::spawn_blocking(move || coordinate_card_repository(&id, true, || with_board_mutation(|connection| {
        let result = prepare_target_merge(connection, &id, expected_workflow_revision, expected_environment_revision);
        if let Err(detail) = &result {
            let _ = connection.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,error_code,error_detail,summary) VALUES (?1,?2,'user','merge_target','failure','target_synchronization_failed',?3,'Target synchronization stopped; durable recovery state was preserved when mutation had begun')", params![id,unix_timestamp(),detail]);
        }
        result
    }))).await.map_err(|error| format!("Target merge worker failed: {error}"))?
}

fn clean(path: &str) -> Result<bool, String> {
    Ok(!has_git_operation(path)?
        && git_output(path, &["status", "--porcelain=v1", "--untracked-files=all"])?.is_empty())
}

fn update_target_conflict(
    connection: &Connection,
    operation: &TargetMergeOperation,
) -> Result<TargetMergePrepareResult, String> {
    let paths = changed_paths(&operation.target_path)?;
    connection.execute("UPDATE card_target_merge_operations SET phase='target_conflicted',conflict_paths=?1,updated_at=?2 WHERE id=?3", params![serde_json::to_string(&paths).map_err(|e| e.to_string())?,unix_timestamp(),operation.id]).map_err(db_error)?;
    let current = load_target_merge_operation(connection, &operation.card_id)?
        .ok_or_else(|| "Could not reload target merge operation".to_string())?;
    current_target_merge_result(connection, &current)
}

fn verify_resolved_merge(
    path: &str,
    first_parent: &str,
    second_parent: &str,
    label: &str,
) -> Result<String, String> {
    if has_git_operation(path)? {
        return Err(format!("The {label} merge still has unresolved conflicts. Resolve and commit the existing merge before retrying"));
    }
    if !clean(path)? {
        return Err(format!("The {label} checkout is not clean after conflict resolution. Commit only the merge resolutions before retrying"));
    }
    let head = git_output(path, &["rev-parse", "HEAD"])?;
    let parents = git_output(path, &["rev-list", "--parents", "-n", "1", "HEAD"])?;
    if parents != format!("{head} {first_parent} {second_parent}") {
        return Err(format!("The completed {label} commit does not have the expected explicit merge topology. Do not rebase, squash, or replace the existing merge"));
    }
    Ok(head)
}

fn run_target_state_machine(
    connection: &mut Connection,
    card_id: &str,
) -> Result<TargetMergePrepareResult, String> {
    loop {
        let mut op = load_target_merge_operation(connection, card_id)?
            .ok_or_else(|| "No target merge is pending".to_string())?;
        if repository_identity(&op.source_path)? != op.repository_id
            || repository_identity(&op.target_path)? != op.repository_id
        {
            return Err("A checkout no longer belongs to the recorded repository; manual recovery is required".to_string());
        }
        if git_output(
            &op.source_path,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
        )? != op.source_branch
            || git_output(
                &op.target_path,
                &["symbolic-ref", "--quiet", "--short", "HEAD"],
            )? != op.target_branch
        {
            return Err("A checkout changed branches during target synchronization; manual recovery is required".to_string());
        }
        if op.phase == "target_conflicted" {
            if has_git_operation(&op.target_path)? {
                return current_target_merge_result(connection, &op);
            }
            let remote = op
                .remote_revision
                .clone()
                .ok_or_else(|| "The recorded upstream revision is missing".to_string())?;
            op.target_revision = verify_resolved_merge(
                &op.target_path,
                &op.target_revision,
                &remote,
                "primary-target",
            )?;
            connection.execute("UPDATE card_target_merge_operations SET target_revision=?1,phase='target_sync',conflict_paths='[]',updated_at=?2 WHERE id=?3", params![op.target_revision,unix_timestamp(),op.id]).map_err(db_error)?;
            continue;
        }
        if op.phase == "source_conflicted" {
            if has_git_operation(&op.source_path)? {
                return current_target_merge_result(connection, &op);
            }
            let pushed = op
                .pushed_target_revision
                .clone()
                .ok_or_else(|| "The pushed target revision is missing".to_string())?;
            verify_resolved_merge(
                &op.source_path,
                &op.source_revision,
                &pushed,
                "card-worktree",
            )?;
            connection.execute("UPDATE card_target_merge_operations SET phase='source_merged',conflict_paths='[]',updated_at=?1 WHERE id=?2", params![unix_timestamp(),op.id]).map_err(db_error)?;
            continue;
        }
        if op.phase == "source_merged" {
            return current_target_merge_result(connection, &op);
        }
        if op.phase == "pushed" {
            let pushed = op
                .pushed_target_revision
                .clone()
                .ok_or_else(|| "The pushed target revision is missing".to_string())?;
            if has_git_operation(&op.source_path)? {
                if git_output(&op.source_path, &["rev-parse", "HEAD"])? != op.source_revision {
                    return Err("The card-worktree revision changed during an interrupted merge; recover it manually".to_string());
                }
                let paths = changed_paths(&op.source_path)?;
                connection.execute("UPDATE card_target_merge_operations SET phase='source_conflicted',conflict_paths=?1,updated_at=?2 WHERE id=?3", params![serde_json::to_string(&paths).map_err(|e| e.to_string())?,unix_timestamp(),op.id]).map_err(db_error)?;
                let current = load_target_merge_operation(connection, card_id)?.unwrap();
                return current_target_merge_result(connection, &current);
            }
            if !clean(&op.source_path)? {
                return Err("The card worktree changed after target synchronization; recover it before continuing".to_string());
            }
            if git_status_success(
                &op.source_path,
                &["merge-base", "--is-ancestor", &pushed, "HEAD"],
            )? {
                connection.execute("UPDATE card_target_merge_operations SET phase='source_merged',updated_at=?1 WHERE id=?2", params![unix_timestamp(),op.id]).map_err(db_error)?;
                continue;
            }
            let merge = Command::new("git")
                .args([
                    "-C",
                    &op.source_path,
                    "merge",
                    "--no-ff",
                    "--no-edit",
                    &pushed,
                ])
                .output()
                .map_err(|e| e.to_string())?;
            if !merge.status.success() {
                if has_git_operation(&op.source_path)? {
                    let paths = changed_paths(&op.source_path)?;
                    connection.execute("UPDATE card_target_merge_operations SET phase='source_conflicted',conflict_paths=?1,updated_at=?2 WHERE id=?3", params![serde_json::to_string(&paths).map_err(|e| e.to_string())?,unix_timestamp(),op.id]).map_err(db_error)?;
                    let current = load_target_merge_operation(connection, card_id)?.unwrap();
                    return current_target_merge_result(connection, &current);
                }
                return Err(format!(
                    "Could not merge the pushed target into the card worktree: {}",
                    String::from_utf8_lossy(&merge.stderr).trim()
                ));
            }
            connection.execute("UPDATE card_target_merge_operations SET phase='source_merged',updated_at=?1 WHERE id=?2", params![unix_timestamp(),op.id]).map_err(db_error)?;
            continue;
        }
        if op.phase != "target_sync" {
            return Err(format!("Unknown target merge phase {}", op.phase));
        }
        if has_git_operation(&op.target_path)? {
            if git_output(&op.target_path, &["rev-parse", "HEAD"])? != op.target_revision
                || op.remote_revision.is_none()
            {
                return Err("The primary target has an unrecognized Git operation; manual recovery is required".to_string());
            }
            return update_target_conflict(connection, &op);
        }
        if !clean(&op.target_path)? {
            return Err("The primary target checkout is not clean; Stacks will not mutate it".to_string());
        }
        let local = git_output(&op.target_path, &["rev-parse", "HEAD"])?;
        if local != op.target_revision {
            let attributable = op.remote_revision.as_ref().is_some_and(|remote| {
                local == *remote
                    || git_output(
                        &op.target_path,
                        &["rev-list", "--parents", "-n", "1", &local],
                    )
                    .ok()
                    .as_deref()
                        == Some(&format!("{local} {} {remote}", op.target_revision))
            });
            if !attributable {
                return Err("The primary target revision changed outside this operation; manual recovery is required".to_string());
            }
            connection.execute("UPDATE card_target_merge_operations SET target_revision=?1,updated_at=?2 WHERE id=?3", params![local,unix_timestamp(),op.id]).map_err(db_error)?;
            op.target_revision = local.clone();
        }
        let advertised = git_output(
            &op.target_path,
            &["ls-remote", &op.upstream_remote, &op.upstream_merge_ref],
        )?
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();
        if advertised == local && op.push_attempts > 0 {
            connection.execute("UPDATE card_target_merge_operations SET pushed_target_revision=?1,phase='pushed',updated_at=?2 WHERE id=?3", params![local,unix_timestamp(),op.id]).map_err(db_error)?;
            continue;
        }
        if op.push_attempts >= 2 {
            return Err("The upstream advanced during both push attempts. Retry later after recovering this target synchronization operation.".to_string());
        }
        git_output(
            &op.target_path,
            &[
                "fetch",
                "--no-tags",
                &op.upstream_remote,
                &op.upstream_merge_ref,
            ],
        )?;
        let remote = git_output(&op.target_path, &["rev-parse", "FETCH_HEAD"])?;
        connection.execute("UPDATE card_target_merge_operations SET remote_revision=?1,updated_at=?2 WHERE id=?3", params![remote,unix_timestamp(),op.id]).map_err(db_error)?;
        if local != remote {
            if git_status_success(
                &op.target_path,
                &["merge-base", "--is-ancestor", &local, &remote],
            )? {
                git_output(&op.target_path, &["merge", "--ff-only", &remote])?;
            } else if !git_status_success(
                &op.target_path,
                &["merge-base", "--is-ancestor", &remote, &local],
            )? {
                let merge = Command::new("git")
                    .args([
                        "-C",
                        &op.target_path,
                        "merge",
                        "--no-ff",
                        "--no-edit",
                        &remote,
                    ])
                    .output()
                    .map_err(|e| e.to_string())?;
                if !merge.status.success() {
                    if has_git_operation(&op.target_path)? {
                        return update_target_conflict(connection, &op);
                    }
                    return Err(format!(
                        "Primary-target reconciliation failed: {}",
                        String::from_utf8_lossy(&merge.stderr).trim()
                    ));
                }
            }
        }
        let synchronized = git_output(&op.target_path, &["rev-parse", "HEAD"])?;
        let attempt = op.push_attempts + 1;
        connection.execute("UPDATE card_target_merge_operations SET target_revision=?1,push_attempts=?2,updated_at=?3 WHERE id=?4", params![synchronized,attempt,unix_timestamp(),op.id]).map_err(db_error)?;
        let destination = format!("HEAD:{}", op.upstream_merge_ref);
        let push = Command::new("git")
            .args([
                "-C",
                &op.target_path,
                "push",
                &op.upstream_remote,
                &destination,
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !push.status.success() {
            let detail = String::from_utf8_lossy(&push.stderr).trim().to_string();
            if attempt < 2
                && (detail.contains("non-fast-forward")
                    || detail.contains("fetch first")
                    || detail.contains("stale info")
                    || detail.contains("rejected"))
            {
                continue;
            }
            if attempt >= 2 {
                return Err("The upstream advanced during both push attempts. Retry later; the reconciled local target and recovery record were preserved.".to_string());
            }
            return Err(format!(
                "Could not push the synchronized target without force: {detail}"
            ));
        }
        let advertised = git_output(
            &op.target_path,
            &["ls-remote", &op.upstream_remote, &op.upstream_merge_ref],
        )?
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();
        if advertised != synchronized {
            return Err("Push succeeded but the configured upstream does not advertise the exact synchronized target revision".to_string());
        }
        connection.execute("UPDATE card_target_merge_operations SET pushed_target_revision=?1,phase='pushed',updated_at=?2 WHERE id=?3", params![synchronized,unix_timestamp(),op.id]).map_err(db_error)?;
    }
}

pub(in crate::kanban) fn prepare_target_merge(
    connection: &mut Connection,
    id: &str,
    expected_card: i64,
    expected_environment: i64,
) -> Result<TargetMergePrepareResult, String> {
    validate_card_environment_project(connection, id)?;
    if let Some(operation) = load_target_merge_operation(connection, id)? {
        if operation.workflow_revision != expected_card
            || operation.environment_revision != expected_environment
        {
            return Err("A target merge is already pending for an older card state. Retry recovery before starting again".to_string());
        }
        return run_target_state_machine(connection, id);
    }
    let (status, workflow_revision): (String, i64) = connection
        .query_row(
            "SELECT status,workflow_revision FROM kanban_cards WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Kanban card was not found".to_string())?;
    require_structural_capability(connection, id, WorkflowAction::MergeTarget)?;
    if workflow_revision != expected_card {
        return Err("Card changed; reload before merging in the target".to_string());
    }
    let (environment_id,source_path,source_branch,repository_id,target_path,target_branch,environment_revision,lifecycle):(String,String,String,Option<String>,Option<String>,Option<String>,i64,String)=connection.query_row("SELECT id,worktree_path,branch,repository_id,target_checkout_path,target_branch,revision,lifecycle_state FROM card_environments WHERE card_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).optional().map_err(db_error)?.ok_or_else(||"This card has no work environment".to_string())?;
    if environment_revision != expected_environment {
        return Err("Card environment changed; reload before merging in the target".to_string());
    }
    if lifecycle != "ready" {
        return Err("Card work environment is not ready for a target merge".to_string());
    }
    let repository_id = repository_id
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            "The card environment has no recorded repository; revalidate its merge target"
                .to_string()
        })?;
    let target_path = target_path
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            "The card environment has no recorded target checkout; set its merge target again"
                .to_string()
        })?;
    let target_branch = target_branch
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            "The card environment has no recorded target branch; set its merge target again"
                .to_string()
        })?;
    let settings = project_delivery_settings(connection, id)?;
    if target_branch != settings.target_branch {
        return Err(format!(
            "Project target branch changed to {}; revalidate the card environment",
            settings.target_branch
        ));
    }
    if Path::new(&settings.path)
        .canonicalize()
        .map_err(|e| format!("Project checkout does not exist: {e}"))?
        != Path::new(&target_path)
            .canonicalize()
            .map_err(|e| format!("Recorded target checkout does not exist: {e}"))?
    {
        return Err(
            "The recorded target is not the project's current primary checkout".to_string(),
        );
    }
    let source = validate_checkout(&source_path, Some(&repository_id))?;
    let target = validate_checkout(&target_path, Some(&repository_id))?;
    if source.target_branch != source_branch {
        return Err(format!(
            "Source checkout is on {}, expected {source_branch}",
            source.target_branch
        ));
    }
    if target.target_branch != target_branch {
        return Err(format!(
            "Target checkout is on {}, expected {target_branch}",
            target.target_branch
        ));
    }
    ensure_registered_distinct_worktree(&target_path, &source_path)?;
    let remote = git_output(
        &target_path,
        &["config", "--get", &format!("branch.{target_branch}.remote")],
    )
    .map_err(|_| format!("Target branch {target_branch} has no configured upstream remote"))?;
    let merge_ref = git_output(
        &target_path,
        &["config", "--get", &format!("branch.{target_branch}.merge")],
    )
    .map_err(|_| format!("Target branch {target_branch} has no configured upstream branch"))?;
    if remote.trim().is_empty() || remote == "." || !merge_ref.starts_with("refs/heads/") {
        return Err(format!(
            "Target branch {target_branch} does not have a fetchable configured upstream"
        ));
    }
    let operation_id = uuid::Uuid::new_v4().to_string();
    let now = unix_timestamp();
    connection.execute("INSERT INTO card_target_merge_operations (id,card_id,environment_id,workflow_revision,environment_revision,initial_status,repository_id,source_path,source_branch,target_checkout_path,target_branch,upstream_remote,upstream_merge_ref,source_revision,initial_target_revision,target_revision,phase,conflict_paths,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15,'target_sync','[]',?16,?16)",params![operation_id,id,environment_id,expected_card,expected_environment,status,repository_id,source_path,source_branch,target_path,target_branch,remote,merge_ref,source.target_revision,target.target_revision,now]).map_err(db_error)?;
    run_target_state_machine(connection, id)
}

pub(in crate::kanban) async fn kanban_finalize_target_merge_operation(
    id: String,
    operation_id: String,
) -> Result<WorkflowOperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        coordinate_card_repository(&id, true, || {
            with_board_mutation(|c| finalize_target_merge(c, &id, &operation_id))
        })
    })
    .await
    .map_err(|e| format!("Target merge finalization worker failed: {e}"))?
}

pub(in crate::kanban) fn finalize_target_merge(
    connection: &mut Connection,
    card_id: &str,
    operation_id: &str,
) -> Result<WorkflowOperationResult, String> {
    let operation = load_target_merge_operation(connection, card_id)?
        .ok_or_else(|| "No target merge is pending for this card".to_string())?;
    if operation.id != operation_id {
        return Err("The target merge operation changed; reload before finalizing".to_string());
    }
    if operation.phase != "source_merged" {
        return Err("Target synchronization and the card-worktree merge are not ready for final verification".to_string());
    }
    let pushed = operation
        .pushed_target_revision
        .clone()
        .ok_or_else(|| "The exact pushed target revision is missing".to_string())?;
    if !clean(&operation.source_path)? {
        return Err("The card worktree is not clean after merging the target".to_string());
    }
    if !git_status_success(
        &operation.source_path,
        &["merge-base", "--is-ancestor", &pushed, "HEAD"],
    )? {
        return Err(
            "The exact pushed target revision is not contained in the card worktree".to_string(),
        );
    }
    let head = git_output(&operation.source_path, &["rev-parse", "HEAD"])?;
    let already = git_status_success(
        &operation.source_path,
        &[
            "merge-base",
            "--is-ancestor",
            &pushed,
            &operation.source_revision,
        ],
    )?;
    if already {
        if head != operation.source_revision {
            return Err(
                "The card worktree changed unexpectedly during an idempotent target merge"
                    .to_string(),
            );
        }
    } else {
        verify_resolved_merge(
            &operation.source_path,
            &operation.source_revision,
            &pushed,
            "card-worktree",
        )?;
    }
    let transaction = connection.savepoint().map_err(db_error)?;
    let (status, current_revision): (String, i64) = transaction
        .query_row(
            "SELECT status,workflow_revision FROM kanban_cards WHERE id=?1",
            [card_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db_error)?;
    let revision_valid = if operation.initial_status == "needs_human" {
        (status == "needs_human"
            && (current_revision == operation.workflow_revision
                || current_revision == operation.workflow_revision + 2))
            || (status == "agent_working" && current_revision == operation.workflow_revision + 1)
    } else {
        status == "approved" && current_revision == operation.workflow_revision
    };
    if !revision_valid {
        return Err(
            "Card changed while the target merge was running; recover the merge before retrying"
                .to_string(),
        );
    }
    let environment_revision: i64 = transaction
        .query_row(
            "SELECT revision FROM card_environments WHERE id=?1",
            [&operation.environment_id],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    if environment_revision != operation.environment_revision {
        return Err("Card environment changed while the target merge was running".to_string());
    }
    let card =
        get_card(&transaction, card_id)?.ok_or_else(|| "Kanban card was not found".to_string())?;
    let transition = workflow::target_merge_completion(
        &workflow_context_for_card(&transaction, &card)?,
        WorkflowActor::User,
    )?;
    let now = unix_timestamp();
    transaction.execute("UPDATE card_environments SET source_revision=?1,target_revision=?2,revision=revision+1,updated_at=?3 WHERE id=?4 AND revision=?5",params![head,pushed,now,operation.environment_id,operation.environment_revision]).map_err(db_error)?;
    if transition.from != transition.to {
        if transaction.execute("UPDATE kanban_cards SET status=?1,delivery_error=NULL,workflow_revision=workflow_revision+1,updated_at=?2,sort_order=(SELECT COALESCE(MAX(sort_order),-1)+1 FROM kanban_cards d WHERE d.status=?1) WHERE id=?3 AND workflow_revision=?4",params![transition.to,now,card_id,current_revision]).map_err(db_error)?!=1{return Err("Card changed while finalizing the target merge".to_string());}
    } else {
        transaction
            .execute(
                "UPDATE kanban_cards SET delivery_error=NULL,updated_at=?1 WHERE id=?2",
                params![now, card_id],
            )
            .map_err(db_error)?;
    }
    let summary = if already {
        format!("Synchronized and pushed target branch {}; exact revision was already contained in the card worktree",operation.target_branch)
    } else {
        format!("Synchronized and pushed target branch {}; merged the exact pushed revision into the card worktree",operation.target_branch)
    };
    transaction.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,from_status,to_status,summary) VALUES (?1,?2,'user','merge_target','success',?3,?4,?5)",params![card_id,now,transition.from,transition.to,summary]).map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM card_target_merge_operations WHERE id=?1",
            [operation_id],
        )
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    Ok(WorkflowOperationResult {
        card: get_card(connection, card_id)?
            .ok_or_else(|| "Kanban card was not found".to_string())?,
        message: if already {
            format!(
                "{} was synchronized and already contained in this card",
                operation.target_branch
            )
        } else {
            format!(
                "Synchronized, pushed, and merged {}",
                operation.target_branch
            )
        },
        idempotent: already,
    })
}

pub(in crate::kanban) async fn kanban_abort_target_merge_operation(
    id: String,
    operation_id: String,
) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        coordinate_card_repository(&id, true, || {
            with_board_mutation(|c| abort_target_merge(c, &id, &operation_id))
        })
    })
    .await
    .map_err(|e| format!("Target merge recovery worker failed: {e}"))?
}

pub(in crate::kanban) fn changed_paths(path: &str) -> Result<Vec<String>, String> {
    let mut paths = Vec::new();
    for args in [
        ["diff", "--name-only"].as_slice(),
        ["diff", "--cached", "--name-only"].as_slice(),
        ["ls-files", "--others", "--exclude-standard"].as_slice(),
    ] {
        paths.extend(
            git_output(path, args)?
                .lines()
                .filter(|l| !l.is_empty())
                .map(str::to_string),
        );
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn attributable_merge_chain(
    path: &str,
    starting: &str,
    head: &str,
    upstream: &str,
) -> Result<bool, String> {
    let commits = git_output(
        path,
        &[
            "rev-list",
            "--first-parent",
            "--reverse",
            &format!("{starting}..{head}"),
        ],
    )?;
    let mut expected_parent = starting.to_string();
    for commit in commits.lines() {
        let parents = git_output(path, &["rev-list", "--parents", "-n", "1", commit])?;
        let parts = parents.split_whitespace().collect::<Vec<_>>();
        if parts.len() != 3
            || parts[1] != expected_parent
            || !git_status_success(path, &["merge-base", "--is-ancestor", parts[2], upstream])?
        {
            return Ok(false);
        }
        expected_parent = commit.to_string();
    }
    Ok(expected_parent == head)
}

fn safely_restore_merge(
    path: &str,
    starting: &str,
    other: &str,
    recorded: &[String],
    label: &str,
) -> Result<(), String> {
    let head = git_output(path, &["rev-parse", "HEAD"])?;
    if has_git_operation(path)? {
        if head != starting {
            return Err(format!(
                "The {label} revision changed during its conflicted merge; recover manually"
            ));
        }
        if changed_paths(path)?.iter().any(|p| !recorded.contains(p)) {
            return Err(format!("The {label} contains changes outside the recorded merge; Stacks will not discard them"));
        }
        git_output(path, &["merge", "--abort"])?;
    } else if head != starting {
        let parents = git_output(path, &["rev-list", "--parents", "-n", "1", "HEAD"])?;
        if (head != other
            && parents != format!("{head} {starting} {other}")
            && !attributable_merge_chain(path, starting, &head, other)?)
            || !clean(path)?
        {
            return Err(format!(
                "The completed {label} state cannot be safely attributed to this operation"
            ));
        }
        git_output(path, &["reset", "--hard", starting])?;
    }
    if git_output(path, &["rev-parse", "HEAD"])? != starting || !clean(path)? {
        return Err(format!(
            "Could not safely restore the {label} starting revision"
        ));
    }
    Ok(())
}

pub(in crate::kanban) fn abort_target_merge(
    connection: &mut Connection,
    card_id: &str,
    operation_id: &str,
) -> Result<KanbanCard, String> {
    let op = load_target_merge_operation(connection, card_id)?
        .ok_or_else(|| "No target merge is pending for this card".to_string())?;
    if op.id != operation_id {
        return Err("The target merge operation changed; manual recovery is required".to_string());
    }
    if let Some(pushed) = &op.pushed_target_revision {
        safely_restore_merge(
            &op.source_path,
            &op.source_revision,
            pushed,
            &op.conflict_paths,
            "card worktree",
        )?; /* Never roll back a pushed target. */
    } else {
        let other = op
            .remote_revision
            .as_deref()
            .unwrap_or(&op.initial_target_revision);
        safely_restore_merge(
            &op.target_path,
            &op.initial_target_revision,
            other,
            &op.conflict_paths,
            "primary target checkout",
        )?;
        safely_restore_merge(
            &op.source_path,
            &op.source_revision,
            &op.target_revision,
            &[],
            "card worktree",
        )?;
    }
    connection
        .execute(
            "DELETE FROM card_target_merge_operations WHERE id=?1",
            [operation_id],
        )
        .map_err(db_error)?;
    get_card(connection, card_id)?.ok_or_else(|| "Kanban card was not found".to_string())
}
