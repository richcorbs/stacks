use super::*;
#[allow(unused_imports)]
use super::{
    cleanup::*, domain::*, environment::*, git_effects::*, github_delivery::*, health::*,
    local_delivery::*, repository::*, sync::*,
};

pub(in crate::kanban) fn kanban_cards_operation() -> Result<BoardSnapshot, String> {
    with_connection(board_snapshot)
}

pub(in crate::kanban) fn kanban_card_snapshot_operation(
    id: String,
) -> Result<CardSnapshot, String> {
    with_connection(|connection| {
        let card =
            get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())?;
        Ok(CardSnapshot {
            card,
            board_revision: board_revision(connection)?,
        })
    })
}

pub(in crate::kanban) async fn kanban_environment_health_operation(
    card_ids: Vec<String>,
) -> Result<Vec<CardEnvironmentHealth>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_connection(|connection| {
            card_ids
                .iter()
                .map(|card_id| environment_health(connection, card_id))
                .collect()
        })
    })
    .await
    .map_err(|error| format!("Environment health worker failed: {error}"))?
}

pub(in crate::kanban) fn kanban_create_local_card_operation(
    project_id: String,
    title: String,
    content: String,
    parent_id: Option<String>,
) -> Result<CardSnapshot, String> {
    let scope = crate::store::pi_project_scope(&project_id)?;
    if !is_local_kanban_source(&scope.kanban_source) {
        return Err("Cards can only be created for a local Kanban project".to_string());
    }
    let id = with_connection(|connection| {
        let card = create_local_card(connection, &scope.id, &scope.name, &title, &content)?;
        if let Some(parent_id) = parent_id.as_deref() {
            set_card_parent(connection, &card.id, Some(parent_id))?;
        }
        Ok(card.id)
    })?;
    fresh_card_snapshot(&id)
}

pub(crate) fn create_local_card_for_project(
    project_id: &str,
    title: &str,
    content: &str,
) -> Result<KanbanCard, String> {
    let scope = crate::store::pi_project_scope(project_id)?;
    if !is_local_kanban_source(&scope.kanban_source) {
        return Err("Cards can only be created for a local Kanban project".to_string());
    }
    with_connection(|connection| {
        create_local_card(connection, &scope.id, &scope.name, title, content)
    })
}

pub(in crate::kanban) fn create_local_card(
    connection: &mut Connection,
    project_id: &str,
    project_name: &str,
    title: &str,
    content: &str,
) -> Result<KanbanCard, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Card title is required".to_string());
    }
    let transaction = connection.transaction().map_err(db_error)?;
    let next_number = next_local_card_number(&transaction, project_id)?;
    let id = format!("local:{}", uuid::Uuid::new_v4());
    let now = unix_timestamp();
    let sort_order: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards WHERE status = 'needs_refinement'",
        [], |row| row.get(0),
    ).map_err(db_error)?;
    transaction.execute(
        "INSERT INTO kanban_cards
         (id, external_provider, external_id, title, content, board_id, board_title, status, project_id, created_at, updated_at, sort_order, in_scope)
         VALUES (?1, 'local:' || ?5, ?2, ?3, ?4, ?5, ?6, 'needs_refinement', ?5, ?7, ?7, ?8, 1)",
        params![id, next_number.to_string(), title, content.trim(), project_id, project_name.trim(), now, sort_order],
    ).map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    get_card(connection, &id)?.ok_or_else(|| "Created card was not found".to_string())
}

pub(crate) fn card_project_id(id: &str) -> Result<Option<String>, String> {
    with_connection(|connection| {
        connection
            .query_row(
                "SELECT project_id FROM kanban_cards WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)
    })
}

pub(in crate::kanban) fn kanban_update_local_card_operation(
    id: String,
    title: Option<String>,
    content: Option<String>,
    parent_id: Option<String>,
    parent_specified: Option<bool>,
) -> Result<CardSnapshot, String> {
    with_connection(|connection| {
        if title.is_some() || content.is_some() {
            update_local_card(connection, &id, title.as_deref(), content.as_deref())?;
        }
        if parent_specified.unwrap_or(false) {
            set_card_parent(connection, &id, parent_id.as_deref())?;
        }
        Ok(())
    })?;
    fresh_card_snapshot(&id)
}

pub(crate) fn update_local_card(
    connection: &Connection,
    id: &str,
    title: Option<&str>,
    content: Option<&str>,
) -> Result<KanbanCard, String> {
    if !id.starts_with("local:") {
        return Err("Only local cards can be updated from a Stacks Pi session".to_string());
    }
    if title.is_none() && content.is_none() {
        return Err("A title or description is required".to_string());
    }
    let title = title.map(str::trim);
    if title.is_some_and(str::is_empty) {
        return Err("Card title cannot be empty".to_string());
    }
    let changed = connection.execute(
        "UPDATE kanban_cards SET title = COALESCE(?1, title), content = COALESCE(?2, content), updated_at = ?3
         WHERE id = ?4 AND external_provider LIKE 'local:%' AND hierarchy_finalized = 0",
        params![title, content.map(str::trim), unix_timestamp(), id],
    ).map_err(db_error)?;
    if changed == 0 {
        return Err("Local Kanban card was not found".to_string());
    }
    get_card(connection, id)?.ok_or_else(|| "Local Kanban card was not found".to_string())
}

pub(in crate::kanban) fn kanban_finish_local_refinement_operation(
    id: String,
    title: Option<String>,
    content: String,
    children: Option<Vec<ApprovedChildSpec>>,
) -> Result<KanbanCard, String> {
    with_connection(|connection| {
        finish_local_refinement(
            connection,
            &id,
            title.as_deref(),
            &content,
            children.as_deref(),
        )
    })
}

pub(crate) fn finish_local_refinement(
    connection: &mut Connection,
    id: &str,
    title: Option<&str>,
    content: &str,
    children: Option<&[ApprovedChildSpec]>,
) -> Result<KanbanCard, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("A final card description is required before finishing refinement".to_string());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let (source_status, project_id, parent_id, finalized, existing_child_count): (CardStatus, String, Option<String>, bool, i64) = transaction
        .query_row(
            "SELECT status, project_id, parent_id, hierarchy_finalized, (SELECT COUNT(*) FROM kanban_cards child WHERE child.parent_id=kanban_cards.id) FROM kanban_cards WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get::<_, i64>(3)? != 0, row.get(4)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Local Kanban card was not found".to_string())?;
    if finalized || parent_id.is_some() && children.is_some_and(|items| !items.is_empty()) {
        return Err("A child or finalized aggregate cannot be finalized as a parent".to_string());
    }
    if existing_child_count > 0 && children.is_none_or(|items| items.is_empty()) {
        return Err("The approved breakdown must include every existing linked child".to_string());
    }
    update_local_card(&transaction, id, title, Some(content))?;
    if let Some(children) = children.filter(|items| !items.is_empty()) {
        finalize_breakdown(&transaction, id, &project_id, children)?;
    } else if source_status != "ready" {
        apply_workflow_transition(
            &transaction,
            id,
            WorkflowActor::Agent,
            WorkflowAction::FinishRefinement,
            None,
            "finish_refinement",
            None,
        )?;
    }
    transaction.commit().map_err(db_error)?;
    get_card(connection, id)?.ok_or_else(|| "Local Kanban card was not found".to_string())
}

pub(in crate::kanban) fn set_card_parent(
    connection: &Connection,
    child_id: &str,
    parent_id: Option<&str>,
) -> Result<KanbanCard, String> {
    let (provider, status, project_id, has_children, finalized): (String, CardStatus, Option<String>, bool, bool) = connection.query_row(
        "SELECT external_provider, status, project_id, EXISTS(SELECT 1 FROM kanban_cards WHERE parent_id=c.id), hierarchy_finalized FROM kanban_cards c WHERE id=?1",
        [child_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get::<_, i64>(3)? != 0, row.get::<_, i64>(4)? != 0)),
    ).optional().map_err(db_error)?.ok_or_else(|| "Local Kanban card was not found".to_string())?;
    if !provider.starts_with("local:") || status != "needs_refinement" || finalized {
        return Err("A parent can only be changed on a local card in Needs refinement".to_string());
    }
    if has_children {
        return Err("A parent card cannot itself have a parent".to_string());
    }
    if let Some(parent_id) = parent_id {
        if parent_id == child_id {
            return Err("A card cannot be its own parent".to_string());
        }
        let (parent_provider, parent_project, parent_parent, parent_environment, parent_status, parent_finalized): (String, Option<String>, Option<String>, bool, CardStatus, bool) = connection.query_row(
            "SELECT external_provider, project_id, parent_id, EXISTS(SELECT 1 FROM card_environments WHERE card_id=kanban_cards.id), status, hierarchy_finalized FROM kanban_cards WHERE id=?1",
            [parent_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get::<_, i64>(3)? != 0, row.get(4)?, row.get::<_, i64>(5)? != 0)),
        ).optional().map_err(db_error)?.ok_or_else(|| "The selected parent was not found".to_string())?;
        if !parent_provider.starts_with("local:") || parent_project != project_id {
            return Err("Parent and child must be local cards in the same project".to_string());
        }
        if parent_parent.is_some() {
            return Err("A child card cannot itself have children".to_string());
        }
        if parent_environment
            || parent_finalized
            || !matches!(
                parent_status.as_str(),
                "needs_refinement" | "refining" | "needs_refinement_input" | "ready"
            )
        {
            return Err(
                "The selected card is not eligible to become an aggregate parent".to_string(),
            );
        }
    }
    connection
        .execute(
            "UPDATE kanban_cards SET parent_id=?1, updated_at=?2 WHERE id=?3",
            params![parent_id, unix_timestamp(), child_id],
        )
        .map_err(db_error)?;
    get_card(connection, child_id)?.ok_or_else(|| "Local Kanban card was not found".to_string())
}

pub(in crate::kanban) fn finalize_breakdown(
    transaction: &rusqlite::Transaction<'_>,
    parent_id: &str,
    project_id: &str,
    specs: &[ApprovedChildSpec],
) -> Result<(), String> {
    use std::collections::HashSet;
    let existing = transaction
        .prepare("SELECT id FROM kanban_cards WHERE parent_id=?1 ORDER BY id")
        .map_err(db_error)?
        .query_map([parent_id], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let supplied = specs
        .iter()
        .filter_map(|spec| spec.id.clone())
        .collect::<Vec<_>>();
    if supplied.iter().collect::<HashSet<_>>().len() != supplied.len() {
        return Err("Each existing child must appear exactly once".to_string());
    }
    let mut expected = existing.clone();
    expected.sort();
    let mut received = supplied.clone();
    received.sort();
    if expected != received {
        return Err("The approved breakdown must include every existing linked child and no unrelated cards".to_string());
    }
    let now = unix_timestamp();
    for spec in specs {
        let title = spec.title.trim();
        let content = spec.content.trim();
        if title.is_empty() || content.is_empty() {
            return Err(
                "Every approved child needs a title and a self-contained brief".to_string(),
            );
        }
        let child_id = if let Some(child_id) = &spec.id {
            let (child_project, child_parent, status, provider): (Option<String>, Option<String>, CardStatus, String) = transaction.query_row(
                "SELECT project_id, parent_id, status, external_provider FROM kanban_cards WHERE id=?1",
                [child_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            ).optional().map_err(db_error)?.ok_or_else(|| "An approved existing child was not found".to_string())?;
            if child_project.as_deref() != Some(project_id)
                || child_parent.as_deref() != Some(parent_id)
                || !provider.starts_with("local:")
                || status != "needs_refinement"
            {
                return Err("Existing children must be linked local Needs refinement cards in the parent's project".to_string());
            }
            transaction
                .execute(
                    "UPDATE kanban_cards SET title=?1, content=?2 WHERE id=?3",
                    params![title, content, child_id],
                )
                .map_err(db_error)?;
            child_id.clone()
        } else {
            let number = next_local_card_number(transaction, project_id)?;
            let child_id = format!("local:{}", uuid::Uuid::new_v4());
            let project_name: String = transaction
                .query_row(
                    "SELECT name FROM projects WHERE id=?1",
                    [project_id],
                    |row| row.get(0),
                )
                .map_err(db_error)?;
            transaction.execute(
                "INSERT INTO kanban_cards (id, external_provider, external_id, title, content, board_id, board_title, status, project_id, parent_id, created_at, updated_at, sort_order, in_scope)
                 VALUES (?1, 'local:' || ?2, ?3, ?4, ?5, ?2, ?6, 'needs_refinement', ?2, ?7, ?8, ?8,
                    (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards WHERE status='needs_refinement'), 1)",
                params![child_id, project_id, number.to_string(), title, content, project_name, parent_id, now],
            ).map_err(db_error)?;
            child_id
        };
        transaction
            .execute(
                "UPDATE kanban_cards SET parent_id=?1,updated_at=?2 WHERE id=?3",
                params![parent_id, now, child_id],
            )
            .map_err(db_error)?;
        apply_workflow_transition(
            transaction,
            &child_id,
            WorkflowActor::Agent,
            WorkflowAction::FinishRefinement,
            None,
            "finish_refinement",
            Some("Approved as part of card breakdown"),
        )?;
    }
    apply_workflow_transition(
        transaction,
        parent_id,
        WorkflowActor::Agent,
        WorkflowAction::FinishRefinement,
        None,
        "finish_refinement",
        Some("Approved card breakdown"),
    )?;
    transaction
        .execute(
            "UPDATE kanban_cards SET hierarchy_finalized=1,updated_at=?1 WHERE id=?2",
            params![now, parent_id],
        )
        .map_err(db_error)?;
    Ok(())
}

pub(in crate::kanban) fn kanban_open_card_operation(id: String) -> Result<String, String> {
    with_connection(|connection| {
        if get_card(connection, &id)?.is_none() {
            return Err("Kanban card was not found".to_string());
        }
        let directory = ensure_card_directory(&id)?;
        directory
            .to_str()
            .map(str::to_string)
            .ok_or_else(|| "Card directory is not valid UTF-8".to_string())
    })
}

pub(crate) fn card_directory(id: &str) -> Result<std::path::PathBuf, String> {
    let mut directory = crate::fs_paths::app_data_dir()?;
    directory.push("cards");
    directory.push(safe_card_key(id));
    Ok(directory)
}

pub(crate) struct CardPiSession {
    pub card_id: String,
    pub thread: String,
    pub directory: std::path::PathBuf,
}

pub(crate) fn validate_card_pi_start(
    card_id: &str,
    thread: &str,
    cwd: &str,
    supplied_project_id: &str,
) -> Result<(), String> {
    with_connection(|connection| {
        let (project_id, provider, project_path): (String, String, String) = connection.query_row(
            "SELECT c.project_id, c.external_provider, p.path FROM kanban_cards c JOIN projects p ON p.id=c.project_id WHERE c.id=?1",
            [card_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(db_error)?.ok_or_else(|| "The card-scoped Pi session has invalid project ownership".to_string())?;
        if project_id != supplied_project_id {
            return Err(
                "The card-scoped Pi session does not belong to the supplied Stacks project"
                    .to_string(),
            );
        }
        let source: String = connection
            .query_row(
                "SELECT COALESCE(kanban_source, 'local') FROM projects WHERE id=?1",
                [&project_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if (provider == "superthread") != (source == "superthread") {
            return Err(
                "The card's owning project is not compatible with its provider".to_string(),
            );
        }
        let expected_path = if thread == "work" {
            validate_card_environment_project(connection, card_id)?;
            connection
                .query_row(
                    "SELECT worktree_path FROM card_environments WHERE card_id=?1",
                    [card_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(db_error)?
        } else {
            project_path
        };
        if Path::new(cwd).canonicalize().ok() != Path::new(&expected_path).canonicalize().ok() {
            return Err("Card Pi startup was blocked because its CWD does not match its owning project environment".to_string());
        }
        Ok(())
    })
}

pub(crate) fn validate_card_terminal_start(
    terminal_id: &str,
    cwd: &str,
    requested_command: Option<String>,
) -> Result<Option<String>, String> {
    let Some(scoped) = terminal_id.strip_prefix("kanban-card:") else {
        return Ok(requested_command);
    };
    let Some((card_id, role)) = scoped.rsplit_once(":terminal:") else {
        return Ok(requested_command);
    };
    with_connection(|connection| {
        validate_card_environment_project(connection, card_id)?;
        let (project_id, worktree_path): (String, String) = connection.query_row(
            "SELECT c.project_id, e.worktree_path FROM kanban_cards c JOIN card_environments e ON e.card_id=c.id WHERE c.id=?1",
            [card_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(db_error)?;
        if Path::new(cwd).canonicalize().ok() != Path::new(&worktree_path).canonicalize().ok() {
            return Err("Card terminal startup was blocked because its CWD does not match the card environment".to_string());
        }
        let live_command = match role {
            "server" => connection
                .query_row(
                    "SELECT server_command FROM projects WHERE id=?1",
                    [&project_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .map_err(db_error)?,
            "console" => connection
                .query_row(
                    "SELECT console_command FROM projects WHERE id=?1",
                    [&project_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .map_err(db_error)?,
            _ => requested_command,
        };
        Ok(live_command
            .and_then(|value| (!value.trim().is_empty()).then(|| value.trim().to_string())))
    })
}

pub(crate) fn card_pi_owner(pane_id: &str) -> Option<String> {
    let scoped = pane_id.strip_prefix("kanban-card:")?;
    let (card_id, thread) = scoped.rsplit_once(':')?;
    (!card_id.is_empty() && matches!(thread, "planning" | "work")).then(|| card_id.to_string())
}

pub(crate) fn card_terminal_owner(terminal_id: &str) -> Option<String> {
    let scoped = terminal_id.strip_prefix("kanban-card:")?;
    let (card_id, role) = scoped.rsplit_once(":terminal:")?;
    (!card_id.is_empty() && !role.is_empty()).then(|| card_id.to_string())
}

pub(crate) fn card_pi_session(pane_id: &str) -> Result<Option<CardPiSession>, String> {
    let Some(card_id) = card_pi_owner(pane_id) else {
        return Ok(None);
    };
    let thread = pane_id
        .rsplit_once(':')
        .map(|(_, thread)| thread)
        .unwrap_or_default();
    let mut session_root = card_directory(&card_id)?;
    session_root.push("pi-sessions");
    let directory = session_root.join(safe_card_key(thread));
    if thread == "planning" && !directory.exists() {
        let legacy = session_root.join("main");
        if legacy.exists() {
            std::fs::rename(&legacy, &directory)
                .map_err(|error| format!("Could not migrate the card planning session: {error}"))?;
        }
    }
    Ok(Some(CardPiSession {
        card_id,
        thread: thread.to_string(),
        directory,
    }))
}

pub(in crate::kanban) fn ensure_card_directory(id: &str) -> Result<std::path::PathBuf, String> {
    let directory = card_directory(id)?;
    fs::create_dir_all(directory.join("pi-sessions")).map_err(|error| error.to_string())?;
    Ok(directory)
}

pub(in crate::kanban) fn safe_card_key(id: &str) -> String {
    id.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

pub(in crate::kanban) fn validate_project_deletion(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<String>, String> {
    let active: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM kanban_cards WHERE project_id=?1 AND status != 'done'",
            [project_id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    let environments: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM card_environments e JOIN kanban_cards c ON c.id=e.card_id WHERE e.project_id=?1 OR c.project_id=?1",
            [project_id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if active > 0 || environments > 0 {
        return Err(format!("Project deletion is blocked: finish its {active} active card(s) and clean up its {environments} card environment(s) first."));
    }
    connection
        .prepare("SELECT id FROM kanban_cards WHERE project_id=?1")
        .map_err(db_error)?
        .query_map([project_id], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}

pub(in crate::kanban) fn kanban_validate_project_deletion_operation(
    project_id: String,
) -> Result<(), String> {
    with_connection(|connection| validate_project_deletion(connection, &project_id).map(|_| ()))
}

pub(in crate::kanban) fn kanban_delete_project_records_operation(
    project_id: String,
) -> Result<(), String> {
    with_connection(|connection| {
        let card_ids = validate_project_deletion(connection, &project_id)?;
        let transaction = connection.transaction().map_err(db_error)?;
        transaction
            .execute(
                "DELETE FROM kanban_cards WHERE project_id=?1",
                [&project_id],
            )
            .map_err(db_error)?;
        transaction
            .execute(
                "DELETE FROM kanban_project_sequences WHERE project_id=?1",
                [&project_id],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        for card_id in card_ids {
            let directory = card_directory(&card_id)?;
            if directory.exists() {
                fs::remove_dir_all(directory).map_err(|error| format!("Completed card history was deleted, but its files could not be removed: {error}"))?;
            }
        }
        Ok(())
    })
}

pub(in crate::kanban) fn validate_card_deletion(
    connection: &Connection,
    id: &str,
) -> Result<bool, String> {
    let Some(card) = get_card(connection, id)? else {
        return Ok(false);
    };
    if card.child_count > 0 {
        return Err("A parent with children cannot be deleted".to_string());
    }
    require_structural_capability(connection, id, WorkflowAction::Delete)?;
    Ok(true)
}

pub(in crate::kanban) fn kanban_delete_card_operation(id: String) -> Result<BoardChange, String> {
    with_connection(|connection| {
        if !validate_card_deletion(connection, &id)? {
            return Ok(());
        }
        let directory = card_directory(&id)?;
        if directory.exists() {
            fs::remove_dir_all(&directory)
                .map_err(|error| format!("Could not remove card directory: {error}"))?;
        }
        let transaction = connection.transaction().map_err(db_error)?;
        transaction
            .execute("DELETE FROM kanban_cards WHERE id = ?1", [&id])
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)
    })?;
    with_connection(|connection| {
        Ok(BoardChange {
            upserts: Vec::new(),
            removed_ids: vec![id],
            board_revision: board_revision(connection)?,
        })
    })
}

pub(in crate::kanban) fn workflow_context_for_card(
    connection: &Connection,
    card: &KanbanCard,
) -> Result<WorkflowContext, String> {
    crate::store::migrate_store_schema(connection)?;
    let project = card.project_id.as_deref().and_then(|project_id| connection.query_row(
        "SELECT COALESCE(kanban_source, 'local'), delivery_workflow, supports_feature_environments FROM projects WHERE id=?1",
        [project_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)? != 0)),
    ).optional().ok().flatten());
    let project_present = project.is_some();
    let (source, delivery, supports_feature_environments) =
        project.unwrap_or_else(|| ("local".to_string(), "local_merge".to_string(), false));
    let delivery_workflow = delivery.parse::<DeliveryWorkflow>()?;
    let provider_compatible =
        project_present && ((card.provider == "superthread") == (source == "superthread"));
    Ok(WorkflowContext {
        status: card.status,
        hierarchy_finalized: card.hierarchy_finalized,
        provider_compatible,
        project_present,
        delivery_workflow,
        supports_feature_environments,
        environment: card
            .environment
            .as_ref()
            .map(|environment| environment.lifecycle_state),
        completion_outcome: card.completion_outcome,
        pull_request: card
            .pull_request
            .as_ref()
            .map(|pull_request| pull_request.state),
        pull_request_blockers: card
            .pull_request
            .as_ref()
            .map(|pull_request| pull_request.blockers.clone())
            .unwrap_or_default(),
        resumable_operation: card.delivery_operation_stage.is_some()
            && card.scripted_delivery.is_none(),
        scripted_delivery_stage: card
            .scripted_delivery
            .as_ref()
            .map(|operation| operation.stage.clone()),
        creation_operation: card.creation_operation.is_some(),
        creation_cleanup_available: card
            .creation_operation
            .as_ref()
            .is_some_and(|operation| operation.cleanup_available),
        cleanup_operation_active: card
            .cleanup_operation
            .as_ref()
            .is_some_and(|operation| operation.status != "completed"),
        runtime_cleanup_retryable: matches!(
            card.runtime_cleanup_status.as_deref(),
            Some("pending" | "failed")
        ),
        work_agent_launch_retryable: work_agent_launch_retryable(connection, &card.id)?,
        local_provider: card.provider == "local",
        has_parent: card.parent.is_some(),
        has_children: card.child_count > 0,
    })
}

pub(in crate::kanban) fn require_structural_capability(
    connection: &Connection,
    id: &str,
    action: WorkflowAction,
) -> Result<KanbanCard, String> {
    let card = get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string())?;
    let capability = workflow::capabilities(&workflow_context_for_card(connection, &card)?)
        .into_iter()
        .find(|capability| capability.action == action)
        .ok_or_else(|| format!("{} is not available while card is {}", action, card.status))?;
    if !capability.available {
        return Err(capability
            .disabled_reason
            .unwrap_or_else(|| "Workflow action is unavailable".to_string()));
    }
    Ok(card)
}

pub(in crate::kanban) fn apply_workflow_transition(
    connection: &Connection,
    id: &str,
    actor: WorkflowActor,
    action: WorkflowAction,
    expected_revision: Option<i64>,
    event_type: &str,
    summary: Option<&str>,
) -> Result<bool, String> {
    let card = get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string())?;
    if expected_revision.is_some_and(|revision| revision != card.workflow_revision) {
        return Err("Card changed; reload before trying again".to_string());
    }
    let context = workflow_context_for_card(connection, &card)?;
    let transition = workflow::transition(&context, actor, action)?;
    if transition.from == transition.to && transition.outcome == card.completion_outcome {
        return Ok(false);
    }
    let now = unix_timestamp();
    let changed = connection.execute(
        "UPDATE kanban_cards SET status=?1, completion_outcome=?2, workflow_revision=workflow_revision+1, updated_at=?3,
         sort_order=(SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards destination WHERE destination.status=?1)
         WHERE id=?4 AND workflow_revision=?5",
        params![transition.to, transition.outcome, now, id, card.workflow_revision],
    ).map_err(db_error)?;
    if changed != 1 {
        return Err("Card changed; reload before trying again".to_string());
    }
    connection.execute(
        "INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,from_status,to_status,summary) VALUES (?1,?2,?3,?4,'success',?5,?6,?7)",
        params![id, now, actor, event_type, transition.from, transition.to, summary],
    ).map_err(db_error)?;
    let provider_kind = match action {
        WorkflowAction::StartWork => Some("start_work"),
        WorkflowAction::MergeLocal | WorkflowAction::MergePr | WorkflowAction::Close => {
            Some("done")
        }
        _ => None,
    };
    if let Some(kind) = provider_kind {
        provider_sync::enqueue_transition(connection, id, kind, card.workflow_revision + 1)?;
    }
    Ok(true)
}

pub(in crate::kanban) fn kanban_apply_workflow_action_operation(
    id: String,
    action: WorkflowAction,
    expected_revision: i64,
) -> Result<CardSnapshot, String> {
    if !matches!(
        action,
        WorkflowAction::ReturnToRefinement
            | WorkflowAction::RequestChanges
            | WorkflowAction::StopRefinement
    ) {
        return Err("This workflow action requires its operation-specific command".to_string());
    }
    with_connection(|connection| {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        apply_workflow_transition(
            &transaction,
            &id,
            WorkflowActor::User,
            action,
            Some(expected_revision),
            action.as_str(),
            None,
        )?;
        transaction.commit().map_err(db_error)
    })?;
    fresh_card_snapshot(&id)
}

pub(crate) fn register_pi_lifecycle_generation(
    pane_id: &str,
    generation: &str,
) -> Result<(), String> {
    let Some(session) = card_pi_session(pane_id)? else {
        return Ok(());
    };
    if !matches!(session.thread.as_str(), "planning" | "work") {
        return Ok(());
    }
    with_connection(|connection| {
        connection.execute(
        "INSERT INTO card_pi_lifecycle (card_id,thread,generation,latest_event_order,latest_event_id) VALUES (?1,?2,?3,-1,'')
         ON CONFLICT(card_id,thread) DO UPDATE SET generation=excluded.generation,latest_event_order=-1,latest_event_id=''",
        params![session.card_id, session.thread, generation],
    ).map(|_| ()).map_err(db_error)
    })
}

pub(in crate::kanban) fn kanban_apply_pi_lifecycle_intent_operation(
    id: String,
    thread: PiThread,
    intent: PiLifecycleIntent,
    generation: String,
    event_id: String,
    event_order: Option<i64>,
    failure_detail: Option<String>,
) -> Result<CardSnapshot, String> {
    with_connection(|connection| {
        apply_pi_lifecycle_intent_with_detail(
            connection,
            &id,
            thread,
            intent,
            &generation,
            &event_id,
            event_order,
            failure_detail.as_deref(),
        )
        .map(|_| ())
    })?;
    fresh_card_snapshot(&id)
}

#[cfg_attr(not(test), allow(dead_code))]
pub(in crate::kanban) fn apply_pi_lifecycle_intent(
    connection: &mut Connection,
    id: &str,
    thread: PiThread,
    intent: PiLifecycleIntent,
    generation: &str,
    event_id: &str,
    event_order: Option<i64>,
) -> Result<KanbanCard, String> {
    apply_pi_lifecycle_intent_with_detail(
        connection,
        id,
        thread,
        intent,
        generation,
        event_id,
        event_order,
        None,
    )
}

pub(in crate::kanban) fn apply_pi_lifecycle_intent_with_detail(
    connection: &mut Connection,
    id: &str,
    thread: PiThread,
    intent: PiLifecycleIntent,
    generation: &str,
    event_id: &str,
    event_order: Option<i64>,
    failure_detail: Option<&str>,
) -> Result<KanbanCard, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let state: Option<(String, i64, String)> = transaction.query_row(
            "SELECT generation,latest_event_order,latest_event_id FROM card_pi_lifecycle WHERE card_id=?1 AND thread=?2",
            params![id, thread], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(db_error)?;
    let Some((accepted_generation, latest_order, latest_id)) = state else {
        return Err("Pi lifecycle generation has not been registered".to_string());
    };
    if accepted_generation != generation {
        transaction.commit().map_err(db_error)?;
        return get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string());
    }
    let duplicate_unordered = if event_order.is_none() {
        transaction.execute(
                "INSERT OR IGNORE INTO card_pi_lifecycle_events(card_id,thread,generation,event_id) VALUES (?1,?2,?3,?4)",
                params![id, thread, generation, event_id],
            ).map_err(db_error)? == 0
    } else {
        false
    };
    let stale_order = event_order.is_some_and(|order| order <= latest_order);
    let _ = latest_id;
    if stale_order || duplicate_unordered {
        transaction.commit().map_err(db_error)?;
        return get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string());
    }
    let card =
        get_card(&transaction, &id)?.ok_or_else(|| "Kanban card was not found".to_string())?;
    let transition = workflow::lifecycle_transition(
        &workflow_context_for_card(&transaction, &card)?,
        thread,
        intent,
    );
    let records_initial_work_launch = thread == PiThread::Work
        && intent == PiLifecycleIntent::AgentStarted
        && card.status == CardStatus::AgentWorking;
    if transition.is_some() || records_initial_work_launch {
        let now = unix_timestamp();
        if let Some(transition) = transition {
            transaction.execute(
                    "UPDATE kanban_cards SET status=?1,workflow_revision=workflow_revision+1,updated_at=?2,
                     sort_order=(SELECT COALESCE(MAX(sort_order),-1)+1 FROM kanban_cards destination WHERE destination.status=?1)
                     WHERE id=?3 AND workflow_revision=?4",
                    params![transition.to, now, id, card.workflow_revision],
                ).map_err(db_error)?;
        }
        let failed = matches!(
            intent,
            PiLifecycleIntent::ProtocolFailed | PiLifecycleIntent::ProcessExited
        );
        let (from_status, to_status) = transition
            .map(|value| (value.from, value.to))
            .unwrap_or((card.status, card.status));
        transaction.execute(
                "INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,from_status,to_status,summary,error_code,error_detail) VALUES (?1,?2,'agent',?3,?4,?5,?6,?7,?8,?9)",
                params![id, now, intent, if failed { "failure" } else { "success" }, from_status, to_status,
                    format!("Pi {} {}", thread, intent), failed.then(|| intent.as_str()), failure_detail],
            ).map_err(db_error)?;
    }
    if let Some(event_order) = event_order {
        transaction.execute(
                "UPDATE card_pi_lifecycle SET latest_event_order=?1,latest_event_id=?2 WHERE card_id=?3 AND thread=?4 AND generation=?5",
                params![event_order, event_id, id, thread, generation],
            ).map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)?;
    get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string())
}

pub(in crate::kanban) fn kanban_record_agent_launch_failure_operation(
    id: String,
    expected_workflow_revision: i64,
    expected_project_id: String,
    error_detail: String,
) -> Result<CardSnapshot, String> {
    with_connection(|connection| {
        record_agent_launch_failure(
            connection,
            &id,
            expected_workflow_revision,
            &expected_project_id,
            &error_detail,
        )
    })?;
    fresh_card_snapshot(&id)
}

pub(in crate::kanban) fn record_agent_launch_failure(
    connection: &mut Connection,
    id: &str,
    expected_workflow_revision: i64,
    expected_project_id: &str,
    error_detail: &str,
) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let card =
        get_card(&transaction, &id)?.ok_or_else(|| "Kanban card was not found".to_string())?;
    if card.workflow_revision != expected_workflow_revision
        || card.project_id.as_deref() != Some(&expected_project_id)
    {
        return Err("Card changed; launch failure was not recorded".to_string());
    }
    if !matches!(
        card.status,
        CardStatus::AgentWorking | CardStatus::NeedsHuman
    ) {
        return Err("Card is no longer eligible for work-agent launch".to_string());
    }
    validate_card_environment_project(&transaction, &id)?;
    let now = unix_timestamp();
    let to = CardStatus::NeedsHuman;
    transaction.execute(
            "UPDATE kanban_cards SET status=?1,workflow_revision=workflow_revision+1,updated_at=?2,
             sort_order=(SELECT COALESCE(MAX(sort_order),-1)+1 FROM kanban_cards destination WHERE destination.status=?1)
             WHERE id=?3 AND workflow_revision=?4",
            params![to, now, id, card.workflow_revision],
        ).map_err(db_error)?;
    transaction.execute(
            "INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,from_status,to_status,summary,error_code,error_detail)
             VALUES (?1,?2,'system','agent_launch_failed','failure',?3,?4,'Work agent launch failed','agent_launch_failed',?5)",
            params![id, now, card.status, to, error_detail],
        ).map_err(db_error)?;
    transaction.commit().map_err(db_error)
}

pub(in crate::kanban) fn kanban_status_metadata_operation() -> Vec<workflow::StatusMetadata> {
    workflow::STATUS_METADATA.to_vec()
}

#[derive(Default)]
pub(in crate::kanban) struct CardRuntimeTargets {
    pub(in crate::kanban) pi: HashSet<String>,
    pub(in crate::kanban) pty: HashSet<String>,
}

pub(in crate::kanban) fn persisted_runtime_targets(
    connection: &Connection,
    card_id: &str,
) -> Result<CardRuntimeTargets, String> {
    let mut targets = CardRuntimeTargets::default();
    targets.pi.extend([
        format!("kanban-card:{card_id}:planning"),
        format!("kanban-card:{card_id}:work"),
    ]);
    targets.pty.extend(
        ["shell", "server", "console"].map(|role| format!("kanban-card:{card_id}:terminal:{role}")),
    );
    let mut statement = connection.prepare(
        "SELECT p.id, p.kind FROM card_panes p JOIN card_environments e ON e.id=p.environment_id WHERE e.card_id=?1"
    ).map_err(db_error)?;
    for row in statement
        .query_map([card_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?
    {
        let (id, kind) = row.map_err(db_error)?;
        if kind == "pi" && card_pi_owner(&id).as_deref() == Some(card_id) {
            targets.pi.insert(id);
        } else if kind == "terminal" && card_terminal_owner(&id).as_deref() == Some(card_id) {
            targets.pty.insert(id);
        }
    }
    Ok(targets)
}

pub(in crate::kanban) fn commit_card_close(
    connection: &mut Connection,
    id: &str,
    expected_revision: i64,
) -> Result<CardRuntimeTargets, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    require_structural_capability(&transaction, id, WorkflowAction::Close)?;
    let targets = persisted_runtime_targets(&transaction, id)?;
    apply_workflow_transition(
        &transaction,
        id,
        WorkflowActor::User,
        WorkflowAction::Close,
        Some(expected_revision),
        "close",
        Some("Closed without delivery; runtime cleanup pending"),
    )?;
    transaction
        .execute(
            "UPDATE kanban_cards SET delivery_operation_stage=NULL, delivery_error=NULL,
         runtime_cleanup_status='pending', runtime_cleanup_error=NULL WHERE id=?1",
            [id],
        )
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    Ok(targets)
}

pub(in crate::kanban) fn execute_runtime_cleanup<StopPi, DeletePi, StopPty>(
    targets: CardRuntimeTargets,
    mut stop_pi: StopPi,
    mut delete_pi: DeletePi,
    mut stop_pty: StopPty,
) -> Vec<RuntimeResourceOutcome>
where
    StopPi: FnMut(&str) -> Result<(), String>,
    DeletePi: FnMut(&str) -> Result<(), String>,
    StopPty: FnMut(&str) -> Result<(), String>,
{
    let mut pi_ids = targets.pi.into_iter().collect::<Vec<_>>();
    let mut pty_ids = targets.pty.into_iter().collect::<Vec<_>>();
    pi_ids.sort();
    pty_ids.sort();
    let mut outcomes = Vec::new();
    for id in pi_ids {
        let process_result = stop_pi(&id);
        outcomes.push(RuntimeResourceOutcome {
            resource_type: "pi_process".into(),
            id: id.clone(),
            success: process_result.is_ok(),
            error: process_result.clone().err(),
        });
        let session_result = match process_result {
            Ok(()) => delete_pi(&id),
            Err(_) => Err(
                "Persisted conversation retained because the Pi process did not stop".to_string(),
            ),
        };
        outcomes.push(RuntimeResourceOutcome {
            resource_type: "pi_session".into(),
            id,
            success: session_result.is_ok(),
            error: session_result.err(),
        });
    }
    for id in pty_ids {
        let result = stop_pty(&id);
        outcomes.push(RuntimeResourceOutcome {
            resource_type: "pty".into(),
            id,
            success: result.is_ok(),
            error: result.err(),
        });
    }
    outcomes
}

pub(in crate::kanban) fn run_runtime_cleanup(
    card_id: &str,
    mut targets: CardRuntimeTargets,
    pi_registry: &Mutex<PiRpcRegistry>,
    pty_registry: &Mutex<PtyRegistry>,
) -> Vec<RuntimeResourceOutcome> {
    let mut discovery_failures = Vec::new();
    match crate::pi_rpc::card_pi_runtime_ids(pi_registry, card_id) {
        Ok(ids) => targets.pi.extend(ids),
        Err(error) => discovery_failures.push(RuntimeResourceOutcome {
            resource_type: "pi_process".into(),
            id: "Pi registry discovery".into(),
            success: false,
            error: Some(error),
        }),
    }
    match crate::pty::card_pty_runtime_ids(pty_registry, card_id) {
        Ok(ids) => targets.pty.extend(ids),
        Err(error) => discovery_failures.push(RuntimeResourceOutcome {
            resource_type: "pty".into(),
            id: "PTY registry discovery".into(),
            success: false,
            error: Some(error),
        }),
    }
    let mut outcomes = execute_runtime_cleanup(
        targets,
        |id| crate::pi_rpc::stop_pi_session_impl(pi_registry, id),
        crate::pi_rpc::delete_pi_session_directory,
        |id| crate::pty::kill_ptys(pty_registry, &[id.to_string()]),
    );
    outcomes.extend(discovery_failures);
    outcomes
}

pub(in crate::kanban) fn persist_runtime_cleanup_result(
    connection: &Connection,
    id: &str,
    outcomes: &[RuntimeResourceOutcome],
) -> Result<(), String> {
    let failures = outcomes
        .iter()
        .filter_map(|outcome| {
            outcome
                .error
                .as_ref()
                .map(|error| format!("{} {}: {error}", outcome.resource_type, outcome.id))
        })
        .collect::<Vec<_>>();
    let (status, error, event_outcome, summary) = if failures.is_empty() {
        (
            "complete",
            None,
            "success",
            "Card runtime cleanup completed".to_string(),
        )
    } else {
        (
            "failed",
            Some(failures.join("\n")),
            "failure",
            format!(
                "Card runtime cleanup failed for {} resource(s)",
                failures.len()
            ),
        )
    };
    connection.execute("UPDATE kanban_cards SET runtime_cleanup_status=?1, runtime_cleanup_error=?2, updated_at=?3 WHERE id=?4 AND status='done'", params![status, error, unix_timestamp(), id]).map_err(db_error)?;
    connection.execute(
        "INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, summary, error_code, error_detail) VALUES (?1, ?2, 'system', 'runtime_cleanup', ?3, ?4, ?5, ?6)",
        params![id, unix_timestamp(), event_outcome, summary, if failures.is_empty() { None } else { Some("runtime_cleanup_failed") }, error],
    ).map_err(db_error)?;
    Ok(())
}

pub(in crate::kanban) fn finish_runtime_cleanup(
    id: &str,
    targets: CardRuntimeTargets,
    pi_registry: &Mutex<PiRpcRegistry>,
    pty_registry: &Mutex<PtyRegistry>,
) -> Result<CardRuntimeCleanupResult, String> {
    let outcomes = run_runtime_cleanup(id, targets, pi_registry, pty_registry);
    with_connection(|connection| persist_runtime_cleanup_result(connection, id, &outcomes))?;
    let card = fresh_card_snapshot(id)?.card;
    Ok(CardRuntimeCleanupResult { card, outcomes })
}

pub(in crate::kanban) fn kanban_close_card_operation(
    id: String,
    expected_revision: i64,
    pi_registry: State<'_, Mutex<PiRpcRegistry>>,
    pty_registry: State<'_, Mutex<PtyRegistry>>,
) -> Result<CardRuntimeCleanupResult, String> {
    let targets =
        with_connection(|connection| commit_card_close(connection, &id, expected_revision))?;
    finish_runtime_cleanup(&id, targets, pi_registry.inner(), pty_registry.inner())
}

pub(in crate::kanban) fn kanban_retry_runtime_cleanup_operation(
    id: String,
    pi_registry: State<'_, Mutex<PiRpcRegistry>>,
    pty_registry: State<'_, Mutex<PtyRegistry>>,
) -> Result<CardRuntimeCleanupResult, String> {
    let targets = with_connection(|connection| {
        require_structural_capability(connection, &id, WorkflowAction::RetryRuntimeCleanup)?;
        let status: Option<String> = connection
            .query_row(
                "SELECT status FROM kanban_cards WHERE id=?1",
                [&id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        match status.as_deref() {
            None => Err("Kanban card was not found".to_string()),
            Some("done") => persisted_runtime_targets(connection, &id),
            _ => Err("Runtime cleanup can only be retried for a Done card".to_string()),
        }
    })?;
    finish_runtime_cleanup(&id, targets, pi_registry.inner(), pty_registry.inner())
}

pub(in crate::kanban) fn kanban_reorder_cards_operation(
    status: CardStatus,
    expected_card_ids: Vec<String>,
    card_ids: Vec<String>,
) -> Result<BoardChange, String> {
    with_connection(|connection| {
        reorder_cards(connection, status.as_str(), &expected_card_ids, &card_ids).map(|_| ())
    })?;
    with_connection(|connection| {
        let revision = board_revision(connection)?;
        let mut upserts = Vec::new();
        for id in &card_ids {
            if let Some(card) = get_card(connection, id)? {
                upserts.push(card);
            }
        }
        Ok(BoardChange {
            upserts,
            removed_ids: Vec::new(),
            board_revision: revision,
        })
    })
}

pub(in crate::kanban) fn reorder_cards(
    connection: &mut Connection,
    status: &str,
    expected_card_ids: &[String],
    card_ids: &[String],
) -> Result<Vec<KanbanCard>, String> {
    reject_duplicate_ids("expected_card_ids", expected_card_ids)?;
    reject_duplicate_ids("card_ids", card_ids)?;
    let expected_set = expected_card_ids.iter().collect::<HashSet<_>>();
    let desired_set = card_ids.iter().collect::<HashSet<_>>();
    if expected_set != desired_set {
        return Err(
            "Reorder expected_card_ids and card_ids must contain exactly the same IDs".to_string(),
        );
    }

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let rows = {
        let mut statement = transaction.prepare(
            "SELECT id, status, hierarchy_finalized, in_scope FROM kanban_cards ORDER BY sort_order ASC, created_at ASC, id ASC",
        ).map_err(db_error)?;
        let mapped = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)? != 0,
                    row.get::<_, i64>(3)? != 0,
                ))
            })
            .map_err(db_error)?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    let mut effective_rows = Vec::with_capacity(rows.len());
    for (id, stored_status, finalized, in_scope) in rows {
        let effective_status = effective_card_status(&transaction, &id, &stored_status, finalized)?;
        effective_rows.push((id, effective_status, in_scope));
    }

    for id in card_ids {
        let Some((_, effective_status, in_scope)) = effective_rows
            .iter()
            .find(|(candidate, _, _)| candidate == id)
        else {
            return Err(format!("Unknown reordered card ID: {id}"));
        };
        if !in_scope {
            return Err(format!("Reordered card is not in scope: {id}"));
        }
        if effective_status != status {
            return Err(format!(
                "Reordered card {id} belongs to effective lane {effective_status}, not {status}"
            ));
        }
    }

    let current_order = effective_rows
        .into_iter()
        .filter(|(_, effective_status, in_scope)| *in_scope && effective_status == status)
        .map(|(id, _, _)| id)
        .collect::<Vec<_>>();
    let current_set = current_order.iter().collect::<HashSet<_>>();
    if expected_set != current_set {
        let missing = current_order
            .iter()
            .filter(|id| !expected_set.contains(id))
            .cloned()
            .collect::<Vec<_>>();
        return Err(format!(
            "Reorder payload is incomplete for lane {status}; missing IDs: {}",
            missing.join(", ")
        ));
    }
    // Validate the full payload first, then allow an exact retry independently of its stale expectation.
    if current_order == card_ids {
        transaction.commit().map_err(db_error)?;
        return list_cards(connection);
    }
    if current_order != expected_card_ids {
        return Err(format!(
            "{REORDER_CONFLICT_CODE}: Lane order changed; reload the board and retry"
        ));
    }

    let now = unix_timestamp();
    for (index, id) in card_ids.iter().enumerate() {
        transaction
            .execute(
                "UPDATE kanban_cards SET sort_order = ?1, updated_at = ?2 WHERE id = ?3",
                params![index as i64, now, id],
            )
            .map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)?;
    list_cards(connection)
}

pub(in crate::kanban) fn kanban_set_project_operation(
    id: String,
    project_id: String,
) -> Result<CardSnapshot, String> {
    if project_id.trim().is_empty() {
        return Err("Project is required".to_string());
    }
    let destination = crate::store::pi_project_scope(&project_id)?;
    if !is_local_kanban_source(&destination.kanban_source) {
        return Err("Cards can only be reassigned to a local Kanban project".to_string());
    }
    with_connection(|connection| {
        ensure_card_directory(&id)?;
        set_card_project(connection, &id, &destination.id, &destination.name)
    })?;
    fresh_card_snapshot(&id)
}

pub(in crate::kanban) fn set_card_project(
    connection: &mut Connection,
    id: &str,
    destination_id: &str,
    destination_name: &str,
) -> Result<KanbanCard, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let (provider, status, current_project_id, current_number, has_environment, parent_id, has_children, hierarchy_finalized):
        (String, String, Option<String>, String, bool, Option<String>, bool, bool) = transaction.query_row(
        "SELECT external_provider, status, project_id, external_id, EXISTS(SELECT 1 FROM card_environments WHERE card_id=kanban_cards.id), parent_id, EXISTS(SELECT 1 FROM kanban_cards child WHERE child.parent_id=kanban_cards.id), hierarchy_finalized FROM kanban_cards WHERE id=?1",
        [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get::<_, i64>(4)? != 0, row.get(5)?, row.get::<_, i64>(6)? != 0, row.get::<_, i64>(7)? != 0)),
    ).optional().map_err(db_error)?.ok_or_else(|| "Kanban card was not found".to_string())?;
    if !provider.starts_with("local:") {
        return Err("Superthread cards cannot be reassigned".to_string());
    }
    if !matches!(
        status.as_str(),
        "needs_refinement" | "refining" | "needs_refinement_input"
    ) {
        return Err("A card can only be reassigned during refinement".to_string());
    }
    if has_environment {
        return Err(
            "A card cannot be reassigned after its environment has been created".to_string(),
        );
    }
    if hierarchy_finalized || parent_id.is_some() || has_children {
        return Err(
            "A card with hierarchy relationships cannot be moved to another project".to_string(),
        );
    }
    let destination_number = if current_project_id.as_deref() == Some(destination_id) {
        current_number
    } else {
        next_local_card_number(&transaction, destination_id)?.to_string()
    };
    let changed = transaction.execute(
        "UPDATE kanban_cards SET project_id=?1, external_provider='local:' || ?1, external_id=?2, board_id=?1, board_title=?3, updated_at=?4 WHERE id=?5 AND status IN ('needs_refinement', 'refining', 'needs_refinement_input')",
        params![destination_id, destination_number, destination_name, unix_timestamp(), id],
    ).map_err(db_error)?;
    if changed == 0 {
        return Err("Card changed; reload before reassigning its project".to_string());
    }
    transaction.commit().map_err(db_error)?;
    get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string())
}
