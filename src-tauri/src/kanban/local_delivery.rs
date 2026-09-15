use super::*;
use super::{environment::*, git_effects::*, github_delivery::*, health::*, repository::*};

pub(in crate::kanban) async fn kanban_approve_and_commit_operation(
    id: String,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
    feature_environment: Option<bool>,
) -> Result<WorkflowOperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = REPOSITORY_OPERATION_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| "Repository operation lock failed".to_string())?;
        with_connection(|connection| {
            approve_and_commit_with_failure_record(
                connection,
                &id,
                expected_workflow_revision,
                expected_environment_revision,
                feature_environment.unwrap_or(false),
            )
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
    feature_environment: bool,
) -> Result<WorkflowOperationResult, String> {
    let result = approve_and_commit(
        connection,
        id,
        expected_card,
        expected_environment,
        feature_environment,
    );
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
    feature_environment: bool,
) -> Result<WorkflowOperationResult, String> {
    validate_card_environment_project(connection, id)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let (status, card_revision): (String, i64) = transaction
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
    let (source_path, source_branch, repository_id, environment_revision, lifecycle_state): (String, String, Option<String>, i64, String) = transaction
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
    let changed_rows = transaction.execute(
        "UPDATE kanban_cards SET status='approved', feature_environment=CASE WHEN status='approved' THEN feature_environment ELSE ?1 END, delivery_error=NULL, workflow_revision=workflow_revision+1, updated_at=?2,
         sort_order=CASE WHEN status='approved' THEN sort_order ELSE (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards AS destination WHERE destination.status='approved') END
         WHERE id=?3 AND workflow_revision=?4 AND status=?5",
        params![feature_environment as i64, now, id, card_revision, status],
    ).map_err(db_error)?;
    if changed_rows == 0 {
        return Err("Card changed; reload before approving".to_string());
    }
    transaction.execute(
        "UPDATE card_environments SET source_revision=?1, revision=revision+1, updated_at=?2 WHERE card_id=?3 AND revision=?4",
        params![source_tip, now, id, expected_environment],
    ).map_err(db_error)?;
    transaction.execute(
        "INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, from_status, to_status, summary) VALUES (?1, ?2, 'user', 'approve_and_commit', 'success', ?3, 'approved', 'Verified clean source worktree')",
        params![id, now, status],
    ).map_err(db_error)?;
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
        let _guard = REPOSITORY_OPERATION_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| "Repository operation lock failed".to_string())?;
        let result = with_connection(|connection| {
            merge_card(
                connection,
                &id,
                expected_workflow_revision,
                expected_environment_revision,
            )
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
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let (status, card_revision): (String, i64) = transaction
        .query_row(
            "SELECT status, workflow_revision FROM kanban_cards WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Kanban card was not found".to_string())?;
    if status != "approved" {
        return Err("Only a Ready to merge card can be merged".to_string());
    }
    if card_revision != expected_card {
        return Err("Card changed; reload before merging".to_string());
    }
    let (source_path, source_branch, repository_id, target_path, target_branch, recorded_source_revision, environment_revision): (String, String, Option<String>, Option<String>, Option<String>, Option<String>, i64) = transaction.query_row(
        "SELECT worktree_path, branch, repository_id, target_checkout_path, target_branch, source_revision, revision FROM card_environments WHERE card_id=?1", [id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
    ).optional().map_err(db_error)?.ok_or_else(|| "This card has no environment to merge".to_string())?;
    if environment_revision != expected_environment {
        return Err("Card environment changed; reload before merging".to_string());
    }
    let settings = project_delivery_settings(&transaction, id)?;
    if settings.workflow != "local_merge" {
        return Err("This project uses GitHub pull request delivery".to_string());
    }
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
            "The source revision changed after Ship It; ship it again before merging".to_string(),
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
            transaction.execute("INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, error_code, error_detail) VALUES (?1, ?2, 'user', 'merge', 'failure', 'git_merge_failed', ?3)", params![id, unix_timestamp(), detail]).map_err(db_error)?;
            transaction.commit().map_err(db_error)?;
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
    transaction.execute("UPDATE card_environments SET source_revision=?1, target_revision=?2, revision=revision+1, updated_at=?3 WHERE card_id=?4 AND revision=?5", params![source_tip, git_output(&target_path, &["rev-parse", "HEAD"])?, unix_timestamp(), id, expected_environment]).map_err(db_error)?;
    transaction.execute("UPDATE kanban_cards SET status='done', completion_outcome='merged', delivery_error=NULL, workflow_revision=workflow_revision+1, updated_at=?1 WHERE id=?2 AND workflow_revision=?3", params![unix_timestamp(), id, expected_card]).map_err(db_error)?;
    transaction.execute("INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, from_status, to_status, summary) VALUES (?1, ?2, 'user', 'merge', 'success', 'approved', 'done', ?3)", params![id, unix_timestamp(), if already { "Source was already reachable from target" } else { "Created explicit merge commit" }]).map_err(db_error)?;
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
