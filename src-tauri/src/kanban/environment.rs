use super::*;
use super::{cards::*, git_effects::*, github_delivery::*, health::*, repository::*};

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

pub(in crate::kanban) fn kanban_environment_start_preflight_operation(
    id: String,
    expected_workflow_revision: i64,
) -> Result<EnvironmentStartPreflight, String> {
    with_connection(|connection| {
        let (status, revision, project_id, provider, finalized): (String, i64, String, String, bool) = connection
            .query_row(
                "SELECT status, workflow_revision, project_id, external_provider, hierarchy_finalized FROM kanban_cards WHERE id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get::<_, i64>(4)? != 0)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Kanban card was not found or has invalid project ownership".to_string())?;
        if finalized {
            return Err("A finalized aggregate parent cannot start work".to_string());
        }
        if revision != expected_workflow_revision {
            return Err("Card changed; reload before starting work".to_string());
        }
        if status != "ready" {
            return Err("The card must be Ready for agent before work can start".to_string());
        }
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

pub(in crate::kanban) fn kanban_create_environment_operation(
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
    let target = validate_target_checkout(&target_checkout_path, Some(&repository_id))?;
    if target.target_branch != target_branch || target.target_revision != target_revision {
        return Err(format!("Target checkout changed during setup: {target_checkout_path}. Recover the setup result manually."));
    }
    let source = validate_checkout(&worktree_path, Some(&repository_id))?;
    if source.target_checkout_path == target_checkout_path {
        return Err(format!("Setup returned the target checkout itself: {worktree_path}. Recover any setup output manually."));
    }
    if source.target_branch == target_branch {
        return Err(format!("Setup must create a source branch different from {target_branch}: {worktree_path}. Recover it manually."));
    }
    ensure_registered_distinct_worktree(&target_checkout_path, &worktree_path)?;
    with_connection(|connection| {
        ensure_card_directory(&id)?;
        let transaction = connection.transaction().map_err(db_error)?;
        let (card_status, workflow_revision, project_id, provider, finalized): (String, i64, String, String, bool) = transaction
            .query_row(
                "SELECT status, workflow_revision, project_id, external_provider, hierarchy_finalized FROM kanban_cards WHERE id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get::<_, i64>(4)? != 0)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Kanban card was not found".to_string())?;
        if finalized {
            return Err("A finalized aggregate parent cannot create an environment".to_string());
        }
        if workflow_revision != expected_workflow_revision {
            return Err("Card changed; reload before creating its environment".to_string());
        }
        if card_status != "ready" {
            return Err(
                "A card environment can only be created when the card is ready for agent work"
                    .to_string(),
            );
        }
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
        if repository_identity(&current_project_path)? != repository_id {
            return Err("The card project's configured checkout belongs to a different repository; recover the setup result manually".to_string());
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
        transaction.execute(
            "UPDATE kanban_cards SET project_id = ?1, workspace_id = NULL, status = 'agent_working', workflow_revision = workflow_revision + 1, updated_at = ?2,
             sort_order = (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards AS destination WHERE destination.status = 'agent_working') WHERE id = ?3",
            params![project_id, now, id],
        ).map_err(db_error)?;
        transaction.execute("INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, from_status, to_status, summary) VALUES (?1, ?2, 'user', 'environment_start', 'success', 'ready', 'agent_working', ?3)",
            params![id, now, format!("Created source worktree {} on {}", worktree_path, source.target_branch)]).map_err(db_error)?;
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
    with_connection(|connection| {
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
        .transaction_with_behavior(TransactionBehavior::Immediate)
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
    with_connection(|connection| {
        validate_card_environment_project(connection, &id)?;
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
    })
}
