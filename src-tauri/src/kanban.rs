use crate::fs_paths::app_data_file;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

static REPOSITORY_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

const STATUSES: [&str; 6] = [
    "needs_refinement",
    "ready",
    "agent_working",
    "needs_human",
    "approved",
    "merged",
];

#[derive(Debug, Clone, Deserialize)]
pub struct KanbanCardSnapshot {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub board_id: String,
    #[serde(default)]
    pub board_title: String,
    #[serde(default)]
    pub list_id: String,
    #[serde(default)]
    pub list_title: String,
    #[serde(default)]
    pub card_url: String,
    #[serde(default)]
    pub assignee_names: Vec<String>,
    #[serde(default = "default_true")]
    pub in_scope: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CardPane {
    id: String,
    role: String,
    kind: String,
    command: Option<String>,
    sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CardServiceDefinition {
    id: String,
    name: String,
    command: String,
    sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CardEnvironment {
    id: String,
    card_id: String,
    project_id: String,
    worktree_path: String,
    branch: String,
    repository_id: Option<String>,
    target_checkout_path: Option<String>,
    target_branch: Option<String>,
    source_revision: Option<String>,
    target_revision: Option<String>,
    lifecycle_state: String,
    revision: i64,
    split_layout: serde_json::Value,
    focused_pane_id: Option<String>,
    panes: Vec<CardPane>,
    services: Vec<CardServiceDefinition>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CardEvent {
    id: i64,
    created_at: i64,
    actor: String,
    event_type: String,
    outcome: String,
    from_status: Option<String>,
    to_status: Option<String>,
    summary: Option<String>,
    error_code: Option<String>,
    error_detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KanbanCard {
    id: String,
    provider: String,
    external_id: String,
    title: String,
    content: String,
    board_id: String,
    board_title: String,
    list_id: String,
    list_title: String,
    card_url: String,
    assignee_names: Vec<String>,
    status: String,
    workflow_revision: i64,
    project_id: Option<String>,
    environment: Option<CardEnvironment>,
    created_at: i64,
    updated_at: i64,
    sort_order: i64,
    in_scope: bool,
    events: Vec<CardEvent>,
}

impl KanbanCard {
    pub(crate) fn number(&self) -> &str {
        &self.external_id
    }

    pub(crate) fn board_title(&self) -> &str {
        &self.board_title
    }
}

#[tauri::command]
pub fn kanban_cards() -> Result<Vec<KanbanCard>, String> {
    with_connection(list_cards)
}

#[tauri::command]
pub fn kanban_create_local_card(
    project_id: String,
    title: String,
    content: String,
) -> Result<KanbanCard, String> {
    create_local_card_for_project(&project_id, &title, &content)
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

fn is_local_kanban_source(source: &str) -> bool {
    source == "local"
}

fn create_local_card(
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
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards WHERE status = 'needs_refinement' AND project_id = ?1",
        [project_id], |row| row.get(0),
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

#[tauri::command]
pub fn kanban_update_local_card(
    id: String,
    title: Option<String>,
    content: Option<String>,
) -> Result<KanbanCard, String> {
    with_connection(|connection| {
        update_local_card(connection, &id, title.as_deref(), content.as_deref())
    })
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
         WHERE id = ?4 AND external_provider LIKE 'local:%'",
        params![title, content.map(str::trim), unix_timestamp(), id],
    ).map_err(db_error)?;
    if changed == 0 {
        return Err("Local Kanban card was not found".to_string());
    }
    get_card(connection, id)?.ok_or_else(|| "Local Kanban card was not found".to_string())
}

#[tauri::command]
pub fn kanban_finish_local_refinement(
    id: String,
    title: Option<String>,
    content: String,
) -> Result<KanbanCard, String> {
    with_connection(|connection| {
        finish_local_refinement(connection, &id, title.as_deref(), &content)
    })
}

pub(crate) fn finish_local_refinement(
    connection: &mut Connection,
    id: &str,
    title: Option<&str>,
    content: &str,
) -> Result<KanbanCard, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("A final card description is required before finishing refinement".to_string());
    }
    let transaction = connection.transaction().map_err(db_error)?;
    update_local_card(&transaction, id, title, Some(content))?;
    let changed = transaction.execute(
        "UPDATE kanban_cards SET status = 'ready', workflow_revision = workflow_revision + 1, updated_at = ?1,
            sort_order = (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards AS destination WHERE destination.status = 'ready')
         WHERE id = ?2 AND status IN ('needs_refinement', 'ready')",
        params![unix_timestamp(), id],
    ).map_err(db_error)?;
    if changed == 0 {
        return Err("Only a card being refined can finish refinement".to_string());
    }
    transaction.execute("INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, from_status, to_status) VALUES (?1, ?2, 'agent', 'status_transition', 'success', 'needs_refinement', 'ready')", params![id, unix_timestamp()]).map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    get_card(connection, id)?.ok_or_else(|| "Local Kanban card was not found".to_string())
}

#[tauri::command]
pub fn kanban_open_card(id: String) -> Result<String, String> {
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

pub(crate) fn card_pi_session(pane_id: &str) -> Result<Option<CardPiSession>, String> {
    let Some(scoped) = pane_id.strip_prefix("kanban-card:") else {
        return Ok(None);
    };
    let Some((card_id, thread)) = scoped.rsplit_once(':') else {
        return Ok(None);
    };
    if card_id.is_empty() || thread.is_empty() {
        return Ok(None);
    }
    let mut session_root = card_directory(card_id)?;
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
        card_id: card_id.to_string(),
        thread: thread.to_string(),
        directory,
    }))
}

fn ensure_card_directory(id: &str) -> Result<std::path::PathBuf, String> {
    let directory = card_directory(id)?;
    fs::create_dir_all(directory.join("pi-sessions")).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn safe_card_key(id: &str) -> String {
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

#[tauri::command]
pub fn kanban_sync_superthread_cards(
    cards: Vec<KanbanCardSnapshot>,
) -> Result<Vec<KanbanCard>, String> {
    with_connection(|connection| sync_cards(connection, cards))
}

fn sync_cards(
    connection: &mut Connection,
    cards: Vec<KanbanCardSnapshot>,
) -> Result<Vec<KanbanCard>, String> {
    let now = unix_timestamp();
    let transaction = connection.transaction().map_err(db_error)?;
    for card in cards {
        if card.id.trim().is_empty() || card.title.trim().is_empty() {
            continue;
        }
        if !card.in_scope {
            transaction.execute(
                "UPDATE kanban_cards SET title = ?1, content = CASE WHEN ?2 = '' THEN content ELSE ?2 END,
                    board_id = ?3, board_title = ?4, list_id = ?5, list_title = ?6, card_url = ?7,
                    assignee_names = ?8, in_scope = 0, updated_at = ?9
                 WHERE external_provider = 'superthread' AND external_id = ?10",
                params![card.title.trim(), card.content, card.board_id, card.board_title, card.list_id,
                    card.list_title, card.card_url, serde_json::to_string(&card.assignee_names).map_err(|error| error.to_string())?,
                    now, card.id.trim()],
            ).map_err(db_error)?;
            continue;
        }
        let was_cleaned = transaction.query_row(
            "SELECT 1 FROM kanban_cleaned_cards WHERE external_provider = 'superthread' AND external_id = ?1",
            [card.id.trim()],
            |_| Ok(()),
        ).optional().map_err(db_error)?.is_some();
        if was_cleaned {
            continue;
        }
        let local_id = format!("superthread:{}", card.id.trim());
        transaction.execute(
            "INSERT INTO kanban_cards (
                id, external_provider, external_id, title, content, board_id, board_title,
                list_id, list_title, card_url, assignee_names, status, created_at, updated_at, sort_order, in_scope
             ) VALUES (?1, 'superthread', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'needs_refinement', ?11, ?11,
                (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards WHERE status = 'needs_refinement'), 1)
             ON CONFLICT(external_provider, external_id) DO UPDATE SET
                title = excluded.title,
                content = CASE WHEN excluded.content = '' THEN kanban_cards.content ELSE excluded.content END,
                board_id = excluded.board_id,
                board_title = excluded.board_title,
                list_id = excluded.list_id,
                list_title = excluded.list_title,
                card_url = excluded.card_url,
                assignee_names = excluded.assignee_names,
                in_scope = 1,
                updated_at = excluded.updated_at",
            params![
                local_id,
                card.id.trim(),
                card.title.trim(),
                card.content,
                card.board_id,
                card.board_title,
                card.list_id,
                card.list_title,
                card.card_url,
                serde_json::to_string(&card.assignee_names).map_err(|error| error.to_string())?,
                now,
            ],
        ).map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)?;
    list_cards(connection)
}

#[tauri::command]
pub fn kanban_delete_card(id: String) -> Result<(), String> {
    with_connection(|connection| {
        let Some(card) = get_card(connection, &id)? else {
            return Ok(());
        };
        if card.provider != "local"
            || card.status != "needs_refinement"
            || card.environment.is_some()
        {
            return Err(
                "Only local Needs refinement cards without environments can be deleted".to_string(),
            );
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
    })
}

#[tauri::command]
pub fn kanban_set_status(
    id: String,
    status: String,
    expected_revision: i64,
    actor: String,
) -> Result<KanbanCard, String> {
    if !STATUSES.contains(&status.as_str()) {
        return Err(format!("Unknown Kanban status: {status}"));
    }
    with_connection(|connection| {
        ensure_card_directory(&id)?;
        let (current, revision): (String, i64) = connection
            .query_row(
                "SELECT status, workflow_revision FROM kanban_cards WHERE id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Kanban card was not found".to_string())?;
        if revision != expected_revision {
            return Err("Card changed; reload before trying again".to_string());
        }
        let legal = matches!(
            (current.as_str(), status.as_str()),
            ("needs_refinement", "ready")
                | ("ready", "needs_refinement")
                | ("ready", "agent_working")
                | ("agent_working", "needs_human")
                | ("needs_human", "agent_working")
                | ("needs_human", "approved")
                | ("approved", "needs_human")
                | ("merged", "approved")
                | ("merged", "ready")
        );
        if current != status && !legal {
            return Err(format!(
                "Illegal Kanban transition from {current} to {status}"
            ));
        }
        let changed = connection.execute(
            "UPDATE kanban_cards SET status = ?1, workflow_revision = workflow_revision + 1, updated_at = ?2,
                sort_order = (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards AS destination WHERE destination.status = ?1)
             WHERE id = ?3 AND workflow_revision = ?4",
            params![status, unix_timestamp(), id, expected_revision],
        ).map_err(db_error)?;
        if changed == 0 {
            return Err("Card changed; reload before trying again".to_string());
        }
        connection.execute("INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, from_status, to_status) VALUES (?1, ?2, ?3, 'status_transition', 'success', ?4, ?5)",
            params![id, unix_timestamp(), if actor == "agent" { "agent" } else { "user" }, current, status]).map_err(db_error)?;
        get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
    })
}

#[tauri::command]
pub fn kanban_reorder_cards(
    status: String,
    card_ids: Vec<String>,
) -> Result<Vec<KanbanCard>, String> {
    if !STATUSES.contains(&status.as_str()) {
        return Err(format!("Unknown Kanban status: {status}"));
    }
    with_connection(|connection| {
        let transaction = connection.transaction().map_err(db_error)?;
        for (index, id) in card_ids.iter().enumerate() {
            let changed = transaction.execute(
                "UPDATE kanban_cards SET sort_order = ?1, updated_at = ?2 WHERE id = ?3 AND status = ?4",
                params![index as i64, unix_timestamp(), id, status],
            ).map_err(db_error)?;
            if changed == 0 {
                return Err("A reordered card was not found in the expected column".to_string());
            }
        }
        transaction.commit().map_err(db_error)?;
        list_cards(connection)
    })
}

#[tauri::command]
pub fn kanban_set_project(id: String, project_id: String) -> Result<KanbanCard, String> {
    if project_id.trim().is_empty() {
        return Err("Project is required".to_string());
    }
    with_connection(|connection| {
        ensure_card_directory(&id)?;
        let changed = connection
            .execute(
                "UPDATE kanban_cards SET project_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![project_id, unix_timestamp(), id],
            )
            .map_err(db_error)?;
        if changed == 0 {
            return Err("Kanban card was not found".to_string());
        }
        get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct EnvironmentStartPreflight {
    repository_id: String,
    target_checkout_path: String,
    target_branch: String,
    target_revision: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowOperationResult {
    card: KanbanCard,
    message: String,
    idempotent: bool,
}

#[tauri::command]
pub fn kanban_environment_start_preflight(
    id: String,
    target_checkout_path: String,
    expected_workflow_revision: i64,
) -> Result<EnvironmentStartPreflight, String> {
    with_connection(|connection| {
        let (status, revision): (String, i64) = connection
            .query_row(
                "SELECT status, workflow_revision FROM kanban_cards WHERE id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Kanban card was not found".to_string())?;
        if revision != expected_workflow_revision {
            return Err("Card changed; reload before starting work".to_string());
        }
        if status != "ready" {
            return Err("The card must be Ready for agent before work can start".to_string());
        }
        validate_target_checkout(&target_checkout_path, None)
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command fields stay explicit for frontend serialization.
pub fn kanban_create_environment(
    id: String,
    project_id: String,
    worktree_path: String,
    services: Vec<CardServiceDefinition>,
    repository_id: String,
    target_checkout_path: String,
    target_branch: String,
    target_revision: String,
    expected_workflow_revision: i64,
) -> Result<KanbanCard, String> {
    if project_id.trim().is_empty() || worktree_path.trim().is_empty() {
        return Err("Project and worktree path are required".to_string());
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
        let (card_status, workflow_revision): (String, i64) = transaction
            .query_row(
                "SELECT status, workflow_revision FROM kanban_cards WHERE id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Kanban card was not found".to_string())?;
        if workflow_revision != expected_workflow_revision {
            return Err("Card changed; reload before creating its environment".to_string());
        }
        if card_status != "ready" {
            return Err(
                "A card environment can only be created when the card is ready for agent work"
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
            params![environment_id, id, project_id.trim(), worktree_path.trim(), source.target_branch, repository_id,
                target_checkout_path, target_branch, source.target_revision, target_revision, now],
        ).map_err(db_error)?;
        let environment_id: String = transaction
            .query_row(
                "SELECT id FROM card_environments WHERE card_id = ?1",
                [&id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        transaction
            .execute(
                "DELETE FROM card_service_definitions WHERE environment_id = ?1",
                [&environment_id],
            )
            .map_err(db_error)?;
        for (index, service) in services.into_iter().enumerate() {
            let command = service.command.trim();
            if command.is_empty() {
                continue;
            }
            transaction.execute(
                "INSERT INTO card_service_definitions (id, environment_id, name, command, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![if service.id.is_empty() { format!("service:{}", uuid::Uuid::new_v4()) } else { service.id }, environment_id, service.name.trim(), command, index as i64],
            ).map_err(db_error)?;
        }
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
            params![project_id.trim(), now, id],
        ).map_err(db_error)?;
        transaction.execute("INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, from_status, to_status, summary) VALUES (?1, ?2, 'user', 'environment_start', 'success', 'ready', 'agent_working', ?3)",
            params![id, now, format!("Created source worktree {} on {}", worktree_path, source.target_branch)]).map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
    })
}

#[tauri::command]
pub fn kanban_save_environment_layout(
    id: String,
    split_layout: serde_json::Value,
    focused_pane_id: Option<String>,
    panes: Vec<CardPane>,
    expected_revision: i64,
) -> Result<KanbanCard, String> {
    with_connection(|connection| {
        let transaction = connection.transaction().map_err(db_error)?;
        let environment_id: String = transaction
            .query_row(
                "SELECT id FROM card_environments WHERE card_id = ?1 AND revision = ?2",
                params![id, expected_revision],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| {
                "Card environment changed; reload before saving the layout".to_string()
            })?;
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
        transaction.execute(
            "UPDATE card_environments SET revision = revision + 1, updated_at = ?1 WHERE id = ?2",
            params![unix_timestamp(), environment_id],
        ).map_err(db_error)?;
        transaction.execute(
            "INSERT INTO card_layouts (environment_id, split_layout, focused_pane_id, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(environment_id) DO UPDATE SET split_layout = excluded.split_layout, focused_pane_id = excluded.focused_pane_id, updated_at = excluded.updated_at",
            params![environment_id, split_layout.to_string(), focused_pane_id, unix_timestamp()],
        ).map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
    })
}

#[tauri::command]
pub fn kanban_set_merge_target(
    id: String,
    target_checkout_path: String,
    expected_environment_revision: i64,
) -> Result<KanbanCard, String> {
    with_connection(|connection| {
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

#[tauri::command]
pub async fn kanban_approve_and_commit(
    id: String,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
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
            )
        })
    })
    .await
    .map_err(|error| format!("Approval worker failed: {error}"))?
}

fn approve_and_commit_with_failure_record(
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

fn approve_and_commit(
    connection: &mut Connection,
    id: &str,
    expected_card: i64,
    expected_environment: i64,
) -> Result<WorkflowOperationResult, String> {
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
        _ => false,
    };
    if !expected_agent_cycle {
        return Err(if status == "needs_human" || status == "agent_working" {
            "Card changed; reload before approving".to_string()
        } else {
            "Only a Needs you card can be approved".to_string()
        });
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
        "UPDATE kanban_cards SET status='approved', workflow_revision=workflow_revision+1, updated_at=?1,
         sort_order=(SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards AS destination WHERE destination.status='approved')
         WHERE id=?2 AND workflow_revision=?3 AND status=?4",
        params![now, id, card_revision, status],
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
        message: "Work committed and verified; card is Ready to merge".to_string(),
        idempotent: false,
    })
}

fn git_status_counts(text: &str) -> (u32, u32, u32) {
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

#[tauri::command]
pub async fn kanban_merge_card(
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

fn merge_card(
    connection: &mut Connection,
    id: &str,
    expected_card: i64,
    expected_environment: i64,
) -> Result<WorkflowOperationResult, String> {
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
    let (source_path, source_branch, repository_id, target_path, target_branch, environment_revision): (String, String, Option<String>, Option<String>, Option<String>, i64) = transaction.query_row(
        "SELECT worktree_path, branch, repository_id, target_checkout_path, target_branch, revision FROM card_environments WHERE card_id=?1", [id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
    ).optional().map_err(db_error)?.ok_or_else(|| "This card has no environment to merge".to_string())?;
    if environment_revision != expected_environment {
        return Err("Card environment changed; reload before merging".to_string());
    }
    let repository_id = repository_id
        .ok_or_else(|| "Set merge target before merging this legacy environment".to_string())?;
    let target_path = target_path
        .ok_or_else(|| "Set merge target before merging this legacy environment".to_string())?;
    let target_branch = target_branch
        .ok_or_else(|| "Set merge target before merging this legacy environment".to_string())?;
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
    transaction.execute("UPDATE kanban_cards SET status='merged', workflow_revision=workflow_revision+1, updated_at=?1 WHERE id=?2 AND workflow_revision=?3", params![unix_timestamp(), id, expected_card]).map_err(db_error)?;
    transaction.execute("INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, from_status, to_status, summary) VALUES (?1, ?2, 'user', 'merge', 'success', 'approved', 'merged', ?3)", params![id, unix_timestamp(), if already { "Source was already reachable from target" } else { "Created explicit merge commit" }]).map_err(db_error)?;
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

#[tauri::command]
pub async fn kanban_cleanup_environment(
    id: String,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = REPOSITORY_OPERATION_LOCK.get_or_init(|| Mutex::new(())).lock().map_err(|_| "Repository operation lock failed".to_string())?;
        let result = with_connection(|connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
            let (status, card_revision): (String, i64) = transaction.query_row("SELECT status, workflow_revision FROM kanban_cards WHERE id=?1", [&id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(db_error)?;
            if status != "merged" { return Err("Only a Merged card environment can be cleaned up".to_string()); }
            if card_revision != expected_workflow_revision { return Err("Card changed; reload before cleanup".to_string()); }
            let (source_path, source_branch, repository_id, target_path, target_branch, recorded_tip, environment_revision): (String, String, String, String, String, String, i64) = transaction.query_row(
                "SELECT worktree_path, branch, repository_id, target_checkout_path, target_branch, source_revision, revision FROM card_environments WHERE card_id=?1", [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
            ).map_err(db_error)?;
            if environment_revision != expected_environment_revision { return Err("Card environment changed; reload before cleanup".to_string()); }
            let source = validate_checkout(&source_path, Some(&repository_id))?;
            let target = validate_checkout(&target_path, Some(&repository_id))?;
            if source.target_branch != source_branch || target.target_branch != target_branch { return Err("Source or target checkout changed branches before cleanup".to_string()); }
            let current_tip = git_output(&source_path, &["rev-parse", "HEAD"])?;
            if current_tip != recorded_tip { return Err("The source branch has new commits since merge; merge again before cleanup".to_string()); }
            if !Command::new("git").args(["-C", &target_path, "merge-base", "--is-ancestor", &current_tip, "HEAD"]).status().map_err(|error| error.to_string())?.success() {
                return Err("The source tip is no longer reachable from the recorded target".to_string());
            }
            ensure_registered_distinct_worktree(&target_path, &source_path)?;
            let removed = Command::new("git").args(["-C", &target_path, "worktree", "remove", "--", &source_path]).output().map_err(|error| error.to_string())?;
            if !removed.status.success() { return Err(format!("Git could not remove the source worktree: {}", String::from_utf8_lossy(&removed.stderr).trim())); }
            let deleted = Command::new("git").args(["-C", &target_path, "branch", "-d", "--", &source_branch]).output().map_err(|error| error.to_string())?;
            if !deleted.status.success() { return Err(format!("Worktree was removed, but Git safely retained the source branch: {}", String::from_utf8_lossy(&deleted.stderr).trim())); }
            transaction.execute("DELETE FROM card_environments WHERE card_id=?1 AND revision=?2", params![id, expected_environment_revision]).map_err(db_error)?;
            transaction.execute("UPDATE kanban_cards SET workflow_revision=workflow_revision+1, updated_at=?1 WHERE id=?2 AND workflow_revision=?3", params![unix_timestamp(), id, expected_workflow_revision]).map_err(db_error)?;
            transaction.execute("INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, summary) VALUES (?1, ?2, 'user', 'cleanup', 'success', 'Removed source worktree and branch')", params![id, unix_timestamp()]).map_err(db_error)?;
            transaction.commit().map_err(db_error)?;
            get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
        });
        if let Err(detail) = &result { record_operation_failure(&id, "cleanup", "cleanup_failed", detail); }
        result
    }).await.map_err(|error| format!("Cleanup worker failed: {error}"))?
}

fn record_operation_failure(card_id: &str, event_type: &str, error_code: &str, detail: &str) {
    let _ = with_connection(|connection| {
        connection.execute(
        "INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, error_code, error_detail) VALUES (?1, ?2, 'user', ?3, 'failure', ?4, ?5)",
        params![card_id, unix_timestamp(), event_type, error_code, detail],
    ).map(|_| ()).map_err(db_error)
    });
}

fn next_local_card_number(connection: &Connection, project_id: &str) -> Result<i64, String> {
    connection
        .query_row(
            "INSERT INTO kanban_project_sequences (project_id, next_number) VALUES (?1, 2)
         ON CONFLICT(project_id) DO UPDATE SET next_number = next_number + 1
         RETURNING next_number - 1",
            [project_id],
            |row| row.get(0),
        )
        .map_err(db_error)
}

pub(crate) fn with_connection<T>(
    work: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let path = app_data_file("workflow.sqlite3")?;
    let mut connection = Connection::open(path).map_err(db_error)?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(db_error)?;
    migrate(&connection)?;
    work(&mut connection)
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), String> {
    connection.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS kanban_cards (
            id TEXT PRIMARY KEY,
            external_provider TEXT NOT NULL,
            external_id TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            board_id TEXT NOT NULL DEFAULT '',
            board_title TEXT NOT NULL DEFAULT '',
            list_id TEXT NOT NULL DEFAULT '',
            list_title TEXT NOT NULL DEFAULT '',
            card_url TEXT NOT NULL DEFAULT '',
            assignee_names TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'needs_refinement'
                CHECK(status IN ('needs_refinement', 'ready', 'agent_working', 'needs_human', 'approved', 'merged')),
            workflow_revision INTEGER NOT NULL DEFAULT 1,
            project_id TEXT,
            workspace_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            in_scope INTEGER NOT NULL DEFAULT 1,
            UNIQUE(external_provider, external_id)
         );
         CREATE INDEX IF NOT EXISTS kanban_cards_status_idx ON kanban_cards(status, updated_at);
         CREATE TABLE IF NOT EXISTS kanban_project_sequences (
            project_id TEXT PRIMARY KEY,
            next_number INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS kanban_cleaned_cards (
            external_provider TEXT NOT NULL,
            external_id TEXT NOT NULL,
            cleaned_at INTEGER NOT NULL,
            PRIMARY KEY(external_provider, external_id)
         );
         CREATE TABLE IF NOT EXISTS card_environments (
            id TEXT PRIMARY KEY,
            card_id TEXT NOT NULL UNIQUE REFERENCES kanban_cards(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL,
            worktree_path TEXT NOT NULL,
            branch TEXT NOT NULL DEFAULT '',
            repository_id TEXT,
            target_checkout_path TEXT,
            target_branch TEXT,
            source_revision TEXT,
            target_revision TEXT,
            lifecycle_state TEXT NOT NULL DEFAULT 'ready' CHECK(lifecycle_state IN ('creating', 'ready', 'cleanup_pending', 'cleanup_failed')),
            revision INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS card_panes (
            id TEXT PRIMARY KEY,
            environment_id TEXT NOT NULL REFERENCES card_environments(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('terminal', 'pi')),
            command TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS card_layouts (
            environment_id TEXT PRIMARY KEY REFERENCES card_environments(id) ON DELETE CASCADE,
            split_layout TEXT NOT NULL,
            focused_pane_id TEXT,
            updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS card_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id TEXT NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL,
            actor TEXT NOT NULL,
            event_type TEXT NOT NULL,
            outcome TEXT NOT NULL,
            from_status TEXT,
            to_status TEXT,
            summary TEXT,
            error_code TEXT,
            error_detail TEXT
         );
         CREATE INDEX IF NOT EXISTS card_events_card_idx ON card_events(card_id, created_at DESC);
         CREATE TRIGGER IF NOT EXISTS card_events_bound AFTER INSERT ON card_events BEGIN
            DELETE FROM card_events WHERE card_id = NEW.card_id AND id NOT IN (
              SELECT id FROM card_events WHERE card_id = NEW.card_id ORDER BY created_at DESC, id DESC LIMIT 200
            );
         END;
         CREATE TABLE IF NOT EXISTS card_service_definitions (
            id TEXT PRIMARY KEY,
            environment_id TEXT NOT NULL REFERENCES card_environments(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            command TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
         );
         INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, unixepoch());"
    ).map_err(db_error)?;
    let columns = connection
        .prepare("PRAGMA table_info(kanban_cards)")
        .map_err(db_error)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    if !columns.iter().any(|column| column == "sort_order") {
        connection
            .execute(
                "ALTER TABLE kanban_cards ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(db_error)?;
    }
    if !columns.iter().any(|column| column == "assignee_names") {
        connection
            .execute(
                "ALTER TABLE kanban_cards ADD COLUMN assignee_names TEXT NOT NULL DEFAULT '[]'",
                [],
            )
            .map_err(db_error)?;
    }
    if !columns.iter().any(|column| column == "in_scope") {
        connection
            .execute(
                "ALTER TABLE kanban_cards ADD COLUMN in_scope INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .map_err(db_error)?;
    }
    if !columns.iter().any(|column| column == "workflow_revision") {
        connection
            .execute(
                "ALTER TABLE kanban_cards ADD COLUMN workflow_revision INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .map_err(db_error)?;
    }
    let environment_columns = connection
        .prepare("PRAGMA table_info(card_environments)")
        .map_err(db_error)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    for (name, sql) in [
        (
            "repository_id",
            "ALTER TABLE card_environments ADD COLUMN repository_id TEXT",
        ),
        (
            "target_checkout_path",
            "ALTER TABLE card_environments ADD COLUMN target_checkout_path TEXT",
        ),
        (
            "target_branch",
            "ALTER TABLE card_environments ADD COLUMN target_branch TEXT",
        ),
        (
            "source_revision",
            "ALTER TABLE card_environments ADD COLUMN source_revision TEXT",
        ),
        (
            "target_revision",
            "ALTER TABLE card_environments ADD COLUMN target_revision TEXT",
        ),
    ] {
        if !environment_columns.iter().any(|column| column == name) {
            connection.execute(sql, []).map_err(db_error)?;
        }
    }
    Ok(())
}

fn list_cards(connection: &mut Connection) -> Result<Vec<KanbanCard>, String> {
    let mut cards = {
        let mut statement = connection.prepare(
            "SELECT id, external_provider, external_id, title, content, board_id, board_title, list_id, list_title,
                    card_url, assignee_names, status, workflow_revision, project_id, created_at, updated_at, sort_order, in_scope
             FROM kanban_cards WHERE in_scope = 1 ORDER BY sort_order ASC, created_at ASC"
        ).map_err(db_error)?;
        let mapped = statement.query_map([], map_card).map_err(db_error)?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    for card in &mut cards {
        card.environment = load_environment(connection, &card.id)?;
        card.events = load_events(connection, &card.id)?;
    }
    Ok(cards)
}

fn get_card(connection: &Connection, id: &str) -> Result<Option<KanbanCard>, String> {
    let mut card = connection.query_row(
        "SELECT id, external_provider, external_id, title, content, board_id, board_title, list_id, list_title,
                card_url, assignee_names, status, workflow_revision, project_id, created_at, updated_at, sort_order, in_scope
         FROM kanban_cards WHERE id = ?1",
        [id],
        map_card,
    ).optional().map_err(db_error)?;
    if let Some(card) = &mut card {
        card.environment = load_environment(connection, id)?;
        card.events = load_events(connection, id)?;
    }
    Ok(card)
}

fn load_events(connection: &Connection, card_id: &str) -> Result<Vec<CardEvent>, String> {
    let mut statement = connection.prepare("SELECT id, created_at, actor, event_type, outcome, from_status, to_status, summary, error_code, error_detail FROM card_events WHERE card_id=?1 ORDER BY created_at DESC, id DESC LIMIT 100").map_err(db_error)?;
    let events = statement
        .query_map([card_id], |row| {
            Ok(CardEvent {
                id: row.get(0)?,
                created_at: row.get(1)?,
                actor: row.get(2)?,
                event_type: row.get(3)?,
                outcome: row.get(4)?,
                from_status: row.get(5)?,
                to_status: row.get(6)?,
                summary: row.get(7)?,
                error_code: row.get(8)?,
                error_detail: row.get(9)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(events)
}

fn load_environment(
    connection: &Connection,
    card_id: &str,
) -> Result<Option<CardEnvironment>, String> {
    let Some((id, project_id, worktree_path, branch, repository_id, target_checkout_path, target_branch, source_revision, target_revision, lifecycle_state, revision)) = connection.query_row(
        "SELECT id, project_id, worktree_path, branch, repository_id, target_checkout_path, target_branch, source_revision, target_revision, lifecycle_state, revision FROM card_environments WHERE card_id = ?1",
        [card_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, Option<String>>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, Option<String>>(8)?, row.get::<_, String>(9)?, row.get::<_, i64>(10)?)),
    ).optional().map_err(db_error)? else { return Ok(None); };
    let (split_layout, focused_pane_id) = connection
        .query_row(
            "SELECT split_layout, focused_pane_id FROM card_layouts WHERE environment_id = ?1",
            [&id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .map(|(layout, focused)| {
            (
                serde_json::from_str(&layout).unwrap_or(serde_json::json!({"kind":"empty"})),
                focused,
            )
        })
        .unwrap_or((serde_json::json!({"kind":"empty"}), None));
    let mut pane_statement = connection.prepare("SELECT id, role, kind, command, sort_order FROM card_panes WHERE environment_id = ?1 ORDER BY sort_order").map_err(db_error)?;
    let panes = pane_statement
        .query_map([&id], |row| {
            Ok(CardPane {
                id: row.get(0)?,
                role: row.get(1)?,
                kind: row.get(2)?,
                command: row.get(3)?,
                sort_order: row.get(4)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let mut service_statement = connection.prepare("SELECT id, name, command, sort_order FROM card_service_definitions WHERE environment_id = ?1 ORDER BY sort_order").map_err(db_error)?;
    let services = service_statement
        .query_map([&id], |row| {
            Ok(CardServiceDefinition {
                id: row.get(0)?,
                name: row.get(1)?,
                command: row.get(2)?,
                sort_order: row.get(3)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(Some(CardEnvironment {
        id,
        card_id: card_id.to_string(),
        project_id,
        worktree_path,
        branch,
        repository_id,
        target_checkout_path,
        target_branch,
        source_revision,
        target_revision,
        lifecycle_state,
        revision,
        split_layout,
        focused_pane_id,
        panes,
        services,
    }))
}

fn map_card(row: &rusqlite::Row<'_>) -> rusqlite::Result<KanbanCard> {
    Ok(KanbanCard {
        id: row.get(0)?,
        provider: {
            let provider: String = row.get(1)?;
            if provider.starts_with("local:") {
                "local".to_string()
            } else {
                provider
            }
        },
        external_id: row.get(2)?,
        title: row.get(3)?,
        content: row.get(4)?,
        board_id: row.get(5)?,
        board_title: row.get(6)?,
        list_id: row.get(7)?,
        list_title: row.get(8)?,
        card_url: row.get(9)?,
        assignee_names: serde_json::from_str(&row.get::<_, String>(10)?).unwrap_or_default(),
        status: row.get(11)?,
        workflow_revision: row.get(12)?,
        project_id: row.get(13)?,
        environment: None,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        sort_order: row.get(16)?,
        in_scope: row.get(17)?,
        events: Vec::new(),
    })
}

fn git_output(path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("Git command failed in {path}")
        } else {
            detail
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn repository_identity(path: &str) -> Result<String, String> {
    let common = git_output(path, &["rev-parse", "--git-common-dir"])?;
    let common = if Path::new(&common).is_absolute() {
        PathBuf::from(common)
    } else {
        Path::new(path).join(common)
    };
    common
        .canonicalize()
        .map_err(|error| format!("Could not identify repository for {path}: {error}"))?
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "Repository path is not valid UTF-8".to_string())
}

fn has_git_operation(path: &str) -> Result<bool, String> {
    for marker in [
        "MERGE_HEAD",
        "rebase-merge",
        "rebase-apply",
        "CHERRY_PICK_HEAD",
    ] {
        let marker_path = git_output(path, &["rev-parse", "--git-path", marker])?;
        let marker_path = if Path::new(&marker_path).is_absolute() {
            PathBuf::from(marker_path)
        } else {
            Path::new(path).join(marker_path)
        };
        if marker_path.exists() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn validate_checkout(
    path: &str,
    expected_repository: Option<&str>,
) -> Result<EnvironmentStartPreflight, String> {
    validate_checkout_with_policy(path, expected_repository, true)
}

fn validate_target_checkout(
    path: &str,
    expected_repository: Option<&str>,
) -> Result<EnvironmentStartPreflight, String> {
    validate_checkout_with_policy(path, expected_repository, false)
}

fn validate_checkout_with_policy(
    path: &str,
    expected_repository: Option<&str>,
    require_clean: bool,
) -> Result<EnvironmentStartPreflight, String> {
    let canonical = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("Checkout does not exist at {path}: {error}"))?;
    let canonical = canonical
        .to_str()
        .ok_or_else(|| "Checkout path is not valid UTF-8".to_string())?
        .to_string();
    let repository_id = repository_identity(&canonical)?;
    if expected_repository.is_some_and(|expected| expected != repository_id) {
        return Err(format!(
            "Checkout at {path} belongs to a different repository"
        ));
    }
    let branch = git_output(&canonical, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map_err(|_| format!("Checkout at {path} is detached; a named branch is required"))?;
    if require_clean
        && !git_output(
            &canonical,
            &["status", "--porcelain=v1", "--untracked-files=all"],
        )?
        .is_empty()
    {
        return Err(format!(
            "Checkout at {path} has modified or untracked files"
        ));
    }
    if has_git_operation(&canonical)? {
        return Err(format!(
            "Checkout at {path} has an in-progress Git operation"
        ));
    }
    let revision = git_output(&canonical, &["rev-parse", "HEAD"])?;
    Ok(EnvironmentStartPreflight {
        repository_id,
        target_checkout_path: canonical,
        target_branch: branch,
        target_revision: revision,
    })
}

fn ensure_registered_distinct_worktree(target: &str, source: &str) -> Result<(), String> {
    let output = git_output(target, &["worktree", "list", "--porcelain"])?;
    let paths = output
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .collect::<Vec<_>>();
    let source = Path::new(source)
        .canonicalize()
        .map_err(|error| format!("Setup result at {source} cannot be validated: {error}"))?;
    let target = Path::new(target)
        .canonicalize()
        .map_err(|error| format!("Target checkout cannot be validated: {error}"))?;
    if source == target
        || !paths
            .iter()
            .any(|path| Path::new(path).canonicalize().ok().as_ref() == Some(&source))
    {
        return Err(format!(
            "Setup result {} is not a distinct registered worktree; recover it manually",
            source.display()
        ));
    }
    Ok(())
}

fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn db_error(error: rusqlite::Error) -> String {
    format!("Kanban database error: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_card(connection: &mut Connection) -> KanbanCard {
        let transaction = connection.transaction().unwrap();
        let now = unix_timestamp();
        transaction.execute(
            "INSERT INTO kanban_cards
             (id, external_provider, external_id, title, content, status, project_id, created_at, updated_at)
             VALUES ('local:test', 'local:project', '1', 'Draft', 'Old description', 'needs_refinement', 'project', ?1, ?1)",
            [now],
        ).unwrap();
        transaction.commit().unwrap();
        get_card(connection, "local:test").unwrap().unwrap()
    }

    #[test]
    fn pi_can_update_only_local_card_fields() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        local_card(&mut connection);

        let updated = update_local_card(
            &connection,
            "local:test",
            Some("Final title"),
            Some("Final description"),
        )
        .unwrap();

        assert_eq!(updated.title, "Final title");
        assert_eq!(updated.content, "Final description");
        assert_eq!(updated.status, "needs_refinement");
        assert!(update_local_card(&connection, "superthread:1", None, Some("No")).is_err());
    }

    #[test]
    fn finishing_refinement_persists_the_brief_and_marks_the_card_ready() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        local_card(&mut connection);

        let updated = finish_local_refinement(
            &mut connection,
            "local:test",
            Some("Implementation brief"),
            "Outcome and acceptance criteria",
        )
        .unwrap();

        assert_eq!(updated.title, "Implementation brief");
        assert_eq!(updated.content, "Outcome and acceptance criteria");
        assert_eq!(updated.status, "ready");
    }

    #[test]
    fn refinement_requires_a_nonempty_final_description() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        local_card(&mut connection);

        assert!(finish_local_refinement(&mut connection, "local:test", None, "  ").is_err());
        assert_eq!(
            get_card(&connection, "local:test").unwrap().unwrap().status,
            "needs_refinement"
        );
    }

    #[test]
    fn sync_preserves_local_workflow_state() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        let snapshot = || KanbanCardSnapshot {
            id: "42".into(),
            title: "First title".into(),
            content: String::new(),
            board_id: "b1".into(),
            board_title: "Roadmap".into(),
            list_id: "doing".into(),
            list_title: "Doing".into(),
            card_url: String::new(),
            assignee_names: vec!["Ada".into()],
            in_scope: true,
        };
        sync_cards(&mut connection, vec![snapshot()]).unwrap();
        connection
            .execute(
                "UPDATE kanban_cards SET status = 'approved' WHERE id = 'superthread:42'",
                [],
            )
            .unwrap();
        let mut changed = snapshot();
        changed.title = "Updated upstream".into();
        let cards = sync_cards(&mut connection, vec![changed]).unwrap();
        assert_eq!(cards[0].status, "approved");
        assert_eq!(cards[0].title, "Updated upstream");
    }

    #[test]
    fn rejects_unknown_statuses() {
        assert!(!STATUSES.contains(&"waiting_for_magic"));
    }

    #[test]
    fn workflow_transitions_must_be_adjacent() {
        let current = STATUSES
            .iter()
            .position(|status| *status == "ready")
            .unwrap();
        let adjacent = STATUSES
            .iter()
            .position(|status| *status == "agent_working")
            .unwrap();
        let skipped = STATUSES
            .iter()
            .position(|status| *status == "approved")
            .unwrap();
        assert_eq!(current.abs_diff(adjacent), 1);
        assert!(current.abs_diff(skipped) > 1);
    }

    #[test]
    fn does_not_reimport_cleaned_cards() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        connection.execute(
            "INSERT INTO kanban_cleaned_cards (external_provider, external_id, cleaned_at) VALUES ('superthread', '42', 1)",
            [],
        ).unwrap();
        let cards = sync_cards(
            &mut connection,
            vec![KanbanCardSnapshot {
                id: "42".into(),
                title: "Already cleaned".into(),
                content: String::new(),
                board_id: "b1".into(),
                board_title: "Roadmap".into(),
                list_id: "doing".into(),
                list_title: "Doing".into(),
                card_url: String::new(),
                assignee_names: Vec::new(),
                in_scope: true,
            }],
        )
        .unwrap();
        assert!(cards.is_empty());
    }

    #[test]
    fn local_card_numbers_are_monotonic_per_project() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        assert_eq!(next_local_card_number(&connection, "one").unwrap(), 1);
        assert_eq!(next_local_card_number(&connection, "one").unwrap(), 2);
        assert_eq!(next_local_card_number(&connection, "two").unwrap(), 1);
    }

    #[test]
    fn local_card_creation_assigns_project_status_description_number_and_order() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();

        let first =
            create_local_card(&mut connection, "p1", "Project One", " First card ", "").unwrap();
        let second = create_local_card(
            &mut connection,
            "p1",
            "Project One",
            "Second card",
            " Details ",
        )
        .unwrap();

        assert_eq!(first.external_id, "1");
        assert_eq!(first.status, "needs_refinement");
        assert_eq!(first.project_id.as_deref(), Some("p1"));
        assert_eq!(first.board_title, "Project One");
        assert_eq!(first.content, "");
        assert_eq!(first.sort_order, 0);
        assert_eq!(second.external_id, "2");
        assert_eq!(second.content, "Details");
        assert_eq!(second.sort_order, 1);
    }

    #[test]
    fn create_card_tool_is_eligible_only_for_local_projects() {
        assert!(is_local_kanban_source("local"));
        assert!(!is_local_kanban_source("superthread"));
    }

    #[test]
    fn environment_aggregate_restores_layout_panes_and_service_definitions() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        local_card(&mut connection);
        connection.execute(
            "INSERT INTO card_environments (id, card_id, project_id, worktree_path, branch, lifecycle_state, revision, created_at, updated_at)
             VALUES ('environment:test', 'local:test', 'project', '/repo-card-1', 'stacks/card-1', 'ready', 4, 1, 1)", [],
        ).unwrap();
        connection.execute(
            "INSERT INTO card_panes (id, environment_id, role, kind, sort_order) VALUES ('pane:shell', 'environment:test', 'shell', 'terminal', 0)", [],
        ).unwrap();
        connection.execute(
            "INSERT INTO card_layouts (environment_id, split_layout, focused_pane_id, updated_at)
             VALUES ('environment:test', '{\"kind\":\"leaf\",\"terminalId\":\"pane:shell\"}', 'pane:shell', 1)", [],
        ).unwrap();
        connection.execute(
            "INSERT INTO card_service_definitions (id, environment_id, name, command, sort_order)
             VALUES ('service:server', 'environment:test', 'server', 'npm run dev', 0)", [],
        ).unwrap();

        let environment = get_card(&connection, "local:test")
            .unwrap()
            .unwrap()
            .environment
            .unwrap();
        assert_eq!(environment.worktree_path, "/repo-card-1");
        assert_eq!(environment.revision, 4);
        assert_eq!(environment.panes[0].id, "pane:shell");
        assert_eq!(environment.services[0].command, "npm run dev");
        assert_eq!(environment.split_layout["terminalId"], "pane:shell");
    }

    #[test]
    fn card_runtime_owns_pi_session_metadata() {
        let owner = card_pi_session("kanban-card:superthread:42:planning")
            .unwrap()
            .unwrap();
        assert_eq!(owner.card_id, "superthread:42");
        assert_eq!(owner.thread, "planning");
        assert!(owner
            .directory
            .ends_with("superthread_42/pi-sessions/planning"));
        assert!(card_pi_session("workspace:123").unwrap().is_none());
    }

    fn git_ok(path: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn merge_repository() -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "stacks-card-merge-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let target = root.join("target");
        let source = root.join("source");
        fs::create_dir_all(&target).unwrap();
        git_ok(&target, &["init", "-b", "main"]);
        git_ok(&target, &["config", "user.email", "stacks@example.com"]);
        git_ok(&target, &["config", "user.name", "Stacks Tests"]);
        fs::write(target.join("base.txt"), "base\n").unwrap();
        git_ok(&target, &["add", "."]);
        git_ok(&target, &["commit", "-m", "base"]);
        git_ok(
            &target,
            &["worktree", "add", "-b", "feature", source.to_str().unwrap()],
        );
        fs::write(source.join("feature.txt"), "feature\n").unwrap();
        git_ok(&source, &["add", "."]);
        git_ok(&source, &["commit", "-m", "feature"]);
        (root, target, source)
    }

    fn approval_connection(source: &Path, target: &Path) -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        let now = unix_timestamp();
        connection.execute("INSERT INTO kanban_cards (id, external_provider, external_id, title, status, workflow_revision, created_at, updated_at) VALUES ('local:approve', 'local:p', '1', 'Approve', 'needs_human', 5, ?1, ?1)", [now]).unwrap();
        let repository = repository_identity(target.to_str().unwrap()).unwrap();
        let source_tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        let target_tip = git_output(target.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        connection.execute("INSERT INTO card_environments (id, card_id, project_id, worktree_path, branch, repository_id, target_checkout_path, target_branch, source_revision, target_revision, lifecycle_state, revision, created_at, updated_at) VALUES ('approve-e', 'local:approve', 'p', ?1, 'feature', ?2, ?3, 'main', ?4, ?5, 'ready', 2, ?6, ?6)", params![source.to_str().unwrap(), repository, target.to_str().unwrap(), source_tip, target_tip, now]).unwrap();
        connection
    }

    #[test]
    fn approval_accepts_clean_committed_work_and_records_transition() {
        let (root, target, source) = merge_repository();
        let mut connection = approval_connection(&source, &target);
        let result =
            approve_and_commit_with_failure_record(&mut connection, "local:approve", 5, 2).unwrap();
        assert_eq!(result.card.status, "approved");
        assert_eq!(result.card.workflow_revision, 6);
        assert_eq!(result.card.environment.unwrap().revision, 3);
        let event: (String, String) = connection.query_row(
            "SELECT event_type, outcome FROM card_events WHERE card_id='local:approve' ORDER BY id DESC LIMIT 1",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(event, ("approve_and_commit".into(), "success".into()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn approval_reconciles_the_expected_agent_status_cycle() {
        for (status, revision) in [("agent_working", 6), ("needs_human", 7)] {
            let (root, target, source) = merge_repository();
            let mut connection = approval_connection(&source, &target);
            connection.execute("UPDATE kanban_cards SET status=?1, workflow_revision=?2 WHERE id='local:approve'", params![status, revision]).unwrap();
            let result = approve_and_commit(&mut connection, "local:approve", 5, 2).unwrap();
            assert_eq!(result.card.status, "approved");
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn approval_reports_modified_staged_untracked_and_deleted_files() {
        enum Dirty {
            Modified,
            Staged,
            Untracked,
            Deleted,
        }
        for (dirty, expected_counts) in [
            (Dirty::Modified, "0 new, 1 modified, 0 deleted"),
            (Dirty::Staged, "0 new, 1 modified, 0 deleted"),
            (Dirty::Untracked, "1 new, 0 modified, 0 deleted"),
            (Dirty::Deleted, "0 new, 0 modified, 1 deleted"),
        ] {
            let (root, target, source) = merge_repository();
            let mut connection = approval_connection(&source, &target);
            match dirty {
                Dirty::Modified => fs::write(source.join("feature.txt"), "changed\n").unwrap(),
                Dirty::Staged => {
                    fs::write(source.join("feature.txt"), "staged\n").unwrap();
                    git_ok(&source, &["add", "feature.txt"]);
                }
                Dirty::Untracked => fs::write(source.join("new.txt"), "new\n").unwrap(),
                Dirty::Deleted => fs::remove_file(source.join("feature.txt")).unwrap(),
            }
            let detail =
                approve_and_commit_with_failure_record(&mut connection, "local:approve", 5, 2)
                    .unwrap_err();
            assert!(detail.contains("worktree is not clean"), "{detail}");
            assert!(detail.contains(expected_counts), "{detail}");
            assert!(detail.contains("files remain"), "{detail}");
            assert_eq!(
                get_card(&connection, "local:approve")
                    .unwrap()
                    .unwrap()
                    .status,
                "needs_human"
            );
            let failure: (String, String) = connection.query_row(
                "SELECT outcome, error_detail FROM card_events WHERE card_id='local:approve' ORDER BY id DESC LIMIT 1",
                [], |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap();
            assert_eq!(failure.0, "failure");
            assert!(failure.1.contains("files remain"));
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn approval_rejects_wrong_branch_and_stale_revisions() {
        let (root, target, source) = merge_repository();
        let mut connection = approval_connection(&source, &target);
        connection
            .execute(
                "UPDATE card_environments SET branch='unexpected' WHERE card_id='local:approve'",
                [],
            )
            .unwrap();
        assert!(approve_and_commit(&mut connection, "local:approve", 5, 2)
            .unwrap_err()
            .contains("expected unexpected"));
        connection
            .execute(
                "UPDATE card_environments SET branch='feature' WHERE card_id='local:approve'",
                [],
            )
            .unwrap();
        assert!(approve_and_commit(&mut connection, "local:approve", 4, 2)
            .unwrap_err()
            .contains("Card changed"));
        assert!(approve_and_commit(&mut connection, "local:approve", 5, 1)
            .unwrap_err()
            .contains("environment changed"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merge_creates_explicit_commit_and_transitions_only_after_verification() {
        let (root, target, source) = merge_repository();
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        let now = unix_timestamp();
        connection.execute("INSERT INTO kanban_cards (id, external_provider, external_id, title, status, workflow_revision, created_at, updated_at) VALUES ('local:merge', 'local:p', '1', 'Merge', 'approved', 3, ?1, ?1)", [now]).unwrap();
        let repository = repository_identity(target.to_str().unwrap()).unwrap();
        let source_tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        let target_tip = git_output(target.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        connection.execute("INSERT INTO card_environments (id, card_id, project_id, worktree_path, branch, repository_id, target_checkout_path, target_branch, source_revision, target_revision, revision, created_at, updated_at) VALUES ('e', 'local:merge', 'p', ?1, 'feature', ?2, ?3, 'main', ?4, ?5, 2, ?6, ?6)", params![source.to_str().unwrap(), repository, target.to_str().unwrap(), source_tip, target_tip, now]).unwrap();
        let result = merge_card(&mut connection, "local:merge", 3, 2).unwrap();
        assert_eq!(result.card.status, "merged");
        assert_eq!(
            git_output(
                target.to_str().unwrap(),
                &["rev-list", "--parents", "-n", "1", "HEAD"]
            )
            .unwrap()
            .split_whitespace()
            .count(),
            3
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn start_preflight_allows_dirty_targets_but_source_validation_remains_strict() {
        let (root, target, _source) = merge_repository();
        let committed_head = git_output(target.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        fs::write(target.join("base.txt"), "modified only in primary\n").unwrap();
        fs::write(target.join("dirty.txt"), "untracked only in primary\n").unwrap();
        let preflight = validate_target_checkout(target.to_str().unwrap(), None).unwrap();
        assert_eq!(preflight.target_revision, committed_head);
        let dirty_source = root.join("dirty-source");
        git_ok(
            &target,
            &[
                "worktree",
                "add",
                "-b",
                "dirty-feature",
                dirty_source.to_str().unwrap(),
            ],
        );
        assert_eq!(
            fs::read_to_string(dirty_source.join("base.txt")).unwrap(),
            "base\n"
        );
        assert!(!dirty_source.join("dirty.txt").exists());
        assert!(validate_checkout(target.to_str().unwrap(), None)
            .unwrap_err()
            .contains("modified or untracked"));
        git_ok(&target, &["checkout", "--detach"]);
        assert!(validate_target_checkout(target.to_str().unwrap(), None)
            .unwrap_err()
            .contains("detached"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn makes_card_ids_safe_for_directories() {
        assert_eq!(
            safe_card_key("superthread:42/../../oops"),
            "superthread_42_______oops"
        );
    }
}
