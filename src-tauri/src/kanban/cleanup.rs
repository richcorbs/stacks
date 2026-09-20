use super::*;
#[allow(unused_imports)]
use super::{
    cards::*, domain::*, environment::*, git_effects::*, github_delivery::*, health::*,
    local_delivery::*, repository::*, sync::*,
};

pub(in crate::kanban) const CLEANUP_PHASES: [&str; 7] = [
    "validate_repository",
    "runtime_sessions",
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
    #[allow(dead_code)]
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
    pub(in crate::kanban) override_authorized: bool,
    pub(in crate::kanban) registration_validated: bool,
}

pub(in crate::kanban) fn cleanup_preflight(
    card_id: &str,
    pty_registry: &Mutex<PtyRegistry>,
    pi_registry: &Mutex<PiRpcRegistry>,
) -> Result<CleanupPreflight, String> {
    #[allow(clippy::type_complexity)]
    let row: (
        String,
        String,
        String,
        String,
        Option<String>,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
        String,
        i64,
        Option<String>,
        Option<String>,
        bool,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = with_read_connection(|connection| {
        connection.query_row(
            "SELECT c.title,c.status,COALESCE(c.completion_outcome,''),c.project_id,c.delivery_operation_stage,c.workflow_revision,
                    e.id,e.worktree_path,e.branch,e.repository_id,p.name,p.path,COALESCE(p.target_branch,'main'),COALESCE(e.revision,0),
                    e.target_checkout_path,e.target_branch,e.source_revision,
                    pr.repository,CAST(pr.number AS TEXT),pr.state,pr.head_revision
             FROM kanban_cards c JOIN projects p ON p.id=c.project_id
             LEFT JOIN card_environments e ON e.card_id=c.id
             LEFT JOIN card_pull_requests pr ON pr.card_id=c.id WHERE c.id=?1",
            [card_id],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?,r.get(11)?,r.get(12)?,r.get(13)?,r.get(14)?,r.get(15)?,r.get::<_,Option<String>>(16)?.is_some(),r.get(17)?,r.get(18)?,r.get(19)?,r.get(20)?)),
        ).map_err(db_error)
    })?;
    let (
        title,
        status,
        outcome,
        project_id,
        delivery_stage,
        workflow_revision,
        environment_id,
        source_path,
        source_branch,
        recorded_repository,
        project_name,
        project_path,
        configured_branch,
        environment_revision,
        recorded_target_path,
        recorded_target_branch,
        has_source_revision,
        pr_repository,
        pr_number,
        pr_state,
        pr_head,
    ) = row;
    let card_number = with_read_connection(|connection| {
        connection.query_row("SELECT external_id FROM kanban_cards WHERE id=?1", [card_id], |r| r.get::<_, String>(0)).map_err(db_error)
    })?;
    let source_revision = with_read_connection(|connection| {
        connection
            .query_row(
                "SELECT source_revision FROM card_environments WHERE card_id=?1",
                [card_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()
            .map(|v| v.flatten())
            .map_err(db_error)
    })?;
    let cleanup_state: Option<(String, String, bool)> = with_read_connection(|connection| {
        connection.query_row("SELECT status,phase,registration_validated FROM card_cleanup_operations WHERE card_id=?1", [card_id], |r| Ok((r.get(0)?,r.get(1)?,r.get::<_,i64>(2)? != 0))).optional().map_err(db_error)
    })?;
    let mut report = CleanupPreflight {
        card_id: card_id.to_string(),
        card_number,
        card_title: title,
        project_id,
        project_name,
        completion_outcome: outcome.clone(),
        workflow_revision,
        environment_revision,
        merged: false,
        blocked: true,
        override_available: false,
        has_resources: environment_id.is_some() || cleanup_state.as_ref().is_some_and(|v| v.0 != "completed"),
        eligible: false,
        state: cleanup_state
            .as_ref()
            .map(|v| v.0.clone())
            .unwrap_or_else(|| "pending_cleanup".into()),
        repository_id: recorded_repository.clone(),
        primary_checkout: Some(project_path.clone()),
        recorded_target_branch,
        current_target_branch: None,
        target_revision: None,
        source_path: source_path.clone(),
        source_exists: false,
        source_registered: false,
        source_branch: source_branch.clone(),
        source_clean: None,
        source_head: None,
        source_revision: source_revision.clone(),
        source_git_operation: None,
        merge_proof: "unproven".into(),
        local_branch_disposition: "retained".into(),
        remote_branch_disposition: "not required".into(),
        resources: Vec::new(),
        metadata: Vec::new(),
        blockers: Vec::new(),
        retained: Vec::new(),
        orphan_warning: None,
    };
    if cleanup_state.as_ref().is_some_and(|v| v.0 == "completed") {
        report.state = "completed".into();
        report.has_resources = false;
        report.blocked = false;
        report.merge_proof = "retained audit evidence".into();
        return Ok(report);
    }
    // Environment deletion and phase advancement are separate durable commits.
    // Persisted registration proof makes this absence expected and retryable.
    if environment_id.is_none()
        && cleanup_state.as_ref().is_some_and(|(_, phase, validated)| {
            *validated && matches!(phase.as_str(), "remove_metadata" | "record_completion")
        })
    {
        let durable: (String,String,String,String,String,String,Option<String>) = with_read_connection(|connection| connection.query_row(
            "SELECT repository_id,source_path,target_path,source_branch,target_branch,source_revision,merged_pr_head_revision FROM card_cleanup_operations WHERE card_id=?1",
            [card_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)),
        ).map_err(db_error))?;
        report.repository_id = Some(durable.0.clone());
        report.source_path = Some(durable.1);
        report.primary_checkout = Some(durable.2.clone());
        report.source_branch = Some(durable.3);
        report.current_target_branch = Some(durable.4);
        report.source_revision = Some(durable.5.clone());
        report.merged = durable.6.as_deref() == Some(durable.5.as_str())
            || git_status_success(&durable.2, &["merge-base", "--is-ancestor", &durable.5, "HEAD"]).unwrap_or(false);
        report.eligible = false;
        report.blocked = true;
        report.override_available = report.merged && status == "done";
        report.merge_proof = if report.merged { "durable exact-revision proof revalidated".into() } else { "unproven".into() };
        report.metadata = vec!["cleanup metadata".into()];
        report.blockers.push(if report.merged { "Only cleanup metadata remains.".into() } else { "Exact source revision is not authoritatively merged.".into() });
        if status != "done" {
            report.blockers.push("Only Done cards can resume cleanup.".into());
            report.override_available = false;
        }
        return Ok(report);
    }
    if status != "done" {
        report
            .blockers
            .push("Only Done cards are eligible for cleanup.".into());
    }
    if environment_id.is_none()
        || source_path.is_none()
        || source_branch.is_none()
        || !has_source_revision
    {
        report
            .blockers
            .push("The card environment lacks immutable source identity evidence.".into());
        return Ok(report);
    }
    let source_path_value = source_path.as_deref().unwrap();
    let source_branch_value = source_branch.as_deref().unwrap();
    let mut effective_revision = source_revision.clone().unwrap_or_default();
    report.metadata = vec![
        "card environment".into(),
        "terminal layout and panes".into(),
        "service definitions".into(),
        "Pi lifecycle metadata".into(),
    ];
    for id in crate::pty::card_pty_runtime_ids(pty_registry, card_id)? {
        report.resources.push(CleanupResource {
            resource_type: "PTY".into(),
            id,
            disposition: "stop".into(),
        });
    }
    for id in crate::pi_rpc::card_pi_runtime_ids(pi_registry, card_id)? {
        report.resources.push(CleanupResource {
            resource_type: "Pi".into(),
            id,
            disposition: "delete".into(),
        });
    }
    let target = match validate_target_checkout(&project_path, recorded_repository.as_deref()) {
        Ok(target) => {
            report.repository_id = Some(target.repository_id.clone());
            report.current_target_branch = Some(target.target_branch.clone());
            report.target_revision = Some(target.target_revision.clone());
            if target.target_branch != configured_branch {
                report.blockers.push(format!("Primary checkout is on {}, but project configuration requires {}. Check out the configured target branch.", target.target_branch, configured_branch));
            }
            Some(target)
        }
        Err(error) => {
            report.blockers.push(format!("Primary checkout: {error}"));
            None
        }
    };
    report.source_exists = Path::new(source_path_value).exists();
    if !report.source_exists {
        // A missing worktree is reconciled from the exact local branch tip. It
        // is not itself a safety failure; the branch and metadata may remain.
    } else {
        let status_output = git_output(
            source_path_value,
            &["status", "--porcelain=v1", "--untracked-files=all"],
        );
        report.source_clean = status_output.as_ref().ok().map(|v| v.is_empty());
        if report.source_clean == Some(false) {
            report.blockers.push(
                "Source worktree is dirty. Commit, stash, or discard its changes before cleanup."
                    .into(),
            );
        }
        report.source_git_operation = has_git_operation(source_path_value).ok();
        if report.source_git_operation == Some(true) {
            report.blockers.push(
                "Source worktree has an active Git operation. Finish or abort it before cleanup."
                    .into(),
            );
        }
        match git_output(
            source_path_value,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
        ) {
            Ok(branch) if branch == source_branch_value => {}
            Ok(branch) => report.blockers.push(format!(
                "Source worktree is on {branch}, expected {source_branch_value}."
            )),
            Err(_) => report.blockers.push(
                "Source worktree is detached; restore its recorded branch before cleanup.".into(),
            ),
        }
        match git_output(source_path_value, &["rev-parse", "HEAD"]) {
            Ok(head) => {
                effective_revision = head.clone();
                report.source_revision = Some(head.clone());
                report.source_head = Some(head);
            }
            Err(error) => report
                .blockers
                .push(format!("Source HEAD could not be inspected: {error}")),
        }
        if let Some(target) = &target {
            match ensure_registered_distinct_worktree(&project_path, source_path_value) {
                Ok(()) => report.source_registered = true,
                Err(_) => {
                    report.orphan_warning = Some("The recorded Stacks-owned path is no longer a registered worktree.".into());
                    report.blockers.push("Source path is not a registered worktree.".into());
                }
            }
            if repository_identity(source_path_value).ok().as_deref()
                != Some(target.repository_id.as_str())
            {
                report
                    .blockers
                    .push("Source worktree belongs to another repository.".into());
            }
            if Path::new(source_path_value).canonicalize().ok()
                == Path::new(&project_path).canonicalize().ok()
            {
                report.blockers.push(
                    "Source worktree is the configured primary checkout and cannot be removed."
                        .into(),
                );
            }
        }
    }
    if let Ok(Some(tip)) = local_ref_tip(&project_path, source_branch_value) {
        if report.source_exists && report.source_head.as_deref() != Some(tip.as_str()) {
            report.blockers.push("Local source branch and worktree tips differ.".into());
        } else {
            effective_revision = tip.clone();
            report.source_revision = Some(tip);
        }
    } else if report.source_exists {
        report.blockers.push("Recorded local source branch is absent.".into());
    } else {
        report.blockers.push("Only cleanup metadata remains.".into());
    }
    if let Some(target) = &target {
        let ancestor = git_status_success(
            &project_path,
            &["merge-base", "--is-ancestor", &effective_revision, "HEAD"],
        )
        .unwrap_or(false);
        let github_repository = crate::github::repository_name(&project_path).ok();
        let pr_matches = pr_state.as_deref() == Some("merged")
            && pr_head.as_deref() == Some(effective_revision.as_str())
            && pr_repository
                .as_ref()
                .is_some_and(|repo| github_repository.as_deref() == Some(repo.as_str()));
        let target_reconciled = recorded_target_path.as_deref()
            != Some(target.target_checkout_path.as_str())
            || report.recorded_target_branch.as_deref() != Some(configured_branch.as_str());
        if target_reconciled && !ancestor {
            report.blockers.push("Recorded target changed and the exact source revision is not an ancestor of the configured target; Stacks will not reinterpret unmerged work.".into());
        }
        report.merged = ancestor || pr_matches;
        if ancestor {
            report.merge_proof = format!("Exact source revision is an ancestor of {} at {}", configured_branch, target.target_revision);
        } else if pr_matches {
            report.merge_proof = format!("Merged PR #{} in {} has exact head revision", pr_number.unwrap_or_default(), pr_repository.clone().unwrap_or_default());
        } else {
            report.blockers.push("Exact source revision is not authoritatively merged.".into());
        }
        report.local_branch_disposition = "delete only with exact-tip lease and valid merge proof".into();
        if outcome != "merged" && outcome != "closed" {
            report.blockers.push("Done card has no recognized completion outcome.".into());
        }
        if delivery_stage.as_deref() == Some("deleting_remote_branch") {
            report.remote_branch_disposition =
                "delete required by delivery workflow with exact remote-tip lease".into();
            if !pr_matches {
                report.blockers.push("Required remote deletion needs matching merged-PR repository, number, and exact head revision evidence.".into());
            }
            let remote_ref = format!("refs/heads/{source_branch_value}");
            match git_output(&project_path, &["ls-remote","--heads","origin",&remote_ref]) {
                Ok(value) if value.is_empty() => report.remote_branch_disposition = "already absent".into(),
                Ok(value) if value.split_whitespace().next() == Some(effective_revision.as_str()) => {}
                Ok(_) => report.blockers.push("Remote branch tip changed; it is retained and cannot be deleted with the captured lease.".into()),
                Err(error) => report.blockers.push(format!("Required remote branch cannot be verified: {error}")),
            }
        } else {
            report
                .retained
                .push("Remote branch (delivery workflow did not require deletion)".into());
        }
    }
    report.override_available = report.merged && !report.blockers.is_empty() && report.blockers.iter().all(|blocker| {
        blocker.starts_with("Source worktree is dirty")
            || blocker.starts_with("Source worktree has an active Git operation")
            || blocker == "Source path is not a registered worktree."
            || blocker == "Only cleanup metadata remains."
    });
    report.blocked = !report.blockers.is_empty();
    report.eligible = !report.blocked;
    Ok(report)
}

fn refresh_cleanup_pr_evidence(id: &str) -> Option<String> {
    let workflow = with_read_connection(|connection| {
        connection.query_row("SELECT p.delivery_workflow FROM kanban_cards c JOIN projects p ON p.id=c.project_id WHERE c.id=?1", [id], |r| r.get::<_,String>(0)).map_err(db_error)
    });
    if workflow.as_deref() != Ok("github_pull_request") {
        return None;
    }
    with_board_mutation(|connection| refresh_pull_request(connection, id).map(|_| ())).err()
}

pub(in crate::kanban) async fn kanban_cleanup_preflight_operation(
    app: AppHandle,
    id: String,
) -> Result<CleanupPreflight, String> {
    let refresh_error = refresh_cleanup_pr_evidence(&id);
    let pty = app.state::<Mutex<PtyRegistry>>();
    let pi = app.state::<Mutex<PiRpcRegistry>>();
    let mut report = cleanup_preflight(&id, pty.inner(), pi.inner())?;
    if let Some(error) = refresh_error.filter(|_| !report.merged) {
        report.blockers.push(format!("Merged-PR evidence could not be refreshed: {error}"));
        report.eligible = false;
        report.blocked = true;
        report.override_available = false;
    }
    Ok(report)
}

pub(in crate::kanban) async fn kanban_cleanup_inventory_operation(
    app: AppHandle,
    project_id: Option<String>,
) -> Result<CleanupInventory, String> {
    let ids = with_read_connection(|connection| {
        let mut statement = connection.prepare("SELECT c.id FROM kanban_cards c WHERE c.status='done' AND (?1 IS NULL OR c.project_id=?1) AND (EXISTS(SELECT 1 FROM card_environments e WHERE e.card_id=c.id) OR EXISTS(SELECT 1 FROM card_cleanup_operations o WHERE o.card_id=c.id)) ORDER BY c.project_id,c.updated_at DESC").map_err(db_error)?;
        let rows = statement
            .query_map([project_id], |r| r.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    })?;
    let pty = app.state::<Mutex<PtyRegistry>>();
    let pi = app.state::<Mutex<PiRpcRegistry>>();
    let mut entries = Vec::new();
    for id in ids {
        let refresh_error = refresh_cleanup_pr_evidence(&id);
        let mut report = cleanup_preflight(&id, pty.inner(), pi.inner())?;
        if let Some(error) = refresh_error.filter(|_| !report.merged) {
            report.blockers.push(format!("Merged-PR evidence could not be refreshed: {error}"));
            report.eligible = false;
            report.blocked = true;
            report.override_available = false;
        }
        if report.has_resources {
            entries.push(report);
        }
    }
    Ok(CleanupInventory {
        eligible_merged: entries
            .iter()
            .filter(|e| e.merged && !e.blocked)
            .count(),
        blocked: entries
            .iter()
            .filter(|e| e.blocked)
            .count(),
        closed: 0,
        completed: 0,
        entries,
    })
}

pub(in crate::kanban) async fn kanban_cleanup_environment_operation(
    app: AppHandle,
    id: String,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
    expected_source_revision: Option<String>,
    expected_target_revision: Option<String>,
    expected_repository_id: Option<String>,
    expected_primary_checkout: Option<String>,
    expected_target_branch: Option<String>,
    cleanup_anyway: bool,
) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pty_registry = app.state::<Mutex<PtyRegistry>>();
        let pi_registry = app.state::<Mutex<PiRpcRegistry>>();
        let contract = cleanup_preflight(&id, pty_registry.inner(), pi_registry.inner())?;
        if contract.source_revision != expected_source_revision
            || contract.target_revision != expected_target_revision
            || contract.repository_id != expected_repository_id
            || contract.primary_checkout != expected_primary_checkout
            || contract.current_target_branch != expected_target_branch
        {
            return Err("Repository state changed after cleanup preflight; inspect it again".into());
        }
        run_cleanup(
            &id,
            expected_workflow_revision,
            expected_environment_revision,
            expected_source_revision.as_deref().unwrap_or_default(),
            cleanup_anyway,
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
    effective_revision: &str,
    cleanup_anyway: bool,
    pty_registry: &Mutex<PtyRegistry>,
    pi_registry: &Mutex<PiRpcRegistry>,
) -> Result<KanbanCard, String> {
    coordinate_card_repository(id, true, || {
        let preflight = cleanup_preflight(id, pty_registry, pi_registry)?;
        let persisted_override = with_read_connection(|connection| connection.query_row(
            "SELECT override_authorized FROM card_cleanup_operations WHERE card_id=?1", [id], |row| row.get::<_, i64>(0),
        ).optional().map(|value| value == Some(1)).map_err(db_error))?;
        let authorized = cleanup_anyway || persisted_override;
        if preflight.blocked && !(authorized && preflight.override_available) {
            return Err("Cleanup is blocked and cannot run without an available explicit override".into());
        }
        if preflight.workflow_revision != expected_workflow_revision
            || preflight.environment_revision != expected_environment_revision
        {
            return Err(
                "Card or environment changed after cleanup preflight; inspect it again".to_string(),
            );
        }
        initialize_cleanup(
            id,
            expected_workflow_revision,
            expected_environment_revision,
            effective_revision,
            cleanup_anyway,
            preflight.merged,
        )?;
        loop {
            let operation =
                with_read_connection(|connection| load_cleanup_snapshot(connection, id))?;
            if operation.status == "completed" {
                return with_read_connection(|connection| {
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
    })
}

pub(in crate::kanban) fn initialize_cleanup(
    card_id: &str,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
    effective_revision: &str,
    cleanup_anyway: bool,
    authoritatively_merged: bool,
) -> Result<(), String> {
    with_board_mutation(|connection| {
        if connection
            .query_row(
                "SELECT COUNT(*) FROM card_cleanup_operations WHERE card_id=?1",
                [card_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(db_error)?
            > 0
        {
            if cleanup_anyway {
                connection.execute("UPDATE card_cleanup_operations SET override_authorized=1,updated_at=?1 WHERE card_id=?2 AND override_authorized=0", params![unix_timestamp(), card_id]).map_err(db_error)?;
            }
            return Ok(());
        }
        let transaction = connection.savepoint().map_err(db_error)?;
        require_structural_capability(&transaction, card_id, WorkflowAction::Cleanup)?;
        let (_status, outcome, workflow_revision, delivery_stage): (String, Option<String>, i64, Option<String>) = transaction.query_row(
            "SELECT status, completion_outcome, workflow_revision, delivery_operation_stage FROM kanban_cards WHERE id=?1", [card_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).map_err(db_error)?;
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
        let (environment_id, _project_id, source_path, source_branch, repository_id, target_path, target_branch, source_revision, environment_revision): (String, String, String, String, Option<String>, String, String, Option<String>, i64) = transaction.query_row(
            "SELECT e.id,e.project_id,e.worktree_path,e.branch,e.repository_id,p.path,COALESCE(p.target_branch,'main'),e.source_revision,e.revision FROM card_environments e JOIN kanban_cards c ON c.id=e.card_id JOIN projects p ON p.id=c.project_id WHERE e.card_id=?1", [card_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?)),
        ).map_err(db_error)?;
        if environment_revision != expected_environment_revision {
            return Err("Card environment changed; reload before cleanup".to_string());
        }
        let repository_id = repository_id
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Cleanup requires a recorded repository identity".to_string())?;
        let _recorded_source_revision = source_revision
            .ok_or_else(|| "Cleanup requires a recorded source revision".to_string())?;
        if effective_revision.is_empty() || !authoritatively_merged {
            return Err("Cleanup requires an exact authoritatively merged revision".to_string());
        }
        let source_revision = effective_revision.to_string();
        let target_revision = git_output(&target_path, &["rev-parse", "HEAD"])?;
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
        let delete_remote = delivery_stage.as_deref() == Some("deleting_remote_branch");
        let delete_local = authoritatively_merged;
        let (recorded_target_path, recorded_target_branch): (Option<String>, Option<String>) =
            transaction
                .query_row(
                    "SELECT target_checkout_path,target_branch FROM card_environments WHERE id=?1",
                    [&environment_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(db_error)?;
        transaction.execute(
            "INSERT INTO card_cleanup_operations (card_id,environment_id,workflow_revision,environment_revision,status,phase,completion_outcome,repository_id,source_path,target_path,source_branch,target_branch,source_revision,target_revision,delete_local_branch,delete_remote_branch,merged_pr_repository,merged_pr_number,merged_pr_head_revision,pane_ids,override_authorized,started_at,updated_at)
             VALUES (?1,?2,?3,?4,'pending','validate_repository',?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?20)",
            params![card_id, environment_id, workflow_revision, environment_revision, outcome, repository_id, source_path, target_path, source_branch, target_branch, source_revision, target_revision, delete_local as i64, delete_remote as i64, pr_repository, pr_number, pr_head, pane_ids, cleanup_anyway as i64, now],
        ).map_err(db_error)?;
        let ancestry = git_status_success(
            &target_path,
            &["merge-base", "--is-ancestor", &source_revision, "HEAD"],
        )?;
        let proof_type = if ancestry { "ancestry" } else { "merged_pr" };
        let proof_detail = if ancestry {
            format!(
                "{} is an ancestor of {} at {}",
                source_revision, target_branch, target_revision
            )
        } else {
            format!("Merged PR evidence captured for exact head {}", source_revision)
        };
        let remote_tip = if delete_remote {
            git_output(
                &target_path,
                &[
                    "ls-remote",
                    "--heads",
                    "origin",
                    &format!("refs/heads/{source_branch}"),
                ],
            )
            .ok()
            .and_then(|v| v.split_whitespace().next().map(str::to_string))
        } else {
            None
        };
        let metadata_inventory = serde_json::to_string(&vec![
            "card environment",
            "terminal layout and panes",
            "service definitions",
            "Pi lifecycle metadata",
        ])
        .map_err(|e| e.to_string())?;
        transaction.execute(
            "INSERT INTO card_cleanup_evidence(card_id,recorded_target_path,recorded_target_branch,reconciled_target_path,reconciled_target_branch,merge_proof_type,merge_proof_detail,local_branch_disposition,remote_branch_disposition,remote_name,remote_tip,runtime_inventory,metadata_inventory,captured_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![card_id,recorded_target_path,recorded_target_branch,target_path,target_branch,proof_type,proof_detail,if delete_local { "delete_exact_tip" } else { "retain" },if delete_remote { "delete_exact_lease" } else { "retain" },if delete_remote { Some("origin") } else { None },remote_tip,pane_ids,metadata_inventory,now]
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
        "SELECT card_id,environment_id,workflow_revision,environment_revision,status,phase,completion_outcome,repository_id,source_path,target_path,source_branch,target_branch,source_revision,delete_local_branch,delete_remote_branch,merged_pr_head_revision,pane_ids,override_authorized,registration_validated FROM card_cleanup_operations WHERE card_id=?1",
        [card_id], |row| {
            let pane_json: String = row.get(16)?;
            Ok(CleanupSnapshot {
                card_id: row.get(0)?, environment_id: row.get(1)?, workflow_revision: row.get(2)?, environment_revision: row.get(3)?,
                status: row.get(4)?, phase: row.get(5)?, completion_outcome: row.get(6)?, repository_id: row.get(7)?,
                source_path: row.get(8)?, target_path: row.get(9)?, source_branch: row.get(10)?, target_branch: row.get(11)?, source_revision: row.get(12)?,
                delete_local_branch: row.get::<_, i64>(13)? != 0, delete_remote_branch: row.get::<_, i64>(14)? != 0,
                merged_pr_head_revision: row.get(15)?, pane_ids: serde_json::from_str(&pane_json).unwrap_or_default(),
                override_authorized: row.get::<_, i64>(17)? != 0, registration_validated: row.get::<_, i64>(18)? != 0,
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
    validate_cleanup_target(operation)?;
    validate_target_checkout(&operation.target_path, Some(&operation.repository_id))?;
    let merged_by_pr = operation.merged_pr_head_revision.as_deref() == Some(&operation.source_revision);
    let merged_by_ancestry = git_status_success(&operation.target_path, &["merge-base", "--is-ancestor", &operation.source_revision, "HEAD"])?;
    if !merged_by_pr && !merged_by_ancestry {
        return Err("The exact cleanup revision is not authoritatively merged".into());
    }
    if Path::new(&operation.source_path).exists() {
        let metadata = std::fs::symlink_metadata(&operation.source_path).map_err(|error| format!("Could not inspect source path: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Cleanup refuses to remove a symlinked source path".into());
        }
        let source_path = Path::new(&operation.source_path).canonicalize().map_err(|error| format!("Source path is unavailable: {error}"))?;
        let target_path = Path::new(&operation.target_path).canonicalize().map_err(|error| format!("Primary checkout is unavailable: {error}"))?;
        if source_path == target_path {
            return Err("Cleanup refuses to remove the primary checkout".into());
        }
        if repository_identity(&operation.source_path)? != operation.repository_id {
            return Err("Source path belongs to an unrelated repository".into());
        }
        let source_branch = git_output(&operation.source_path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .map_err(|_| "Source checkout is detached".to_string())?;
        let source_revision = git_output(&operation.source_path, &["rev-parse", "HEAD"])?;
        if source_branch != operation.source_branch || source_revision != operation.source_revision {
            return Err("Source branch or worktree tip changed after cleanup intent was recorded".into());
        }
        let registered = ensure_registered_distinct_worktree(&operation.target_path, &operation.source_path).is_ok();
        if !registered && !operation.override_authorized {
            return Err("Source path is no longer a registered worktree".into());
        }
        if !operation.override_authorized {
            if !git_output(&operation.source_path, &["status", "--porcelain=v1", "--untracked-files=all"])?.is_empty() {
                return Err("Source worktree became dirty before cleanup".into());
            }
            if has_git_operation(&operation.source_path)? {
                return Err("Source worktree has an active Git operation".into());
            }
        }
    }
    match local_ref_tip(&operation.target_path, &operation.source_branch)? {
        Some(tip) if tip == operation.source_revision => Ok(()),
        Some(_) => Err("Source branch tip changed after cleanup intent was recorded".into()),
        None if !Path::new(&operation.source_path).exists() => Ok(()),
        None => Err("The recorded source branch is absent before worktree removal".into()),
    }
}

pub(in crate::kanban) fn remove_cleanup_worktree(
    operation: &CleanupSnapshot,
) -> Result<(), String> {
    if Path::new(&operation.source_path).exists() {
        // Repeat all identity, revision, ownership, and primary-checkout checks
        // immediately before either destructive removal mechanism.
        validate_cleanup_repository(operation)?;
        let registered = ensure_registered_distinct_worktree(&operation.target_path, &operation.source_path).is_ok();
        if registered {
            let mut args = vec!["-C", operation.target_path.as_str(), "worktree", "remove"];
            if operation.override_authorized { args.push("--force"); }
            args.extend(["--", operation.source_path.as_str()]);
            let output = Command::new("git").args(args).output().map_err(|error| error.to_string())?;
            if !output.status.success() {
                return Err(format!("Git could not remove the source worktree: {}", String::from_utf8_lossy(&output.stderr).trim()));
            }
        } else {
            if !operation.override_authorized {
                return Err("Unregistered source directory removal was not authorized".into());
            }
            std::fs::remove_dir_all(&operation.source_path).map_err(|error| format!("Could not remove the recorded source directory: {error}"))?;
        }
        return Ok(());
    }
    validate_cleanup_repository(operation)
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
    let configured: Option<(String,String)> = with_read_connection(|connection| {
        connection.query_row("SELECT p.path,COALESCE(p.target_branch,'main') FROM kanban_cards c JOIN projects p ON p.id=c.project_id WHERE c.id=?1", [&operation.card_id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_error)
    })?;
    if let Some((configured_path, configured_branch)) = configured {
        let configured_path = Path::new(&configured_path).canonicalize().map_err(|error| format!("Configured primary checkout is unavailable: {error}"))?;
        let captured = Path::new(&operation.target_path).canonicalize().map_err(|error| format!("Captured primary checkout is unavailable: {error}"))?;
        if configured_path != captured || configured_branch != operation.target_branch {
            return Err("Project primary checkout or target branch changed after cleanup evidence was captured".into());
        }
    }
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
    with_board_mutation(|connection| {
        let transaction = connection.savepoint().map_err(db_error)?;
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
            transaction.execute("DELETE FROM card_pi_lifecycle WHERE card_id=?1", [&operation.card_id]).map_err(db_error)?;
            let updated = transaction.execute("UPDATE kanban_cards SET workflow_revision=workflow_revision+1,updated_at=?1 WHERE id=?2 AND workflow_revision=?3", params![unix_timestamp(), operation.card_id, operation.workflow_revision]).map_err(db_error)?;
            if updated == 0 {
                return Err("Card changed before cleanup metadata removal".to_string());
            }
        }
        transaction.commit().map_err(db_error)
    })
}

pub(in crate::kanban) fn advance_cleanup_phase(operation: &CleanupSnapshot) -> Result<(), String> {
    with_board_mutation(|connection| advance_cleanup_phase_in_connection(connection, operation))
}

pub(in crate::kanban) fn advance_cleanup_phase_in_connection(
    connection: &mut Connection,
    operation: &CleanupSnapshot,
) -> Result<(), String> {
    let transaction = connection.savepoint().map_err(db_error)?;
    if operation.phase == "record_completion" {
        let now = unix_timestamp();
        transaction.execute("INSERT OR REPLACE INTO card_cleanup_phase_outcomes(card_id,phase,outcome,detail,completed_at) VALUES (?1,?2,'success','Cleanup completed',?3)", params![operation.card_id,operation.phase,now]).map_err(db_error)?;
        let changed = transaction.execute("UPDATE card_cleanup_operations SET status='completed',error_code=NULL,error_detail=NULL,completed_at=?1,updated_at=?1 WHERE card_id=?2 AND phase=?3 AND status!='completed'", params![now, operation.card_id, operation.phase]).map_err(db_error)?;
        if changed == 0 {
            return Err("Cleanup operation changed while recording completion".to_string());
        }
        transaction.execute("UPDATE kanban_cards SET delivery_operation_stage=NULL,delivery_error=NULL WHERE id=?1", [&operation.card_id]).map_err(db_error)?;
        transaction.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,summary) VALUES (?1,?2,'user','cleanup','success','Cleanup completed and safely deleted required branches')", params![operation.card_id, now]).map_err(db_error)?;
    } else {
        let next = next_cleanup_phase(&operation.phase)
            .ok_or_else(|| "Unknown or terminal cleanup phase".to_string())?;
        let now = unix_timestamp();
        transaction.execute("INSERT OR REPLACE INTO card_cleanup_phase_outcomes(card_id,phase,outcome,detail,completed_at) VALUES (?1,?2,'success',NULL,?3)", params![operation.card_id,operation.phase,now]).map_err(db_error)?;
        // `runtime_sessions` also implies validation for legacy rows created by
        // the pre-preflight phase order. New operations always validate first.
        let validation = matches!(
            operation.phase.as_str(),
            "validate_repository" | "runtime_sessions"
        ) as i64;
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
    let _ = with_board_mutation(|connection| {
        let transaction = connection.savepoint().map_err(db_error)?;
        transaction.execute("UPDATE card_cleanup_operations SET status='failed',error_code=?1,error_detail=?2,updated_at=?3 WHERE card_id=?4 AND phase=?5", params![code, detail, unix_timestamp(), card_id, phase]).map_err(db_error)?;
        transaction.execute("INSERT OR REPLACE INTO card_cleanup_phase_outcomes(card_id,phase,outcome,detail,completed_at) VALUES (?1,?2,'failure',?3,?4)", params![card_id,phase,detail,unix_timestamp()]).map_err(db_error)?;
        transaction.execute("UPDATE card_environments SET lifecycle_state='cleanup_failed',updated_at=?1 WHERE card_id=?2", params![unix_timestamp(), card_id]).map_err(db_error)?;
        transaction.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,summary,error_code,error_detail) VALUES (?1,?2,'user','cleanup','failure',?3,?4,?5)", params![card_id, unix_timestamp(), format!("Cleanup failed during {phase}"), code, detail]).map_err(db_error)?;
        transaction.commit().map_err(db_error)
    });
}

pub(in crate::kanban) fn feature_environment_title(title: &str) -> String {
    format!("[FE] {}", plain_pull_request_title(title))
}

pub(in crate::kanban) fn plain_pull_request_title(title: &str) -> &str {
    let mut title = title.trim();
    while let Some(rest) = title.strip_prefix("[FE]") {
        title = rest.trim_start();
    }
    title
}

pub(in crate::kanban) fn pull_request_title(title: &str, feature_environment: bool) -> String {
    if feature_environment {
        feature_environment_title(title)
    } else {
        plain_pull_request_title(title).to_string()
    }
}
