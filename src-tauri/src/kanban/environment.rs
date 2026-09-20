use super::*;
#[allow(unused_imports)]
use super::{
    cards::*, cleanup::*, domain::*, git_effects::*, github_delivery::*, health::*,
    local_delivery::*, repository::*, sync::*,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(in crate::kanban) struct WorktreeEvidence {
    pub(in crate::kanban) path: String,
    pub(in crate::kanban) branch: Option<String>,
    pub(in crate::kanban) revision: Option<String>,
}

#[derive(Debug, Clone)]
pub(in crate::kanban) struct CreationOperationRow {
    pub(in crate::kanban) card_id: String,
    pub(in crate::kanban) project_id: String,
    pub(in crate::kanban) repository_id: String,
    pub(in crate::kanban) expected_workflow_revision: i64,
    pub(in crate::kanban) target_checkout_path: String,
    pub(in crate::kanban) target_branch: String,
    pub(in crate::kanban) observed_target_revision: String,
    pub(in crate::kanban) setup_command: String,
    pub(in crate::kanban) custom_command: bool,
    pub(in crate::kanban) phase: String,
    pub(in crate::kanban) attempt_token: Option<String>,
    pub(in crate::kanban) result_path: String,
    pub(in crate::kanban) pre_worktrees: String,
    pub(in crate::kanban) pre_branches: String,
    pub(in crate::kanban) setup_result_cwd: Option<String>,
    pub(in crate::kanban) source_path: Option<String>,
    pub(in crate::kanban) source_branch: Option<String>,
    pub(in crate::kanban) source_revision: Option<String>,
    pub(in crate::kanban) source_worktree_new: bool,
    pub(in crate::kanban) source_branch_new: bool,
    pub(in crate::kanban) worktree_removed: bool,
}

pub(in crate::kanban) fn worktree_inventory(target: &str) -> Result<Vec<WorktreeEvidence>, String> {
    let output = git_output(target, &["worktree", "list", "--porcelain"])?;
    let mut result = Vec::new();
    let mut current: Option<WorktreeEvidence> = None;
    for line in output.lines().chain(std::iter::once("")) {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(item) = current.take() {
                result.push(item);
            }
            current = Some(WorktreeEvidence {
                path: Path::new(path)
                    .canonicalize()
                    .unwrap_or_else(|_| PathBuf::from(path))
                    .to_string_lossy()
                    .into_owned(),
                branch: None,
                revision: None,
            });
        } else if let Some(item) = current.as_mut() {
            if let Some(head) = line.strip_prefix("HEAD ") {
                item.revision = Some(head.to_string());
            }
            if let Some(branch) = line.strip_prefix("branch refs/heads/") {
                item.branch = Some(branch.to_string());
            }
            if line.is_empty() {
                result.push(current.take().unwrap());
            }
        }
    }
    result.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}

pub(in crate::kanban) fn branch_inventory(
    target: &str,
) -> Result<BTreeMap<String, String>, String> {
    let output = git_output(
        target,
        &[
            "for-each-ref",
            "--format=%(refname:short)%00%(objectname)",
            "refs/heads",
        ],
    )?;
    Ok(output
        .lines()
        .filter_map(|line| line.split_once('\0'))
        .map(|(name, tip)| (name.to_string(), tip.to_string()))
        .collect())
}

pub(in crate::kanban) fn load_creation_operation_row(
    connection: &Connection,
    card_id: &str,
) -> Result<Option<CreationOperationRow>, String> {
    connection.query_row(
        "SELECT card_id,project_id,repository_id,expected_workflow_revision,target_checkout_path,target_branch,observed_target_revision,setup_command,custom_command,phase,attempt_token,result_path,pre_worktrees,pre_branches,setup_result_cwd,source_path,source_branch,source_revision,source_worktree_new,source_branch_new,worktree_removed FROM environment_creation_operations WHERE card_id=?1",
        [card_id], |row| Ok(CreationOperationRow {
            card_id: row.get(0)?, project_id: row.get(1)?, repository_id: row.get(2)?, expected_workflow_revision: row.get(3)?,
            target_checkout_path: row.get(4)?, target_branch: row.get(5)?, observed_target_revision: row.get(6)?, setup_command: row.get(7)?, custom_command: row.get::<_, i64>(8)? != 0,
            phase: row.get(9)?, attempt_token: row.get(10)?, result_path: row.get(11)?, pre_worktrees: row.get(12)?, pre_branches: row.get(13)?, setup_result_cwd: row.get(14)?,
            source_path: row.get(15)?, source_branch: row.get(16)?, source_revision: row.get(17)?, source_worktree_new: row.get::<_, i64>(18)? != 0,
            source_branch_new: row.get::<_, i64>(19)? != 0, worktree_removed: row.get::<_, i64>(20)? != 0,
        })
    ).optional().map_err(db_error)
}

pub(in crate::kanban) fn update_creation_phase(
    card_id: &str,
    phase: &str,
    error: Option<&str>,
    cleanup_available: bool,
) -> Result<(), String> {
    with_board_mutation(|connection| {
        let tx = connection
            .savepoint()
            .map_err(db_error)?;
        let changed = tx.execute("UPDATE environment_creation_operations SET phase=?1,error=?2,cleanup_available=?3,revision=revision+1,updated_at=?4 WHERE card_id=?5", params![phase,error,cleanup_available as i64,unix_timestamp(),card_id]).map_err(db_error)?;
        if changed != 1 {
            return Err("Environment creation operation disappeared".to_string());
        }
        tx.commit().map_err(db_error)
    })
}

pub(in crate::kanban) fn prepare_creation_operation(
    id: &str,
    expected_revision: i64,
    setup_command: &str,
    custom_command: bool,
) -> Result<CreationOperationRow, String> {
    if setup_command.trim().is_empty() {
        return Err("Setup command cannot be empty".to_string());
    }
    let (project_id, project_path, configured_branch) = with_read_connection(|connection| {
        connection.query_row("SELECT c.project_id,p.path,COALESCE(p.target_branch,'main') FROM kanban_cards c JOIN projects p ON p.id=c.project_id WHERE c.id=?1", [id], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?))).optional().map_err(db_error)?.ok_or_else(|| "The card or its owning project was not found".to_string())
    })?;
    let target = validate_checkout(&project_path, None)?;
    if target.target_branch != configured_branch {
        return Err(format!("Project checkout must be clean and checked out on configured target branch {configured_branch}"));
    }
    let worktrees = serde_json::to_string(&worktree_inventory(&target.target_checkout_path)?)
        .map_err(|e| e.to_string())?;
    let branches = serde_json::to_string(&branch_inventory(&target.target_checkout_path)?)
        .map_err(|e| e.to_string())?;
    let operation_id = format!("environment-creation:{}", uuid::Uuid::new_v4());
    let mut result_path = app_data_dir()?;
    result_path.push("setup-results");
    result_path.push(format!("{operation_id}.cwd"));
    with_board_mutation(|connection| {
        let tx = connection
            .savepoint()
            .map_err(db_error)?;
        let (status, revision, current_project, provider, finalized, source, current_path): (String,i64,String,String,bool,String,String) = tx.query_row(
            "SELECT c.status,c.workflow_revision,c.project_id,c.external_provider,c.hierarchy_finalized,COALESCE(p.kanban_source,'local'),p.path FROM kanban_cards c JOIN projects p ON p.id=c.project_id WHERE c.id=?1",
            [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get::<_,i64>(4)? != 0,row.get(5)?,row.get(6)?))
        ).optional().map_err(db_error)?.ok_or_else(|| "Kanban card was not found".to_string())?;
        if finalized {
            return Err("A finalized aggregate parent cannot start work".to_string());
        }
        if status != "ready" {
            return Err("The card must be Ready for agent before work can start".to_string());
        }
        if revision != expected_revision {
            return Err("Card changed; reload before starting work".to_string());
        }
        if current_project != project_id
            || current_path != project_path
            || (provider == "superthread") != (source == "superthread")
        {
            return Err("The card's project identity changed before setup".to_string());
        }
        if tx
            .query_row(
                "SELECT COUNT(*) FROM card_environments WHERE card_id=?1",
                [id],
                |r| r.get::<_, i64>(0),
            )
            .map_err(db_error)?
            != 0
        {
            return Err("The card already has an environment".to_string());
        }
        tx.execute("INSERT INTO environment_creation_operations (id,card_id,project_id,repository_id,expected_workflow_revision,target_checkout_path,target_branch,observed_target_revision,setup_command,custom_command,phase,result_path,pre_worktrees,pre_branches,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'prepared',?11,?12,?13,?14,?14)", params![operation_id,id,project_id,target.repository_id,expected_revision,target.target_checkout_path,target.target_branch,target.target_revision,setup_command.trim(),custom_command as i64,result_path.to_string_lossy(),worktrees,branches,unix_timestamp()]).map_err(db_error)?;
        tx.commit().map_err(db_error)
    })?;
    with_read_connection(|connection| load_creation_operation_row(connection, id))?
        .ok_or_else(|| "Could not reload environment creation operation".to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct EnvironmentStartPreflight {
    pub(in crate::kanban) repository_id: String,
    pub(in crate::kanban) target_checkout_path: String,
    pub(in crate::kanban) target_branch: String,
    pub(in crate::kanban) target_revision: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowOperationResult {
    pub(in crate::kanban) card: KanbanCard,
    pub(in crate::kanban) message: String,
    pub(in crate::kanban) idempotent: bool,
}

pub(in crate::kanban) fn card_repository_identity(
    card_id: &str,
    require_environment: bool,
) -> Result<PathBuf, String> {
    with_read_connection(|connection| {
        let snapshot: (String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT c.project_id,p.path,e.project_id,e.worktree_path,e.repository_id,e.target_checkout_path,o.repository_id,o.target_checkout_path,o.source_path
                 FROM kanban_cards c JOIN projects p ON p.id=c.project_id
                 LEFT JOIN card_environments e ON e.card_id=c.id
                 LEFT JOIN environment_creation_operations o ON o.card_id=c.id WHERE c.id=?1",
                [card_id],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "The card's owning project no longer exists".to_string())?;
        let (
            card_project,
            project_path,
            environment_project,
            source_path,
            recorded_repository,
            target_path,
            creation_repository,
            creation_target,
            creation_source,
        ) = snapshot;
        if require_environment && source_path.is_none() {
            return Err("This card has no repository environment".to_string());
        }
        if environment_project
            .as_deref()
            .is_some_and(|project| project != card_project)
        {
            return Err("The card/environment project mismatch blocks this operation".to_string());
        }
        let identity = repository_coordinator::repository_identity(&project_path)?;
        let expected = identity.to_string_lossy();
        for recorded in [
            recorded_repository.as_deref(),
            creation_repository.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if recorded != expected {
                return Err(
                    "Recorded repository metadata does not match the project repository"
                        .to_string(),
                );
            }
        }
        for (label, path) in [
            ("source", source_path.as_deref()),
            ("target", target_path.as_deref()),
            ("creation target", creation_target.as_deref()),
            ("creation source", creation_source.as_deref()),
        ] {
            if let Some(path) = path.filter(|path| !path.trim().is_empty()) {
                if repository_coordinator::repository_identity(path)? != identity {
                    return Err(format!(
                        "The {label} checkout belongs to a different repository"
                    ));
                }
            }
        }
        Ok(identity)
    })
}

pub(in crate::kanban) fn coordinate_card_repository<T>(
    card_id: &str,
    require_environment: bool,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let identity = card_repository_identity(card_id, require_environment)?;
    repository_coordinator::global().coordinate(&identity, || {
        if card_repository_identity(card_id, require_environment)? != identity {
            return Err(
                "The card repository changed while the operation was waiting; retry".to_string(),
            );
        }
        operation()
    })
}

pub(in crate::kanban) fn persist_validated_source(
    op: &CreationOperationRow,
    reported: Option<&str>,
) -> Result<CreationOperationRow, String> {
    let post_worktrees = worktree_inventory(&op.target_checkout_path)?;
    let post_branches = branch_inventory(&op.target_checkout_path)?;
    let pre_worktrees: Vec<WorktreeEvidence> =
        serde_json::from_str(&op.pre_worktrees).map_err(|e| e.to_string())?;
    let pre_branches: BTreeMap<String, String> =
        serde_json::from_str(&op.pre_branches).map_err(|e| e.to_string())?;
    let pre_paths = pre_worktrees
        .iter()
        .map(|item| item.path.as_str())
        .collect::<Vec<_>>();
    let validate_candidate = |path: &str| -> Result<EnvironmentStartPreflight, String> {
        let source = validate_checkout(path, Some(&op.repository_id))?;
        if source.target_checkout_path == op.target_checkout_path {
            return Err("Setup returned the target checkout itself".to_string());
        }
        if source.target_branch == op.target_branch {
            return Err(format!(
                "Setup must create a source branch different from {}",
                op.target_branch
            ));
        }
        if !post_worktrees
            .iter()
            .any(|item| item.path == source.target_checkout_path)
        {
            return Err("Setup result is not a registered worktree".to_string());
        }
        Ok(source)
    };
    let source = if let Some(path) = reported {
        validate_candidate(path)?
    } else {
        let candidates = post_worktrees
            .iter()
            .filter(|item| {
                !pre_paths.contains(&item.path.as_str()) && item.path != op.target_checkout_path
            })
            .filter_map(|item| validate_candidate(&item.path).ok())
            .collect::<Vec<_>>();
        if candidates.len() != 1 {
            return Err(
                "Setup result could not be matched to exactly one valid new source worktree"
                    .to_string(),
            );
        }
        candidates[0].clone()
    };
    let worktree_new = !pre_paths.contains(&source.target_checkout_path.as_str());
    let branch_new = !pre_branches.contains_key(&source.target_branch);
    with_board_mutation(|connection| {
        let tx = connection
            .savepoint()
            .map_err(db_error)?;
        tx.execute("UPDATE environment_creation_operations SET phase='setup_complete',post_worktrees=?1,post_branches=?2,source_path=?3,source_branch=?4,source_revision=?5,source_worktree_new=?6,source_branch_new=?7,error=NULL,cleanup_available=?8,revision=revision+1,updated_at=?9 WHERE card_id=?10",
            params![serde_json::to_string(&post_worktrees).map_err(|e| e.to_string())?,serde_json::to_string(&post_branches).map_err(|e| e.to_string())?,source.target_checkout_path,source.target_branch,source.target_revision,worktree_new as i64,branch_new as i64,worktree_new as i64,unix_timestamp(),op.card_id]).map_err(db_error)?;
        tx.commit().map_err(db_error)
    })?;
    with_read_connection(|connection| load_creation_operation_row(connection, &op.card_id))?
        .ok_or_else(|| "Could not reload validated environment operation".to_string())
}

pub(in crate::kanban) fn creation_recovery(
    card_id: &str,
    detail: &str,
    cleanup_available: bool,
) -> Result<KanbanCard, String> {
    update_creation_phase(
        card_id,
        "recovery_required",
        Some(detail),
        cleanup_available,
    )?;
    with_board_mutation(|connection| {
        connection.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,error_code,error_detail) VALUES (?1,?2,'system','environment_start','failure','recovery_required',?3)", params![card_id,unix_timestamp(),detail]).map_err(db_error)?;
        get_card(connection, card_id)?.ok_or_else(|| "Kanban card was not found".to_string())
    })
}

pub(in crate::kanban) fn compensate_creation(
    op: &CreationOperationRow,
) -> Result<KanbanCard, String> {
    let unsafe_recovery = |detail: String| creation_recovery(&op.card_id, &detail, false);
    if !op.source_worktree_new {
        return unsafe_recovery("The source worktree cannot be proven absent before setup; Git resources were preserved".to_string());
    }
    let source_path = op
        .source_path
        .as_deref()
        .ok_or_else(|| "Validated source path is missing".to_string())?;
    let source_branch = op
        .source_branch
        .as_deref()
        .ok_or_else(|| "Validated source branch is missing".to_string())?;
    let source_revision = op
        .source_revision
        .as_deref()
        .ok_or_else(|| "Validated source revision is missing".to_string())?;
    if !op.worktree_removed {
        let source = match validate_checkout(source_path, Some(&op.repository_id)) {
            Ok(value) => value,
            Err(error) => {
                return unsafe_recovery(format!("Compensation preserved the worktree: {error}"))
            }
        };
        if source.target_branch != source_branch || source.target_revision != source_revision {
            return unsafe_recovery(
                "Compensation preserved a changed source worktree or branch".to_string(),
            );
        }
        if ensure_registered_distinct_worktree(&op.target_checkout_path, source_path).is_err() {
            return unsafe_recovery(
                "Compensation preserved an unregistered or non-distinct worktree".to_string(),
            );
        }
        let removed = Command::new("git")
            .args([
                "-C",
                &op.target_checkout_path,
                "worktree",
                "remove",
                "--",
                source_path,
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !removed.status.success() {
            return creation_recovery(
                &op.card_id,
                &format!(
                    "Git could not remove the proven source worktree: {}",
                    String::from_utf8_lossy(&removed.stderr).trim()
                ),
                true,
            );
        }
        with_board_mutation(|connection| {
            connection.execute("UPDATE environment_creation_operations SET worktree_removed=1,revision=revision+1,updated_at=?1 WHERE card_id=?2", params![unix_timestamp(),op.card_id]).map(|_| ()).map_err(db_error)
        })?;
    }
    if op.source_branch_new {
        let branches = branch_inventory(&op.target_checkout_path)?;
        match branches.get(source_branch).map(String::as_str) {
            Some(tip) if tip != source_revision => {
                return unsafe_recovery(
                    "Compensation preserved an advanced source branch".to_string(),
                );
            }
            Some(_) => {
                if worktree_inventory(&op.target_checkout_path)?
                    .iter()
                    .any(|item| item.branch.as_deref() == Some(source_branch))
                {
                    return unsafe_recovery(
                        "Compensation preserved a branch that is still checked out".to_string(),
                    );
                }
                let deleted = Command::new("git")
                    .args([
                        "-C",
                        &op.target_checkout_path,
                        "branch",
                        "-D",
                        "--",
                        source_branch,
                    ])
                    .output()
                    .map_err(|e| e.to_string())?;
                if !deleted.status.success() {
                    return creation_recovery(
                        &op.card_id,
                        &format!(
                            "Worktree was removed, but branch cleanup failed: {}",
                            String::from_utf8_lossy(&deleted.stderr).trim()
                        ),
                        true,
                    );
                }
            }
            None => {} // A prior compensation attempt already deleted it.
        }
    }
    with_board_mutation(|connection| {
        let tx = connection
            .savepoint()
            .map_err(db_error)?;
        tx.execute(
            "DELETE FROM environment_creation_operations WHERE card_id=?1",
            [&op.card_id],
        )
        .map_err(db_error)?;
        tx.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,summary) VALUES (?1,?2,'system','environment_compensation','success',?3)", params![op.card_id,unix_timestamp(),if op.source_branch_new { "Removed setup-created worktree and branch" } else { "Removed setup-created worktree and retained pre-existing branch" }]).map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        get_card(connection, &op.card_id)?.ok_or_else(|| "Kanban card was not found".to_string())
    })
}

pub(in crate::kanban) fn setup_process_alive(result_path: &str) -> bool {
    let pid_path = Path::new(result_path).with_extension("pid");
    let Some(pid) = fs::read_to_string(&pid_path)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| value.chars().all(|ch| ch.is_ascii_digit()))
    else {
        return false;
    };
    let alive = Command::new("kill")
        .args(["-0", &pid])
        .status()
        .is_ok_and(|status| status.success());
    if !alive {
        let _ = fs::remove_file(pid_path);
    }
    alive
}

pub(in crate::kanban) fn run_environment_creation(
    id: String,
    expected_workflow_revision: i64,
    setup_command: String,
    custom_command: bool,
    explicit_retry: bool,
    cancelled: &AtomicBool,
) -> Result<KanbanCard, String> {
    if let Some(card) = with_read_connection(|connection| get_card(connection, &id))? {
        if card.environment.is_some() {
            with_read_connection(|connection| validate_card_environment_project(connection, &id))?;
            return Ok(card);
        }
    }
    let mut op = match with_read_connection(|connection| load_creation_operation_row(connection, &id))? {
        Some(existing) => existing,
        None => prepare_creation_operation(
            &id,
            expected_workflow_revision,
            &setup_command,
            custom_command,
        )?,
    };
    // Once prepared, the durable operation owns the expected revision. A later
    // card revision is reconciled during attachment and compensated safely.
    let current_project = with_read_connection(|connection| {
        connection
            .query_row(
                "SELECT project_id FROM kanban_cards WHERE id=?1",
                [&id],
                |row| row.get::<_, String>(0),
            )
            .map_err(db_error)
    })?;
    if current_project != op.project_id {
        if op.phase == "prepared" {
            return creation_recovery(
                &id,
                "The card's owning project changed before setup; setup was not run",
                false,
            );
        }
        if op.phase == "recovery_required" {
            return with_read_connection(|connection| get_card(connection, &id))?
                .ok_or_else(|| "Kanban card was not found".to_string());
        }
    }
    if op.phase == "recovery_required" {
        if Path::new(&op.result_path).is_file() {
            let cwd = fs::read_to_string(&op.result_path)
                .map_err(|e| e.to_string())?
                .trim()
                .to_string();
            with_board_mutation(|connection| {
                connection.execute("UPDATE environment_creation_operations SET phase='setup_complete',setup_result_cwd=?1,error=NULL,revision=revision+1,updated_at=?2 WHERE card_id=?3", params![cwd,unix_timestamp(),id]).map(|_| ()).map_err(db_error)
            })?;
            op = with_read_connection(|connection| load_creation_operation_row(connection, &id))?
                .unwrap();
        } else {
            if !explicit_retry {
                return with_read_connection(|connection| get_card(connection, &id))?
                    .ok_or_else(|| "Kanban card was not found".to_string());
            }
            if setup_process_alive(&op.result_path) {
                return with_read_connection(|connection| get_card(connection, &id))?
                    .ok_or_else(|| "Kanban card was not found".to_string());
            }
            let current_worktrees =
                serde_json::to_string(&worktree_inventory(&op.target_checkout_path)?)
                    .map_err(|e| e.to_string())?;
            let current_branches =
                serde_json::to_string(&branch_inventory(&op.target_checkout_path)?)
                    .map_err(|e| e.to_string())?;
            if op.attempt_token.is_some()
                && (current_worktrees != op.pre_worktrees || current_branches != op.pre_branches)
            {
                return creation_recovery(&id, "Explicit retry was refused because repository resources changed after the original snapshot", false);
            }
            if op.attempt_token.is_none() {
                let target = validate_checkout(&op.target_checkout_path, Some(&op.repository_id))?;
                if target.target_branch != op.target_branch {
                    return creation_recovery(
                        &id,
                        "The target checkout is no longer on the configured branch",
                        false,
                    );
                }
                with_board_mutation(|connection| {
                    connection.execute("UPDATE environment_creation_operations SET observed_target_revision=?1,pre_worktrees=?2,pre_branches=?3,error=NULL,revision=revision+1,updated_at=?4 WHERE card_id=?5", params![target.target_revision,current_worktrees,current_branches,unix_timestamp(),id]).map(|_| ()).map_err(db_error)
                })?;
                op.observed_target_revision = target.target_revision;
                op.pre_worktrees = current_worktrees;
                op.pre_branches = current_branches;
            }
            update_creation_phase(&id, "prepared", None, false)?;
            op.phase = "prepared".to_string();
        }
    }
    if op.phase == "compensation_pending" {
        if op.source_path.is_none() {
            match persist_validated_source(&op, None) {
                Ok(validated) => {
                    update_creation_phase(
                        &id,
                        "compensation_pending",
                        Some("Resuming interrupted compensation"),
                        true,
                    )?;
                    op = validated;
                }
                Err(error) => return creation_recovery(&id, &error, false),
            }
        }
        return compensate_creation(&op);
    }
    if op.phase == "prepared" {
        let target = validate_checkout(&op.target_checkout_path, Some(&op.repository_id))?;
        let current_worktrees =
            serde_json::to_string(&worktree_inventory(&op.target_checkout_path)?)
                .map_err(|error| error.to_string())?;
        let current_branches = serde_json::to_string(&branch_inventory(&op.target_checkout_path)?)
            .map_err(|error| error.to_string())?;
        if target.target_branch != op.target_branch
            || target.target_revision != op.observed_target_revision
            || current_worktrees != op.pre_worktrees
            || current_branches != op.pre_branches
        {
            return creation_recovery(
                &id,
                "The target repository changed after environment creation was prepared; setup was not run",
                false,
            );
        }
        let token = uuid::Uuid::new_v4().to_string();
        with_board_mutation(|connection| {
            connection.execute("UPDATE environment_creation_operations SET phase='setup_running',attempt_token=?1,error=NULL,revision=revision+1,updated_at=?2 WHERE card_id=?3 AND phase='prepared'", params![token,unix_timestamp(),id]).map(|_| ()).map_err(db_error)
        })?;
        match run_workspace_setup_durable(
            op.setup_command.clone(),
            op.target_checkout_path.clone(),
            cancelled,
            Path::new(&op.result_path),
        ) {
            Ok(result) => {
                with_board_mutation(|connection| {
                    connection.execute("UPDATE environment_creation_operations SET phase='setup_complete',setup_result_cwd=?1,setup_output=?2,revision=revision+1,updated_at=?3 WHERE card_id=?4", params![result.cwd,result.output,unix_timestamp(),id]).map(|_| ()).map_err(db_error)
                })?;
            }
            Err(error) => {
                update_creation_phase(&id, "compensation_pending", Some(&error), false)?;
                op = with_read_connection(|connection| load_creation_operation_row(connection, &id))?
                    .unwrap();
                match persist_validated_source(&op, None) {
                    Ok(validated) => {
                        update_creation_phase(&id, "compensation_pending", Some(&error), true)?;
                        return compensate_creation(&validated);
                    }
                    Err(_) => {
                        return creation_recovery(
                            &id,
                            &format!(
                                "Setup failed and its Git resource changes are ambiguous: {error}"
                            ),
                            false,
                        )
                    }
                }
            }
        }
        op = with_read_connection(|connection| load_creation_operation_row(connection, &id))?.unwrap();
    } else if op.phase == "setup_running" {
        if Path::new(&op.result_path).is_file() {
            let cwd = fs::read_to_string(&op.result_path)
                .map_err(|e| e.to_string())?
                .trim()
                .to_string();
            with_board_mutation(|connection| {
                connection.execute("UPDATE environment_creation_operations SET phase='setup_complete',setup_result_cwd=?1,revision=revision+1,updated_at=?2 WHERE card_id=?3", params![cwd,unix_timestamp(),id]).map(|_| ()).map_err(db_error)
            })?;
            op = with_read_connection(|connection| load_creation_operation_row(connection, &id))?
                .unwrap();
        } else if setup_process_alive(&op.result_path) {
            update_creation_phase(
                &id,
                "setup_running",
                Some("Setup is still running in the background. Resume after it finishes."),
                false,
            )?;
            return with_read_connection(|connection| get_card(connection, &id))?
                .ok_or_else(|| "Kanban card was not found".to_string());
        } else {
            return creation_recovery(
                &id,
                if op.custom_command {
                    "Custom setup was interrupted with no durable completion result. Review the repository, then explicitly retry."
                } else {
                    "Setup was interrupted with no durable completion result. Review the repository before retrying."
                },
                false,
            );
        }
    }
    if op.phase == "setup_complete" && op.source_path.is_none() {
        match persist_validated_source(&op, op.setup_result_cwd.as_deref()) {
            Ok(value) => op = value,
            Err(error) => {
                update_creation_phase(&id, "compensation_pending", Some(&error), false)?;
                match persist_validated_source(&op, None) {
                    Ok(validated) => {
                        update_creation_phase(&id, "compensation_pending", Some(&error), true)?;
                        return compensate_creation(&validated);
                    }
                    Err(_) => return creation_recovery(&id, &error, false),
                }
            }
        }
    }
    let target = match validate_checkout(&op.target_checkout_path, Some(&op.repository_id)) {
        Ok(target)
            if target.target_checkout_path == op.target_checkout_path
                && target.target_branch == op.target_branch =>
        {
            target
        }
        Ok(_) => {
            update_creation_phase(
                &id,
                "compensation_pending",
                Some("Target checkout identity or branch changed during setup"),
                true,
            )?;
            return compensate_creation(&op);
        }
        Err(error) => {
            update_creation_phase(&id, "compensation_pending", Some(&error), true)?;
            return compensate_creation(&op);
        }
    };
    update_creation_phase(&id, "attaching", None, false)?;
    match kanban_create_environment(
        id.clone(),
        op.source_path.clone().unwrap(),
        op.repository_id.clone(),
        op.target_checkout_path.clone(),
        op.target_branch.clone(),
        target.target_revision,
        op.expected_workflow_revision,
    ) {
        Ok(card) => {
            let _ = fs::remove_file(&op.result_path);
            Ok(card)
        }
        Err(error) => {
            update_creation_phase(&id, "compensation_pending", Some(&error), true)?;
            op = with_read_connection(|connection| load_creation_operation_row(connection, &id))?
                .unwrap();
            compensate_creation(&op)
        }
    }
}

pub(in crate::kanban) async fn kanban_start_environment_operation(
    state: State<'_, WorkspaceSetupState>,
    id: String,
    expected_workflow_revision: i64,
    setup_command: String,
    custom_command: bool,
    explicit_retry: Option<bool>,
) -> Result<KanbanCard, String> {
    let operation_id = format!("environment:{id}");
    let cancelled = state.begin(&operation_id)?;
    let worker_cancelled = std::sync::Arc::clone(&cancelled);
    let worker_id = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        coordinate_card_repository(&worker_id, false, || {
            run_environment_creation(
                worker_id.clone(),
                expected_workflow_revision,
                setup_command,
                custom_command,
                explicit_retry.unwrap_or(false),
                &worker_cancelled,
            )
        })
    })
    .await
    .map_err(|error| format!("Environment creation worker failed: {error}"))?;
    state.finish(&operation_id, &cancelled);
    result
}

pub(in crate::kanban) async fn kanban_cleanup_environment_creation_operation(
    id: String,
) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        coordinate_card_repository(&id, false, || {
            let op = with_read_connection(|connection| {
                require_structural_capability(connection, &id, WorkflowAction::CleanupCreation)?;
                load_creation_operation_row(connection, &id)
            })?
            .ok_or_else(|| "No environment creation recovery is pending".to_string())?;
            if !op.source_worktree_new {
                return Err(
                    "Cleanup is unavailable because ownership of the source worktree is not proven"
                        .to_string(),
                );
            }
            update_creation_phase(
                &id,
                "compensation_pending",
                op.source_path
                    .as_ref()
                    .map(|_| "User requested recovery cleanup"),
                true,
            )?;
            compensate_creation(&op)
        })
    })
    .await
    .map_err(|error| format!("Environment cleanup worker failed: {error}"))?
}

pub(in crate::kanban) fn kanban_environment_start_preflight_operation(
    id: String,
    expected_workflow_revision: i64,
) -> Result<EnvironmentStartPreflight, String> {
    with_read_connection(|connection| {
        let (status, revision, project_id, provider, finalized): (CardStatus, i64, String, String, bool) = connection
            .query_row(
                "SELECT status, workflow_revision, project_id, external_provider, hierarchy_finalized FROM kanban_cards WHERE id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get::<_, i64>(4)? != 0)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Kanban card was not found or has invalid project ownership".to_string())?;
        if revision != expected_workflow_revision {
            return Err("Card changed; reload before starting work".to_string());
        }
        let _ = (status, finalized);
        require_structural_capability(connection, &id, WorkflowAction::StartWork)?;
        let source: String = connection
            .query_row(
                "SELECT COALESCE(kanban_source, 'local') FROM projects WHERE id=?1",
                [&project_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "The card's owning project no longer exists".to_string())?;
        if (provider == "superthread") != (source == "superthread") {
            return Err(
                "The card's owning project is not compatible with its provider".to_string(),
            );
        }
        let settings = project_delivery_settings(connection, &id)?;
        let preflight = validate_target_checkout(&settings.path, None)?;
        if preflight.target_branch != settings.target_branch {
            return Err(format!(
                "Project checkout must be clean and checked out on configured target branch {}",
                settings.target_branch
            ));
        }
        Ok(preflight)
    })
}

#[allow(clippy::too_many_arguments)]
pub(in crate::kanban) fn kanban_create_environment(
    id: String,
    worktree_path: String,
    repository_id: String,
    target_checkout_path: String,
    target_branch: String,
    target_revision: String,
    expected_workflow_revision: i64,
) -> Result<KanbanCard, String> {
    if worktree_path.trim().is_empty() {
        return Err("Worktree path is required".to_string());
    }
    let project_path_snapshot = with_read_connection(|connection| {
        let card = require_structural_capability(connection, &id, WorkflowAction::StartWork)?;
        if card.workflow_revision != expected_workflow_revision {
            return Err("Card changed; reload before creating its environment".to_string());
        }
        connection.query_row(
            "SELECT p.path FROM kanban_cards c JOIN projects p ON p.id=c.project_id WHERE c.id=?1",
            [&id],
            |row| row.get::<_, String>(0),
        ).optional().map_err(db_error)?.ok_or_else(|| "The card's owning project no longer exists".to_string())
    })?;
    let project_repository = repository_identity(&project_path_snapshot)?;
    let target = validate_target_checkout(&target_checkout_path, Some(&repository_id))?;
    if target.target_branch != target_branch || target.target_revision != target_revision {
        return Err(format!(
            "Target checkout changed during setup: {target_checkout_path}"
        ));
    }
    let source = validate_checkout(&worktree_path, Some(&repository_id))?;
    if source.target_checkout_path == target_checkout_path {
        return Err(format!(
            "Setup returned the target checkout itself: {worktree_path}"
        ));
    }
    if source.target_branch == target_branch {
        return Err(format!(
            "Setup must create a source branch different from {target_branch}: {worktree_path}"
        ));
    }
    ensure_registered_distinct_worktree(&target_checkout_path, &worktree_path)?;
    with_board_mutation(|connection| {
        ensure_card_directory(&id)?;
        let transaction = connection.savepoint().map_err(db_error)?;
        let (card_status, workflow_revision, project_id, provider, finalized): (CardStatus, i64, String, String, bool) = transaction
            .query_row(
                "SELECT status, workflow_revision, project_id, external_provider, hierarchy_finalized FROM kanban_cards WHERE id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get::<_, i64>(4)? != 0)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Kanban card was not found".to_string())?;
        if workflow_revision != expected_workflow_revision {
            return Err("Card changed; reload before creating its environment".to_string());
        }
        let _ = (card_status, finalized);
        require_structural_capability(&transaction, &id, WorkflowAction::StartWork)?;
        let (current_project_path, project_source): (String, String) = transaction
            .query_row(
                "SELECT path, COALESCE(kanban_source, 'local') FROM projects WHERE id=?1",
                [&project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "The card's owning project no longer exists".to_string())?;
        if (provider == "superthread") != (project_source == "superthread") {
            return Err(
                "The card's owning project is not compatible with its provider".to_string(),
            );
        }
        if current_project_path != project_path_snapshot || project_repository != repository_id {
            return Err(
                "The card project's configured checkout belongs to a different repository"
                    .to_string(),
            );
        }
        let environment_id = format!("environment:{}", uuid::Uuid::new_v4());
        let now = unix_timestamp();
        transaction.execute(
            "INSERT INTO card_environments
             (id, card_id, project_id, worktree_path, branch, repository_id, target_checkout_path, target_branch, source_revision, target_revision, lifecycle_state, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'ready', 1, ?11, ?11)
             ON CONFLICT(card_id) DO UPDATE SET project_id = excluded.project_id,
               worktree_path = excluded.worktree_path, branch = excluded.branch,
               repository_id = excluded.repository_id, target_checkout_path = excluded.target_checkout_path,
               target_branch = excluded.target_branch, source_revision = excluded.source_revision,
               target_revision = excluded.target_revision, lifecycle_state = 'ready',
               revision = card_environments.revision + 1, updated_at = excluded.updated_at",
            params![environment_id, id, project_id, worktree_path.trim(), source.target_branch, repository_id,
                target_checkout_path, target_branch, source.target_revision, target_revision, now],
        ).map_err(db_error)?;
        let environment_id: String = transaction
            .query_row(
                "SELECT id FROM card_environments WHERE card_id = ?1",
                [&id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        let shell_pane = format!("kanban-card:{id}:terminal:shell");
        transaction.execute(
            "INSERT OR IGNORE INTO card_panes (id, environment_id, role, kind, sort_order) VALUES (?1, ?2, 'shell', 'terminal', 0)",
            params![shell_pane, environment_id],
        ).map_err(db_error)?;
        for (index, thread) in ["planning", "work"].into_iter().enumerate() {
            transaction.execute(
                "INSERT OR IGNORE INTO card_panes (id, environment_id, role, kind, sort_order) VALUES (?1, ?2, ?3, 'pi', ?4)",
                params![format!("kanban-card:{id}:{thread}"), environment_id, thread, index as i64 + 1],
            ).map_err(db_error)?;
        }
        transaction.execute(
            "INSERT OR IGNORE INTO card_layouts (environment_id, split_layout, focused_pane_id, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![environment_id, serde_json::json!({"kind":"leaf", "terminalId":shell_pane}).to_string(), shell_pane, now],
        ).map_err(db_error)?;
        transaction
            .execute(
                "UPDATE kanban_cards SET project_id=?1,workspace_id=NULL WHERE id=?2",
                params![project_id, id],
            )
            .map_err(db_error)?;
        apply_workflow_transition(
            &transaction,
            &id,
            WorkflowActor::User,
            WorkflowAction::StartWork,
            Some(expected_workflow_revision),
            "environment_start",
            Some(&format!(
                "Created source worktree {} on {}",
                worktree_path, source.target_branch
            )),
        )?;
        transaction
            .execute(
                "DELETE FROM environment_creation_operations WHERE card_id=?1",
                [&id],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
    })
}

pub(in crate::kanban) fn kanban_save_environment_layout_operation(
    id: String,
    split_layout: serde_json::Value,
    focused_pane_id: Option<String>,
    panes: Vec<CardPane>,
    expected_layout_revision: i64,
) -> Result<KanbanCard, String> {
    with_board_mutation(|connection| {
        validate_card_environment_project(connection, &id)?;
        save_environment_layout(
            connection,
            &id,
            split_layout,
            focused_pane_id,
            panes,
            expected_layout_revision,
        )?;
        get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
    })
}

pub(in crate::kanban) fn save_environment_layout(
    connection: &mut Connection,
    card_id: &str,
    split_layout: serde_json::Value,
    focused_pane_id: Option<String>,
    panes: Vec<CardPane>,
    expected_layout_revision: i64,
) -> Result<(), String> {
    let transaction = connection
        .savepoint()
        .map_err(db_error)?;
    let environment_id: String = transaction
        .query_row(
            "SELECT id FROM card_environments WHERE card_id = ?1",
            [card_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Card environment was not found".to_string())?;
    let updated = transaction
        .execute(
            "UPDATE card_layouts
             SET split_layout = ?1, focused_pane_id = ?2, layout_revision = layout_revision + 1, updated_at = ?3
             WHERE environment_id = ?4 AND layout_revision = ?5",
            params![
                split_layout.to_string(),
                focused_pane_id,
                unix_timestamp(),
                environment_id,
                expected_layout_revision
            ],
        )
        .map_err(db_error)?;
    if updated != 1 {
        return Err("Card layout changed; reload before saving the layout".to_string());
    }
    transaction
        .execute(
            "DELETE FROM card_panes WHERE environment_id = ?1 AND role = 'shell'",
            [&environment_id],
        )
        .map_err(db_error)?;
    for (index, pane) in panes.into_iter().enumerate() {
        transaction.execute(
            "INSERT INTO card_panes (id, environment_id, role, kind, command, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![pane.id, environment_id, pane.role, pane.kind, pane.command, index as i64],
        ).map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)
}

pub(in crate::kanban) fn kanban_set_merge_target_operation(
    id: String,
    target_checkout_path: String,
    expected_environment_revision: i64,
) -> Result<KanbanCard, String> {
    let identity = card_repository_identity(&id, true)?;
    if repository_coordinator::repository_identity(&target_checkout_path)? != identity {
        return Err("The merge target belongs to a different repository".to_string());
    }
    repository_coordinator::global().coordinate(&identity, || with_board_mutation(|connection| {
        validate_card_environment_project(connection, &id)?;
        if card_repository_identity(&id, true)? != identity {
            return Err("The card repository changed while the operation was waiting; retry".to_string());
        }
        let (source_path, expected_repository): (String, Option<String>) = connection.query_row("SELECT worktree_path, repository_id FROM card_environments WHERE card_id=?1 AND revision=?2", params![id, expected_environment_revision], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(db_error)?.ok_or_else(|| "Card environment changed; reload before setting its merge target".to_string())?;
        let source_repository = repository_identity(&source_path)?;
        if expected_repository.is_some_and(|expected| expected != source_repository) {
            return Err("Recorded source repository no longer matches".to_string());
        }
        let target = validate_checkout(&target_checkout_path, Some(&source_repository))?;
        ensure_registered_distinct_worktree(&target.target_checkout_path, &source_path)?;
        let source_branch = git_output(
            &source_path,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
        )?;
        if source_branch == target.target_branch {
            return Err("Source and target branches must be different".to_string());
        }
        connection.execute("UPDATE card_environments SET repository_id=?1, target_checkout_path=?2, target_branch=?3, target_revision=?4, source_revision=?5, revision=revision+1, updated_at=?6 WHERE card_id=?7 AND revision=?8",
            params![source_repository, target.target_checkout_path, target.target_branch, target.target_revision, git_output(&source_path, &["rev-parse", "HEAD"])?, unix_timestamp(), id, expected_environment_revision]).map_err(db_error)?;
        get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
    }))
}
