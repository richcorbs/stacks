//! Evidence and guarded metadata-only repair for Superthread hierarchy state.
//! Orphaned environments are never removed by this path.
use super::*;
use super::{
    git_effects::repository_identity, health::{db_error, unix_timestamp}, repository::with_read_connection,
    superthread_identity::active_superthread_binding,
    superthread_refinement::validate_parent_detail,
};
use crate::superthread::{SuperthreadCard, SuperthreadService};

#[derive(Debug, Clone, Serialize)]
pub struct ParentEnvironmentEvidence {
    id: String,
    project_id: String,
    revision: i64,
    lifecycle: String,
    worktree_path: String,
    branch: String,
    recorded_repository: Option<String>,
    path_exists: bool,
    registered: Option<bool>,
    dirty: Option<bool>,
    local_tip: Option<String>,
    remote_tip: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ParentStatePreflight {
    card_id: String,
    external_id: String,
    project_id: String,
    binding_id: String,
    board_id: String,
    #[serde(skip_serializing)]
    token_env: String,
    #[serde(skip_serializing)]
    workspace_slug: Option<String>,
    workflow_revision: i64,
    record_revision: i64,
    board_revision: i64,
    status: String,
    stored_finalized: bool,
    stored_child_count: i64,
    linked_child_ids: Vec<String>,
    remote_child_ids: Vec<String>,
    remote_child_count: Option<u64>,
    hierarchy_verified: bool,
    environment: Option<ParentEnvironmentEvidence>,
    pty_ids: Vec<String>,
    pi_ids: Vec<String>,
    pull_request_state: Option<String>,
    pending_operations: Vec<String>,
    blockers: Vec<String>,
    uncertainty: Vec<String>,
    repair_available: bool,
}

struct ParentIdentity {
    external_id: String,
    project_id: String,
    binding_id: String,
    board_id: String,
    token_env: String,
    workspace_slug: Option<String>,
}

fn environment_identity(
    e: &ParentEnvironmentEvidence,
) -> (&str, &str, i64, &str, &str, &str, Option<&str>) {
    (
        &e.id,
        &e.project_id,
        e.revision,
        &e.lifecycle,
        &e.worktree_path,
        &e.branch,
        e.recorded_repository.as_deref(),
    )
}

fn inspect_local(
    connection: &Connection,
    id: &str,
) -> Result<(ParentIdentity, ParentStatePreflight), String> {
    let (external_id, provider, project_id, binding, board, status, revision, record_revision,
        finalized, count, source, configured_board, token, slug):
        (String, String, String, Option<String>, String, String, i64, i64, bool, i64, String, String, String, Option<String>) =
        connection.query_row(
            "SELECT c.external_id,c.external_provider,c.project_id,c.binding_id,c.board_id,c.status,
                    c.workflow_revision,c.record_revision,c.hierarchy_finalized,c.provider_child_count,
                    COALESCE(p.kanban_source,'local'),COALESCE(p.superthread_board_id,''),
                    COALESCE(p.superthread_api_token_env_var,'ST_TOKEN'),p.superthread_workspace_slug
             FROM kanban_cards c JOIN projects p ON p.id=c.project_id WHERE c.id=?1",
            [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,
                row.get(5)?,row.get(6)?,row.get(7)?,row.get::<_,i64>(8)? != 0,row.get(9)?,
                row.get(10)?,row.get(11)?,row.get(12)?,row.get(13)?)),
        ).optional().map_err(db_error)?.ok_or_else(|| "Card or owning project was not found".to_string())?;
    if provider != "superthread" || source != "superthread" {
        return Err(
            "Only a Superthread card owned by a Superthread project can be inspected".into(),
        );
    }
    let active_binding = active_superthread_binding(connection, &project_id)?;
    let mut blockers = Vec::new();
    if binding.as_deref() != Some(active_binding.as_str()) {
        blockers
            .push("The card binding does not match the active validated project binding".into());
    }
    if configured_board.is_empty() || board != configured_board {
        blockers
            .push("The stored card board does not match the configured Superthread board".into());
    }
    let mut linked_child_ids = connection.prepare(
        "SELECT external_id FROM kanban_cards WHERE parent_id=?1 AND binding_id=?2 ORDER BY external_id",
    ).map_err(db_error)?.query_map(params![id, active_binding], |row| row.get::<_,String>(0))
        .map_err(db_error)?.collect::<Result<Vec<_>,_>>().map_err(db_error)?;
    let invalid_children: i64 = connection.query_row(
        "SELECT COUNT(*) FROM kanban_cards WHERE parent_id=?1 AND (project_id IS NULL OR project_id!=?2 OR board_id!=?3 OR external_provider!='superthread' OR in_scope!=1 OR external_id='' OR binding_id IS NULL OR binding_id!=?4)",
        params![id, project_id, configured_board, active_binding], |row| row.get(0),
    ).map_err(db_error)?;
    if invalid_children != 0 { blockers.push("Linked child ownership, board, provider or scope is inconsistent".into()); }
    let parent_link: Option<String> = connection.query_row("SELECT parent_id FROM kanban_cards WHERE id=?1", [id], |row| row.get(0)).map_err(db_error)?;
    if parent_link.is_some() { blockers.push("A linked child cannot be repaired as an aggregate root".into()); }
    linked_child_ids.sort();
    if linked_child_ids.windows(2).any(|pair| pair[0] == pair[1]) {
        blockers.push("Duplicate local child identities are ambiguous".into());
    }
    let foreign_links: i64 = connection.query_row(
        "SELECT COUNT(*) FROM kanban_cards WHERE parent_id=?1 AND (binding_id IS NULL OR binding_id!=?2)",
        params![id, active_binding], |row| row.get(0),
    ).map_err(db_error)?;
    if foreign_links != 0 {
        blockers.push("Children from a different binding are linked to this card".into());
    }
    let environment = connection
        .query_row(
            "SELECT id,project_id,revision,lifecycle_state,worktree_path,branch,repository_id
         FROM card_environments WHERE card_id=?1",
            [id],
            |row| {
                Ok(ParentEnvironmentEvidence {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    revision: row.get(2)?,
                    lifecycle: row.get(3)?,
                    worktree_path: row.get(4)?,
                    branch: row.get(5)?,
                    recorded_repository: row.get(6)?,
                    path_exists: false,
                    registered: None,
                    dirty: None,
                    local_tip: None,
                    remote_tip: None,
                })
            },
        )
        .optional()
        .map_err(db_error)?;
    if environment
        .as_ref()
        .is_some_and(|e| e.project_id != project_id || e.lifecycle != "ready")
    {
        blockers.push("Environment ownership or lifecycle requires separate resolution".into());
    }
    let pull_request_state: Option<String> = connection
        .query_row(
            "SELECT state FROM card_pull_requests WHERE card_id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    if pull_request_state.is_some() {
        blockers.push("A pull request is recorded; resolve its lifecycle separately".into());
    }
    let mut pending_operations = Vec::new();
    for (table, predicate) in [
        ("environment_creation_operations", "1=1"),
        ("card_target_merge_operations", "1=1"),
        ("scripted_delivery_operations", "1=1"),
        ("card_cleanup_operations", "status!='completed'"),
        (
            "provider_sync_operations",
            "state IN ('pending','running','failed')",
        ),
    ] {
        let sql = format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE card_id=?1 AND {predicate})");
        if connection
            .query_row(&sql, [id], |row| row.get::<_, i64>(0))
            .map_err(db_error)?
            != 0
        {
            pending_operations.push(table.to_string());
        }
    }
    if !pending_operations.is_empty() {
        blockers.push(
            "Pending provider, environment, or delivery operations require separate resolution"
                .into(),
        );
    }
    if !matches!(status.as_str(), "needs_refinement" | "ready") {
        blockers.push("The parent workflow has advanced beyond refinement; inspect prior work before reconciliation".into());
    }
    let report = ParentStatePreflight {
        card_id: id.into(),
        external_id: external_id.clone(),
        project_id: project_id.clone(),
        binding_id: active_binding.clone(),
        board_id: configured_board.clone(),
        token_env: token.clone(),
        workspace_slug: slug.clone(),
        workflow_revision: revision,
        record_revision,
        board_revision: super::repository::board_revision(connection)?,
        status,
        stored_finalized: finalized,
        stored_child_count: count,
        linked_child_ids,
        remote_child_ids: Vec::new(),
        remote_child_count: None,
        hierarchy_verified: false,
        environment,
        pty_ids: Vec::new(),
        pi_ids: Vec::new(),
        pull_request_state,
        pending_operations,
        blockers,
        uncertainty: Vec::new(),
        repair_available: false,
    };
    Ok((
        ParentIdentity {
            external_id,
            project_id,
            binding_id: active_binding,
            board_id: configured_board,
            token_env: token,
            workspace_slug: slug,
        },
        report,
    ))
}

// Git status normally refreshes the index. Disable optional locks and index
// writes: inspection must not mutate the checkout even as a side effect.
fn read_git(path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn inspect_repository(report: &mut ParentStatePreflight, project_path: &str) {
    let Some(env) = report.environment.as_mut() else {
        return;
    };
    env.path_exists = Path::new(&env.worktree_path).exists();
    if env.project_id != report.project_id {
        report
            .blockers
            .push("Environment belongs to another project".into());
    }
    let identity = repository_identity(project_path);
    match identity {
        Ok(ref repository) if env.recorded_repository.as_deref() == Some(repository) => {}
        Ok(_) => report
            .blockers
            .push("Recorded source repository does not match the project checkout".into()),
        Err(ref error) => report
            .uncertainty
            .push(format!("Cannot inspect project checkout: {error}")),
    }
    match read_git(project_path, &["worktree", "list", "--porcelain"]) {
        Ok(list) => {
            // A missing path and an unregistered path are different claims.
            env.registered = Some(
                list.lines()
                    .filter_map(|line| line.strip_prefix("worktree "))
                    .any(|path| {
                        path == env.worktree_path
                            || (Path::new(path).canonicalize().ok().is_some()
                                && Path::new(path).canonicalize().ok()
                                    == Path::new(&env.worktree_path).canonicalize().ok())
                    }),
            );
        }
        Err(error) => report
            .uncertainty
            .push(format!("Cannot inspect registered worktrees: {error}")),
    }
    if env.path_exists {
        report.blockers.push("The recorded worktree path exists; never treat a dirty, unregistered or mismatched checkout as absent".into());
        if let Ok(ref project_repository) = identity {
            match repository_identity(&env.worktree_path) {
                Ok(source) if source == *project_repository => {}
                Ok(_) => report
                    .blockers
                    .push("Source checkout belongs to a different repository".into()),
                Err(error) => report
                    .uncertainty
                    .push(format!("Cannot identify source checkout: {error}")),
            }
        }
        match read_git(
            &env.worktree_path,
            &["status", "--porcelain=v1", "--untracked-files=all"],
        ) {
            Ok(status) => env.dirty = Some(!status.is_empty()),
            Err(error) => report
                .uncertainty
                .push(format!("Cannot inspect worktree dirtiness: {error}")),
        }
    }
    if env.registered != Some(false) {
        report
            .blockers
            .push("The registered checkout is present or cannot be proven absent".into());
    }
    if env.branch.is_empty() {
        report
            .uncertainty
            .push("Recorded environment has no source branch identity".into());
    } else {
        let reference = format!("refs/heads/{}", env.branch);
        match read_git(
            project_path,
            &["show-ref", "--verify", "--hash", &reference],
        ) {
            Ok(tip) => {
                env.local_tip = Some(tip);
                report
                    .blockers
                    .push("A local source branch still exists".into());
            }
            Err(_) => match read_git(
                project_path,
                &["for-each-ref", "--format=%(refname)", &reference],
            ) {
                Ok(refs) if refs.is_empty() => {}
                Ok(_) => report
                    .blockers
                    .push("Local branch evidence is ambiguous".into()),
                Err(error) => report
                    .uncertainty
                    .push(format!("Cannot prove local branch absence: {error}")),
            },
        }
        match read_git(
            project_path,
            &["ls-remote", "--heads", "origin", &reference],
        ) {
            Ok(tip) if !tip.is_empty() => {
                env.remote_tip = tip.split_whitespace().next().map(str::to_string);
                report
                    .blockers
                    .push("A remote source branch still exists".into());
            }
            Ok(_) => {}
            Err(error) => report
                .uncertainty
                .push(format!("Cannot inspect remote source tip: {error}")),
        }
    }
    // Even if both path and branch are absent, stale metadata must not be removed
    // without a complete process and PR inventory, which is not yet implemented.
    report
        .blockers
        .push("Orphan environment removal requires a separate runtime and lifecycle proof".into());
}

fn verify_provider_details(
    identity: &ParentIdentity,
    first: &SuperthreadCard,
    children: &[SuperthreadCard],
    second: &SuperthreadCard,
) -> Result<super::superthread_refinement::ParentHierarchy, String> {
    let first_hierarchy = validate_parent_detail(first, &identity.external_id)?;
    let second_hierarchy = validate_parent_detail(second, &identity.external_id)?;
    if first.board_id != identity.board_id || second.board_id != identity.board_id {
        return Err("Remote parent is not on the configured board".into());
    }
    if first_hierarchy != second_hierarchy {
        return Err("Remote hierarchy changed between reads".into());
    }
    let mut returned = Vec::new();
    for child in children {
        if child.board_id != identity.board_id
            || child.task_parent.as_ref().map(|parent| parent.id.trim())
                != Some(identity.external_id.as_str())
        {
            return Err(format!(
                "Remote child {} does not verify its parent or board",
                child.id
            ));
        }
        returned.push(child.id.trim().to_string());
    }
    returned.sort();
    if returned != first_hierarchy.child_ids {
        return Err(
            "Remote child identities do not match the authoritative parent collection".into(),
        );
    }
    Ok(first_hierarchy)
}

pub(crate) fn inspect_parent_state(
    id: &str,
    service: &SuperthreadService,
    pty: &Mutex<PtyRegistry>,
    pi: &Mutex<PiRpcRegistry>,
) -> Result<ParentStatePreflight, String> {
    let (identity, mut report, project_path) = with_read_connection(|connection| {
        let (identity, report) = inspect_local(connection, id)?;
        let project_path = connection
            .query_row(
                "SELECT path FROM projects WHERE id=?1",
                [&identity.project_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(db_error)?;
        Ok((identity, report, project_path))
    })?;
    match crate::pty::card_pty_runtime_ids(pty, id) {
        Ok(ids) => report.pty_ids = ids,
        Err(error) => report
            .uncertainty
            .push(format!("PTY inventory unavailable: {error}")),
    }
    match crate::pi_rpc::card_pi_runtime_ids(pi, id) {
        Ok(ids) => report.pi_ids = ids,
        Err(error) => report
            .uncertainty
            .push(format!("Pi inventory unavailable: {error}")),
    }
    if !report.pty_ids.is_empty() || !report.pi_ids.is_empty() {
        report
            .blockers
            .push("Card PTY or Pi processes are running".into());
    }
    if report.environment.is_some() {
        report.uncertainty.push("External service and operating-system process ownership is not yet proven".into());
        inspect_repository(&mut report, &project_path);
    } else {
        // No card environment means there is no card checkout or service path to
        // dispose of. Runtime inventories still must succeed and be empty.
        let _ = project_path;
    }
    // Configure credentials and read the provider twice. It has no hierarchy
    // revision token: equal observations reduce, but cannot eliminate, races.
    match service
        .configure_token_env(&identity.token_env)
        .and_then(|_| {
            let first = service.card(&identity.external_id, identity.workspace_slug.as_deref())?;
            let first_hierarchy = validate_parent_detail(&first, &identity.external_id)?;
            let children = first_hierarchy
                .child_ids
                .iter()
                .map(|child_id| service.card(child_id, identity.workspace_slug.as_deref()))
                .collect::<Result<Vec<_>, _>>()?;
            let second = service.card(&identity.external_id, identity.workspace_slug.as_deref())?;
            verify_provider_details(&identity, &first, &children, &second)
        }) {
        Ok(hierarchy) => {
            report.remote_child_count = Some(hierarchy.child_count);
            report.remote_child_ids = hierarchy.child_ids;
            report.hierarchy_verified = true;
            if report.remote_child_ids != report.linked_child_ids {
                report.blockers.push(
                    "Remote and local child identities disagree; sync or investigate before repair"
                        .into(),
                );
            }
            if report.remote_child_ids.is_empty() {
                if report.stored_finalized || report.stored_child_count != 0 {
                    report.blockers.push("A zero-child hierarchy with conflicting parent metadata requires separate resolution; never convert a working leaf".into());
                }
            } else if report.stored_finalized
                && report.stored_child_count == hierarchy.child_count as i64
            {
                report
                    .blockers
                    .push("The parent is already finalized with the verified child count".into());
            }
        }
        Err(error) => report
            .uncertainty
            .push(format!("Remote hierarchy is unverified: {error}")),
    }
    let (current_identity, current) =
        with_read_connection(|connection| inspect_local(connection, id))?;
    if current_identity.external_id != identity.external_id
        || current_identity.project_id != identity.project_id
        || current_identity.token_env != identity.token_env
        || current_identity.workspace_slug != identity.workspace_slug
        || current.workflow_revision != report.workflow_revision
        || current.record_revision != report.record_revision
        || current.board_revision != report.board_revision
        || current.linked_child_ids != report.linked_child_ids
        || current.binding_id != identity.binding_id
        || current.board_id != identity.board_id
        || current.status != report.status
        || current.stored_finalized != report.stored_finalized
        || current.stored_child_count != report.stored_child_count
        || current.pending_operations != report.pending_operations
        || current.pull_request_state != report.pull_request_state
        || current.environment.as_ref().map(environment_identity)
            != report.environment.as_ref().map(environment_identity)
    {
        report
            .blockers
            .push("Local state changed during inspection; retry the preflight".into());
    }
    // Only an environment-free, ready card with complete matching children can
    // acquire aggregate metadata. Zero-child cards are leaves, not repairs.
    report.repair_available = can_repair(&report);
    Ok(report)
}

fn can_repair(report: &ParentStatePreflight) -> bool {
    report.blockers.is_empty() && report.uncertainty.is_empty()
        && report.hierarchy_verified && !report.remote_child_ids.is_empty()
        && i64::try_from(report.remote_child_ids.len()).is_ok()
        && report.remote_child_count == Some(report.remote_child_ids.len() as u64)
        && report.remote_child_ids == report.linked_child_ids
        && report.environment.is_none() && report.pty_ids.is_empty() && report.pi_ids.is_empty()
        && report.pull_request_state.is_none() && report.pending_operations.is_empty()
        && report.status == "ready" && report.workflow_revision > 0 && report.record_revision > 0
}

/// Re-inspect rather than accepting the UI's preflight as an authorization token.
/// No Git, provider or runtime resource is changed by this operation.
fn repair_parent_state(
    id: &str, service: &SuperthreadService, pty: &Mutex<PtyRegistry>, pi: &Mutex<PiRpcRegistry>,
    expected_workflow_revision: i64, expected_record_revision: i64, expected_board_revision: i64,
    confirmed: bool,
) -> Result<ParentStatePreflight, String> {
    if !confirmed { return Err("Explicit confirmation is required".into()); }
    let evidence = inspect_parent_state(id, service, pty, pi)?;
    let already_correct = evidence.hierarchy_verified && evidence.uncertainty.is_empty()
        && evidence.environment.is_none() && evidence.status == "ready"
        && !evidence.remote_child_ids.is_empty() && evidence.remote_child_ids == evidence.linked_child_ids
        && evidence.stored_finalized && i64::try_from(evidence.remote_child_count.unwrap_or(0)).ok() == Some(evidence.stored_child_count)
        && evidence.blockers.iter().all(|blocker| blocker.contains("already finalized"));
    if !evidence.repair_available && !already_correct {
        return Err(format!("Parent state cannot be repaired: {}", evidence.blockers.iter().chain(evidence.uncertainty.iter()).cloned().collect::<Vec<_>>().join("; ")));
    }
    if evidence.workflow_revision != expected_workflow_revision
        || evidence.record_revision != expected_record_revision
        || evidence.board_revision != expected_board_revision
    {
        // An identical, completed repair may be retried after losing its response.
        if already_correct && evidence.workflow_revision == expected_workflow_revision
            && evidence.record_revision == expected_record_revision + 1
            && evidence.board_revision == expected_board_revision + 1
            && super::repository::with_read_connection(|connection| {
                connection.query_row("SELECT EXISTS(SELECT 1 FROM card_events WHERE card_id=?1 AND event_type='resolve_parent_state')", [id], |row| row.get::<_, i64>(0)).map_err(db_error)
            })? == 1 {
            return Ok(evidence);
        }
        return Err("Parent or board revision changed; run preflight again".into());
    }
    if already_correct { return Ok(evidence); }
    if !crate::pty::card_pty_runtime_ids(pty, id)?.is_empty()
        || !crate::pi_rpc::card_pi_runtime_ids(pi, id)?.is_empty() {
        return Err("Card processes started during repair; run preflight again".into());
    }
    super::repository::with_board_mutation(|connection| apply_verified_repair(connection, id, &evidence))?;
    // Do not turn a committed repair into an apparent failure if the provider
    // becomes unavailable while preparing the response.
    super::repository::with_read_connection(|connection| {
        let (_, mut result) = inspect_local(connection, id)?;
        result.remote_child_ids = evidence.remote_child_ids;
        result.remote_child_count = evidence.remote_child_count;
        result.hierarchy_verified = true;
        Ok(result)
    })
}

fn apply_verified_repair(connection: &Connection, id: &str, evidence: &ParentStatePreflight) -> Result<(), String> {
        if !evidence.repair_available || !can_repair(evidence) {
            return Err("Verified environment-free parent evidence is required".into());
        }
        let (identity, current) = inspect_local(connection, id)?;
        if identity.external_id != evidence.external_id || identity.project_id != evidence.project_id {
            return Err("Parent identity changed during repair".into());
        }
        if current.workflow_revision != evidence.workflow_revision
            || current.record_revision != evidence.record_revision
            || current.board_revision != evidence.board_revision
            || current.linked_child_ids != evidence.linked_child_ids
            || current.environment.is_some() || current.pull_request_state.is_some()
            || !current.pending_operations.is_empty() || !current.blockers.is_empty()
            || current.status != "ready" || current.stored_finalized != evidence.stored_finalized
            || current.stored_child_count != evidence.stored_child_count
            || current.binding_id != evidence.binding_id || current.board_id != evidence.board_id
            || identity.token_env != evidence.token_env || identity.workspace_slug != evidence.workspace_slug
        {
            return Err("Parent state changed during repair; run preflight again".into());
        }
        let count = i64::try_from(evidence.remote_child_ids.len()).map_err(|_| "Child count overflow")?;
        connection.execute(
            "UPDATE kanban_cards SET hierarchy_finalized=1,provider_child_count=?1,updated_at=?2 WHERE id=?3",
            params![count, unix_timestamp(), id],
        ).map_err(db_error)?;
        connection.execute(
            "INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,summary) VALUES (?1,?2,'user','resolve_parent_state','success',?3)",
            params![id, unix_timestamp(), format!("Verified {} Superthread child identities; corrected aggregate metadata only", count)],
        ).map_err(db_error)?;
        Ok(())
}

#[tauri::command]
pub async fn kanban_repair_parent_state(
    app: AppHandle, service: State<'_, SuperthreadService>, id: String,
    expected_workflow_revision: i64, expected_record_revision: i64, expected_board_revision: i64,
    confirmed: bool,
) -> Result<ParentStatePreflight, String> {
    let provider = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let pty = app.state::<Mutex<PtyRegistry>>();
        let pi = app.state::<Mutex<PiRpcRegistry>>();
        repair_parent_state(&id, &provider, pty.inner(), pi.inner(),
            expected_workflow_revision, expected_record_revision, expected_board_revision, confirmed)
    }).await.map_err(|error| format!("Parent repair worker failed: {error}"))?
}

#[tauri::command]
pub async fn kanban_parent_state_preflight(
    app: AppHandle,
    service: State<'_, SuperthreadService>,
    id: String,
) -> Result<ParentStatePreflight, String> {
    let provider = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let pty = app.state::<Mutex<PtyRegistry>>();
        let pi = app.state::<Mutex<PiRpcRegistry>>();
        inspect_parent_state(&id, &provider, pty.inner(), pi.inner())
    })
    .await
    .map_err(|error| format!("Parent preflight worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::super::repository::migrate;
    use super::*;
    use crate::store::migrate_store_schema;

    #[test]
    fn remote_evidence_rejects_missing_counts_changed_hierarchy_and_wrong_children() {
        let identity = ParentIdentity {
            external_id: "2313".into(),
            project_id: "p".into(),
            binding_id: "b".into(),
            board_id: "board".into(),
            token_env: "ST_TOKEN".into(),
            workspace_slug: None,
        };
        let parent = |count: Option<u64>, ids: &[&str]| -> SuperthreadCard {
            serde_json::from_value(serde_json::json!({
                "id": "2313", "title": "Parent", "board_id": "board", "list_id": "todo",
                "total_task_children": count,
                "task_children": ids.iter().map(|id| serde_json::json!({ "task_id": id, "title": id })).collect::<Vec<_>>()
            })).unwrap()
        };
        let child = |id: &str, owner: &str| -> SuperthreadCard {
            serde_json::from_value(serde_json::json!({
                "id": id, "title": id, "board_id": "board", "list_id": "todo",
                "task_parent": { "id": owner }, "total_task_children": 0
            }))
            .unwrap()
        };
        let first = parent(Some(3), &["2314", "2315", "2316"]);
        let children = vec![
            child("2314", "2313"),
            child("2315", "2313"),
            child("2316", "2313"),
        ];
        assert_eq!(
            verify_provider_details(&identity, &first, &children, &first)
                .unwrap()
                .child_count,
            3
        );
        assert!(verify_provider_details(
            &identity,
            &first,
            &children,
            &parent(Some(2), &["2314", "2315"])
        )
        .is_err());
        assert!(verify_provider_details(&identity, &parent(None, &[]), &[], &first).is_err());
        assert!(verify_provider_details(
            &identity,
            &first,
            &[
                child("2314", "other"),
                children[1].clone(),
                children[2].clone()
            ],
            &first
        )
        .is_err());
        assert!(verify_provider_details(&identity, &first, &children[..2], &first).is_err());
    }

    #[test]
    fn repository_inspection_never_equates_an_unregistered_dirty_path_with_absence() {
        let root =
            std::env::temp_dir().join(format!("stacks-parent-preflight-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        let foreign = root.join("foreign");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&foreign).unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(&project)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(&foreign)
            .status()
            .unwrap()
            .success());
        std::fs::write(foreign.join("work.txt"), "untracked work").unwrap();
        let path = project.to_str().unwrap();
        let mut report = ParentStatePreflight {
            card_id: "parent".into(),
            external_id: "2313".into(),
            project_id: "p".into(),
            binding_id: "b".into(),
            board_id: "board".into(),
            token_env: "ST_TOKEN".into(),
            workspace_slug: None,
            workflow_revision: 1,
            record_revision: 1,
            board_revision: 0,
            status: "ready".into(),
            stored_finalized: false,
            stored_child_count: 3,
            linked_child_ids: vec![],
            remote_child_ids: vec![],
            remote_child_count: None,
            hierarchy_verified: false,
            environment: Some(ParentEnvironmentEvidence {
                id: "e".into(),
                project_id: "p".into(),
                revision: 1,
                lifecycle: "ready".into(),
                worktree_path: foreign.to_str().unwrap().into(),
                branch: "work".into(),
                recorded_repository: Some(repository_identity(path).unwrap()),
                path_exists: false,
                registered: None,
                dirty: None,
                local_tip: None,
                remote_tip: None,
            }),
            pty_ids: vec![],
            pi_ids: vec![],
            pull_request_state: None,
            pending_operations: vec![],
            blockers: vec![],
            uncertainty: vec![],
            repair_available: false,
        };
        inspect_repository(&mut report, path);
        let env = report.environment.as_ref().unwrap();
        assert!(env.path_exists);
        assert_eq!(env.registered, Some(false));
        assert_eq!(env.dirty, Some(true));
        assert!(report
            .blockers
            .iter()
            .any(|reason| reason.contains("path exists")));
        assert!(!report.repair_available);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_metadata_repair_is_atomic_and_preserves_children() {
        let mut db = Connection::open_in_memory().unwrap();
        migrate(&db).unwrap();
        migrate_store_schema(&db).unwrap();
        db.execute("INSERT INTO projects(id,name,path,kanban_source,superthread_board_id) VALUES ('p','P','/missing','superthread','board')", []).unwrap();
        db.execute("INSERT INTO superthread_bindings(id,project_id,token_env_var,validation_revision,validated_at,state,created_at,updated_at) VALUES ('b','p','ST_TOKEN',1,1,'active',1,1)", []).unwrap();
        db.execute("UPDATE projects SET superthread_binding_id='b' WHERE id='p'", []).unwrap();
        db.execute("INSERT INTO kanban_cards(id,external_provider,external_id,title,status,project_id,binding_id,board_id,created_at,updated_at) VALUES ('parent','superthread','2313','P','ready','p','b','board',1,1)", []).unwrap();
        db.execute("INSERT INTO kanban_cards(id,external_provider,external_id,title,status,project_id,binding_id,board_id,parent_id,created_at,updated_at) VALUES ('child','superthread','2314','C','ready','p','b','board','parent',1,1)", []).unwrap();
        let (_, mut evidence) = inspect_local(&db, "parent").unwrap();
        evidence.remote_child_ids = vec!["2314".into()];
        evidence.remote_child_count = Some(1);
        evidence.hierarchy_verified = true;
        evidence.repair_available = true;
        assert!(can_repair(&evidence));
        for mutation in [
            (|report: &mut ParentStatePreflight| report.remote_child_ids.clear()) as fn(&mut ParentStatePreflight),
            |report| report.remote_child_count = None,
            |report| report.linked_child_ids.clear(),
            |report| report.pty_ids.push("running".into()),
            |report| report.pi_ids.push("running".into()),
            |report| report.pending_operations.push("provider_sync_operations".into()),
            |report| report.pull_request_state = Some("open".into()),
            |report| report.uncertainty.push("unverified services".into()),
        ] {
            let mut unsafe_evidence = evidence.clone();
            mutation(&mut unsafe_evidence);
            assert!(!can_repair(&unsafe_evidence));
        }
        let mut orphan = evidence.clone();
        orphan.environment = Some(ParentEnvironmentEvidence {
            id: "orphan".into(), project_id: "p".into(), revision: 1, lifecycle: "ready".into(),
            worktree_path: "/missing".into(), branch: "branch".into(), recorded_repository: None,
            path_exists: false, registered: Some(false), dirty: None, local_tip: None, remote_tip: None,
        });
        assert!(!can_repair(&orphan));
        let mut leaf = evidence.clone();
        leaf.remote_child_ids.clear(); leaf.linked_child_ids.clear(); leaf.remote_child_count = Some(0);
        assert!(!can_repair(&leaf));
        let (_, change) = super::super::repository::execute_board_mutation(&mut db, |connection| apply_verified_repair(connection, "parent", &evidence)).unwrap();
        let change = change.unwrap();
        assert!(change.detail_invalidated_ids.contains(&"parent".to_string()));
        assert!(change.board_revision > evidence.board_revision);
        assert_eq!(db.query_row("SELECT hierarchy_finalized FROM kanban_cards WHERE id='parent'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(db.query_row("SELECT parent_id FROM kanban_cards WHERE id='child'", [], |row| row.get::<_, String>(0)).unwrap(), "parent");
        assert_eq!(db.query_row("SELECT COUNT(*) FROM card_events WHERE event_type='resolve_parent_state'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert!(super::super::repository::execute_board_mutation(&mut db, |connection| apply_verified_repair(connection, "parent", &evidence)).is_err());
        db.execute("UPDATE kanban_cards SET hierarchy_finalized=0 WHERE id='parent'", []).unwrap();
        db.execute("INSERT INTO card_pull_requests(card_id,repository,number,title,url,state,updated_at) VALUES ('parent','repo',1,'PR','url','open',1)", []).unwrap();
        let (_, mut with_pr) = inspect_local(&db, "parent").unwrap();
        with_pr.remote_child_ids = vec!["2314".into()];
        with_pr.remote_child_count = Some(1);
        with_pr.hierarchy_verified = true;
        with_pr.repair_available = true;
        assert!(!can_repair(&with_pr));
        assert!(super::super::repository::execute_board_mutation(&mut db, |connection| apply_verified_repair(connection, "parent", &with_pr)).is_err());
    }

    #[test]
    fn preflight_local_identity_is_read_only_and_rejects_foreign_links() {
        let db = Connection::open_in_memory().unwrap();
        migrate(&db).unwrap();
        migrate_store_schema(&db).unwrap();
        db.execute("INSERT INTO projects(id,name,path,kanban_source,superthread_board_id) VALUES ('p','P','/missing','superthread','board')", []).unwrap();
        db.execute("INSERT INTO superthread_bindings(id,project_id,token_env_var,validation_revision,validated_at,state,created_at,updated_at) VALUES ('b','p','ST_TOKEN',1,1,'active',1,1)", []).unwrap();
        db.execute(
            "UPDATE projects SET superthread_binding_id='b' WHERE id='p'",
            [],
        )
        .unwrap();
        db.execute("INSERT INTO kanban_cards(id,external_provider,external_id,title,status,project_id,binding_id,board_id,created_at,updated_at) VALUES ('parent','superthread','2313','P','ready','p','b','board',1,1)", []).unwrap();
        let (identity, report) = inspect_local(&db, "parent").unwrap();
        assert_eq!(identity.external_id, "2313");
        assert_eq!(report.workflow_revision, 1);
        assert!(!report.repair_available);
        db.execute("INSERT INTO kanban_cards(id,external_provider,external_id,title,status,project_id,binding_id,parent_id,created_at,updated_at) VALUES ('child','superthread','child','C','ready','p','other','parent',1,1)", []).unwrap();
        let (_, report) = inspect_local(&db, "parent").unwrap();
        assert!(report
            .blockers
            .iter()
            .any(|reason| reason.contains("different binding")));
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM card_events", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
