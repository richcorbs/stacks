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
            if !detail.starts_with("Git merge failed") && !detail.starts_with("Git push failed") {
                record_operation_failure(&id, "merge", "merge_preflight_failed", detail);
            }
        }
        result
    })
    .await
    .map_err(|error| format!("Merge worker failed: {error}"))?
}

pub(in crate::kanban) fn configured_target_upstream(
    path: &str,
    target_branch: &str,
) -> Option<(String, String)> {
    let remote = git_output(
        path,
        &["config", "--get", &format!("branch.{target_branch}.remote")],
    )
    .ok()?;
    let upstream_ref = git_output(
        path,
        &["config", "--get", &format!("branch.{target_branch}.merge")],
    )
    .ok()?;
    let remote = remote.trim();
    let upstream_ref = upstream_ref.trim();
    if remote.is_empty()
        || remote == "."
        || !upstream_ref.starts_with("refs/heads/")
        || upstream_ref == "refs/heads/"
        || !git_status_success(path, &["check-ref-format", upstream_ref]).ok()?
        || git_output(path, &["remote", "get-url", remote]).is_err()
    {
        return None;
    }
    Some((remote.to_string(), upstream_ref.to_string()))
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
    let upstream = if scripted {
        None
    } else {
        configured_target_upstream(&target_path, &target_branch)
    };
    if let Some((remote, upstream_ref)) = upstream.as_ref() {
        let push = Command::new("git")
            .args([
                "-C",
                &target_path,
                "push",
                "--",
                remote,
                &format!("HEAD:{upstream_ref}"),
            ])
            .output();
        let failure = match push {
            Ok(output) if output.status.success() => None,
            Ok(output) => Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
            Err(error) => Some(error.to_string()),
        };
        if let Some(detail) = failure {
            let message = format!(
                "Git push failed after the local merge; the merge remains intact and the card remains Ready to merge. {detail}"
            );
            connection.execute(
                "UPDATE kanban_cards SET delivery_error=?1 WHERE id=?2",
                params![message, id],
            ).map_err(db_error)?;
            connection.execute(
                "INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, error_code, error_detail) VALUES (?1, ?2, 'user', 'merge', 'failure', 'git_push_failed', ?3)",
                params![id, unix_timestamp(), message],
            ).map_err(db_error)?;
            return Err(message);
        }
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
        message: if let Some((remote, upstream_ref)) = upstream {
            if already {
                format!("{source_branch} was already merged into {target_branch}; pushed {target_branch} to {remote} {upstream_ref}")
            } else {
                format!("Merged {source_branch} into {target_branch} and pushed to {remote} {upstream_ref}")
            }
        } else if scripted {
            if already {
                format!("{source_branch} was already merged into {target_branch}")
            } else {
                format!("Merged {source_branch} into {target_branch}")
            }
        } else if already {
            format!("{source_branch} was already merged into {target_branch}; completed locally without a usable upstream")
        } else {
            format!("Merged {source_branch} into {target_branch}; completed locally without a usable upstream")
        },
        idempotent: already,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct TargetMergePrepareResult {
    pub(in crate::kanban) operation_id: Option<String>,
    pub(in crate::kanban) state: String,
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
    pub(in crate::kanban) source_path: String,
    pub(in crate::kanban) target_branch: String,
    pub(in crate::kanban) source_revision: String,
    pub(in crate::kanban) target_revision: String,
    pub(in crate::kanban) target_source: String,
    pub(in crate::kanban) phase: String,
    pub(in crate::kanban) conflict_paths: Vec<String>,
}

pub(in crate::kanban) fn load_target_merge_operation(
    connection: &Connection,
    card_id: &str,
) -> Result<Option<TargetMergeOperation>, String> {
    connection.query_row(
        "SELECT id,card_id,environment_id,workflow_revision,environment_revision,initial_status,source_path,target_branch,source_revision,target_revision,target_source,phase,conflict_paths FROM card_target_merge_operations WHERE card_id=?1",
        [card_id],
        |row| Ok(TargetMergeOperation {
            id: row.get(0)?, card_id: row.get(1)?, environment_id: row.get(2)?, workflow_revision: row.get(3)?,
            environment_revision: row.get(4)?, initial_status: row.get(5)?, source_path: row.get(6)?, target_branch: row.get(7)?,
            source_revision: row.get(8)?, target_revision: row.get(9)?, target_source: row.get(10)?, phase: row.get(11)?,
            conflict_paths: serde_json::from_str::<Vec<String>>(&row.get::<_, String>(12)?).unwrap_or_default(),
        }),
    ).optional().map_err(db_error)
}

pub(in crate::kanban) fn current_target_merge_result(
    connection: &Connection,
    operation: &TargetMergeOperation,
) -> Result<TargetMergePrepareResult, String> {
    let card = get_card(connection, &operation.card_id)?
        .ok_or_else(|| "Kanban card was not found".to_string())?;
    Ok(TargetMergePrepareResult {
        operation_id: Some(operation.id.clone()),
        state: operation.phase.clone(),
        card,
        message: if operation.phase == "conflicted" {
            format!(
                "The merge with {} {} has conflicts that need the work agent",
                operation.target_source, operation.target_branch
            )
        } else {
            format!(
                "The merge with {} {} is ready for verification",
                operation.target_source, operation.target_branch
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
    tauri::async_runtime::spawn_blocking(move || {
        coordinate_card_repository(&id, true, || {
            with_board_mutation(|connection| {
                prepare_target_merge(
                    connection,
                    &id,
                    expected_workflow_revision,
                    expected_environment_revision,
                )
            })
        })
    })
    .await
    .map_err(|error| format!("Target merge worker failed: {error}"))?
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
        return current_target_merge_result(connection, &operation);
    }
    let transaction = connection
        .savepoint()
        .map_err(db_error)?;
    let (status, workflow_revision): (String, i64) = transaction
        .query_row(
            "SELECT status,workflow_revision FROM kanban_cards WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Kanban card was not found".to_string())?;
    require_structural_capability(&transaction, id, WorkflowAction::MergeTarget)?;
    if workflow_revision != expected_card {
        return Err("Card changed; reload before merging in the target".to_string());
    }
    let (environment_id, source_path, source_branch, repository_id, target_path, target_branch, environment_revision, lifecycle): (String,String,String,Option<String>,Option<String>,Option<String>,i64,String) = transaction.query_row(
        "SELECT id,worktree_path,branch,repository_id,target_checkout_path,target_branch,revision,lifecycle_state FROM card_environments WHERE card_id=?1", [id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?)),
    ).optional().map_err(db_error)?.ok_or_else(|| "This card has no work environment".to_string())?;
    if environment_revision != expected_environment {
        return Err("Card environment changed; reload before merging in the target".to_string());
    }
    if lifecycle != "ready" {
        return Err("Card work environment is not ready for a target merge".to_string());
    }
    let repository_id = repository_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "The card environment has no recorded repository; revalidate its merge target"
                .to_string()
        })?;
    let target_path = target_path
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "The card environment has no recorded target checkout; set its merge target again"
                .to_string()
        })?;
    let target_branch = target_branch
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "The card environment has no recorded target branch; set its merge target again"
                .to_string()
        })?;
    let settings = project_delivery_settings(&transaction, id)?;
    if target_branch != settings.target_branch {
        return Err(format!(
            "Project target branch changed to {}; revalidate the card environment",
            settings.target_branch
        ));
    }
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
    let source = validate_checkout(&source_path, Some(&repository_id))?;
    if source.target_branch != source_branch {
        return Err(format!(
            "Source checkout is on {}, expected {source_branch}",
            source.target_branch
        ));
    }
    let target = validate_target_checkout(&target_path, Some(&repository_id))?;
    if target.target_branch != target_branch {
        return Err(format!(
            "Target checkout is on {}, expected {target_branch}",
            target.target_branch
        ));
    }
    ensure_registered_distinct_worktree(&target_path, &source_path)?;

    // Validation snapshots both committed tips before any fetch. The primary
    // checkout may be dirty, so local fallback must use this revision rather
    // than its working tree contents.
    let source_revision = source.target_revision;
    let mut target_revision = target.target_revision;
    let mut target_source = "local";
    let remote_key = format!("branch.{target_branch}.remote");
    let merge_key = format!("branch.{target_branch}.merge");
    let remote = git_output(&source_path, &["config", "--get", &remote_key]).unwrap_or_default();
    let merge_ref = git_output(&source_path, &["config", "--get", &merge_key]).unwrap_or_default();
    let fetchable_upstream =
        !remote.trim().is_empty() && remote != "." && merge_ref.starts_with("refs/heads/");
    if fetchable_upstream {
        if let Ok(fetch) = Command::new("git")
            .args([
                "-C",
                &source_path,
                "fetch",
                "--no-tags",
                &remote,
                &merge_ref,
            ])
            .output()
        {
            if fetch.status.success() {
                if let Ok(fetched_revision) = git_output(&source_path, &["rev-parse", "FETCH_HEAD"])
                {
                    target_revision = fetched_revision;
                    target_source = "remote";
                }
            }
        }
    }
    if git_status_success(
        &source_path,
        &["merge-base", "--is-ancestor", &target_revision, "HEAD"],
    )? {
        let now = unix_timestamp();
        transaction.execute("UPDATE card_environments SET source_revision=?1,target_revision=?2,revision=revision+1,updated_at=?3 WHERE id=?4 AND revision=?5", params![source_revision,target_revision,now,environment_id,expected_environment]).map_err(db_error)?;
        transaction.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,from_status,to_status,summary) VALUES (?1,?2,'user','merge_target','success',?3,?3,?4)", params![id,now,status,format!("Selected {target_source} target branch {target_branch} was already contained in the source branch")]).map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        return Ok(TargetMergePrepareResult {
            operation_id: None,
            state: "noop".into(),
            card: get_card(connection, id)?
                .ok_or_else(|| "Kanban card was not found".to_string())?,
            message: format!("Already up to date with {target_source} {target_branch}"),
            idempotent: true,
        });
    }
    let operation_id = uuid::Uuid::new_v4().to_string();
    let now = unix_timestamp();
    transaction.execute("INSERT INTO card_target_merge_operations (id,card_id,environment_id,workflow_revision,environment_revision,initial_status,repository_id,source_path,source_branch,target_branch,upstream_remote,upstream_merge_ref,source_revision,target_revision,target_source,phase,conflict_paths,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'merged','[]',?16,?16)", params![operation_id,id,environment_id,expected_card,expected_environment,status,repository_id,source_path,source_branch,target_branch,remote,merge_ref,source_revision,target_revision,target_source,now]).map_err(db_error)?;
    // Commit the recovery evidence before mutating Git. An app interruption can
    // then resume or conservatively abort every post-fetch source state.
    transaction.commit().map_err(db_error)?;
    let merge = Command::new("git")
        .args([
            "-C",
            &source_path,
            "merge",
            "--no-ff",
            "--no-edit",
            &target_revision,
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !merge.status.success() {
        if !has_git_operation(&source_path)? {
            let unchanged = git_output(&source_path, &["rev-parse", "HEAD"])? == source_revision
                && git_output(
                    &source_path,
                    &["status", "--porcelain=v1", "--untracked-files=all"],
                )?
                .is_empty();
            if unchanged {
                connection
                    .execute(
                        "DELETE FROM card_target_merge_operations WHERE card_id=?1",
                        [id],
                    )
                    .map_err(db_error)?;
            }
            return Err(format!("Target merge failed before conflicts could be recorded; the source was not finalized. {}{}", String::from_utf8_lossy(&merge.stderr).trim(), if unchanged { "" } else { " A durable recovery record remains; retry Merge in target & resolve." }));
        }
        // Snapshot every path touched by Git's conflicted merge, including
        // cleanly auto-merged paths. Recovery may discard only this proven set.
        let merge_paths = changed_paths(&source_path)?;
        connection.execute("UPDATE card_target_merge_operations SET phase='conflicted',conflict_paths=?1,updated_at=?2 WHERE id=?3", params![serde_json::to_string(&merge_paths).map_err(|error| error.to_string())?,unix_timestamp(),operation_id]).map_err(db_error)?;
    }
    let operation = load_target_merge_operation(connection, id)?
        .ok_or_else(|| "Could not reload target merge operation".to_string())?;
    current_target_merge_result(connection, &operation)
}

pub(in crate::kanban) async fn kanban_finalize_target_merge_operation(
    id: String,
    operation_id: String,
) -> Result<WorkflowOperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        coordinate_card_repository(&id, true, || {
            with_board_mutation(|connection| finalize_target_merge(connection, &id, &operation_id))
        })
    })
    .await
    .map_err(|error| format!("Target merge finalization worker failed: {error}"))?
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
    if has_git_operation(&operation.source_path)? {
        return Err("The target merge still has unresolved conflicts. Resolve and commit the existing merge before retrying".to_string());
    }
    if !git_output(
        &operation.source_path,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )?
    .is_empty()
    {
        return Err("The worktree is not clean after conflict resolution. Stage and commit only the merge resolutions before retrying".to_string());
    }
    if !git_status_success(
        &operation.source_path,
        &[
            "merge-base",
            "--is-ancestor",
            &operation.target_revision,
            "HEAD",
        ],
    )? {
        return Err(format!(
            "The exact selected {} target revision is not contained in the source branch",
            operation.target_source
        ));
    }
    let head = git_output(&operation.source_path, &["rev-parse", "HEAD"])?;
    let parents = git_output(
        &operation.source_path,
        &["rev-list", "--parents", "-n", "1", "HEAD"],
    )?;
    let expected = format!(
        "{head} {} {}",
        operation.source_revision, operation.target_revision
    );
    if parents != expected {
        return Err("The completed commit does not have the expected explicit merge topology. Do not rebase, squash, or replace the existing merge".to_string());
    }
    let transaction = connection
        .savepoint()
        .map_err(db_error)?;
    let (status, current_revision): (String, i64) = transaction
        .query_row(
            "SELECT status,workflow_revision FROM kanban_cards WHERE id=?1",
            [card_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
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
            |row| row.get(0),
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
    transaction.execute("UPDATE card_environments SET source_revision=?1,target_revision=?2,revision=revision+1,updated_at=?3 WHERE id=?4 AND revision=?5", params![head,operation.target_revision,now,operation.environment_id,operation.environment_revision]).map_err(db_error)?;
    if transition.from != transition.to {
        let changed = transaction.execute("UPDATE kanban_cards SET status=?1,delivery_error=NULL,workflow_revision=workflow_revision+1,updated_at=?2,sort_order=(SELECT COALESCE(MAX(sort_order),-1)+1 FROM kanban_cards d WHERE d.status=?1) WHERE id=?3 AND workflow_revision=?4", params![transition.to,now,card_id,current_revision]).map_err(db_error)?;
        if changed != 1 {
            return Err("Card changed while finalizing the target merge".to_string());
        }
    } else {
        transaction.execute("UPDATE kanban_cards SET delivery_error=NULL,updated_at=?1 WHERE id=?2 AND workflow_revision=?3", params![now,card_id,current_revision]).map_err(db_error)?;
    }
    transaction.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,from_status,to_status,summary) VALUES (?1,?2,'user','merge_target','success',?3,?4,?5)", params![card_id,now,transition.from,transition.to,format!("Selected {} target branch {} was merged with an explicit merge commit", operation.target_source, operation.target_branch)]).map_err(db_error)?;
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
        message: format!(
            "Successfully merged with {} {}",
            operation.target_source, operation.target_branch
        ),
        idempotent: false,
    })
}

pub(in crate::kanban) async fn kanban_abort_target_merge_operation(
    id: String,
    operation_id: String,
) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        coordinate_card_repository(&id, true, || {
            with_board_mutation(|connection| abort_target_merge(connection, &id, &operation_id))
        })
    })
    .await
    .map_err(|error| format!("Target merge recovery worker failed: {error}"))?
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
                .filter(|line| !line.is_empty())
                .map(str::to_string),
        );
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

pub(in crate::kanban) fn abort_target_merge(
    connection: &mut Connection,
    card_id: &str,
    operation_id: &str,
) -> Result<KanbanCard, String> {
    let operation = load_target_merge_operation(connection, card_id)?
        .ok_or_else(|| "No target merge is pending for this card".to_string())?;
    if operation.id != operation_id {
        return Err("The target merge operation changed; manual recovery is required".to_string());
    }
    let head = git_output(&operation.source_path, &["rev-parse", "HEAD"])?;
    if has_git_operation(&operation.source_path)? {
        if head != operation.source_revision {
            return Err("The source revision changed during the conflicted merge. Stacks cannot prove an abort is safe; recover it manually".to_string());
        }
        let changed = changed_paths(&operation.source_path)?;
        if changed
            .iter()
            .any(|path| !operation.conflict_paths.contains(path))
        {
            return Err("The worktree contains changes outside the recorded conflicts. Stacks will not discard them; recover the merge manually".to_string());
        }
        git_output(&operation.source_path, &["merge", "--abort"])?;
    } else if head != operation.source_revision {
        let parents = git_output(
            &operation.source_path,
            &["rev-list", "--parents", "-n", "1", "HEAD"],
        )?;
        let expected = format!(
            "{head} {} {}",
            operation.source_revision, operation.target_revision
        );
        if parents != expected
            || !git_output(
                &operation.source_path,
                &["status", "--porcelain=v1", "--untracked-files=all"],
            )?
            .is_empty()
        {
            return Err("The completed source state is not the exact clean merge created by this operation. Stacks will not reset it; recover manually".to_string());
        }
        git_output(
            &operation.source_path,
            &["reset", "--hard", &operation.source_revision],
        )?;
    } else if !git_output(
        &operation.source_path,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )?
    .is_empty()
    {
        return Err(
            "The source has unrelated changes. Stacks will not discard them; recover manually"
                .to_string(),
        );
    }
    if git_output(&operation.source_path, &["rev-parse", "HEAD"])? != operation.source_revision
        || !git_output(
            &operation.source_path,
            &["status", "--porcelain=v1", "--untracked-files=all"],
        )?
        .is_empty()
    {
        return Err(
            "Automatic recovery could not restore the clean starting revision; recover manually"
                .to_string(),
        );
    }
    connection
        .execute(
            "DELETE FROM card_target_merge_operations WHERE id=?1",
            [operation_id],
        )
        .map_err(db_error)?;
    get_card(connection, card_id)?.ok_or_else(|| "Kanban card was not found".to_string())
}
