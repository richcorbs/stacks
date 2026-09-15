use crate::fs_paths::app_data_file;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

static REPOSITORY_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static BOARD_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub(crate) fn set_app_handle(app: AppHandle) {
    let _ = APP_HANDLE.set(app);
}

const STATUSES: [&str; 8] = [
    "needs_refinement",
    "refining",
    "needs_refinement_input",
    "ready",
    "agent_working",
    "needs_human",
    "approved",
    "done",
];
const REFINEMENT_STATUSES: [&str; 3] = ["needs_refinement", "refining", "needs_refinement_input"];
const REORDER_CONFLICT_CODE: &str = "KANBAN_REORDER_CONFLICT";

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
    #[serde(default)]
    pub task_parent_id: Option<String>,
    #[serde(default)]
    pub task_parent_title: Option<String>,
    #[serde(default)]
    pub total_task_children: u64,
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
    layout_revision: i64,
    split_layout: serde_json::Value,
    focused_pane_id: Option<String>,
    panes: Vec<CardPane>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EnvironmentHealthIssue {
    code: String,
    message: String,
    step: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CardEnvironmentHealth {
    card_id: String,
    issues: Vec<EnvironmentHealthIssue>,
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

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CardPullRequest {
    repository: String,
    number: u64,
    title: String,
    url: String,
    state: String,
    draft: bool,
    ci_status: String,
    review_state: String,
    has_conflicts: bool,
    mergeable: bool,
    blockers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CardRelationshipSummary {
    id: String,
    external_id: String,
    title: String,
    status: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ApprovedChildSpec {
    #[serde(default)]
    id: Option<String>,
    title: String,
    content: String,
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
    completion_outcome: Option<String>,
    feature_environment: bool,
    pull_request: Option<CardPullRequest>,
    delivery_operation_stage: Option<String>,
    delivery_error: Option<String>,
    workflow_revision: i64,
    record_revision: i64,
    project_id: Option<String>,
    parent: Option<CardRelationshipSummary>,
    child_count: u64,
    children: Vec<CardRelationshipSummary>,
    hierarchy_finalized: bool,
    environment: Option<CardEnvironment>,
    created_at: i64,
    updated_at: i64,
    sort_order: i64,
    in_scope: bool,
    events: Vec<CardEvent>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CardSnapshot {
    pub card: KanbanCard,
    pub board_revision: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BoardSnapshot {
    pub cards: Vec<KanbanCard>,
    pub board_revision: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BoardChange {
    pub upserts: Vec<KanbanCard>,
    pub removed_ids: Vec<String>,
    pub board_revision: i64,
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
pub fn kanban_cards() -> Result<BoardSnapshot, String> {
    with_connection(|connection| reconcile_card_ownership(connection))?;
    with_connection(board_snapshot)
}

#[tauri::command]
pub fn kanban_card_snapshot(id: String) -> Result<CardSnapshot, String> {
    with_connection(|connection| {
        let card =
            get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())?;
        Ok(CardSnapshot {
            card,
            board_revision: board_revision(connection)?,
        })
    })
}

#[tauri::command]
pub async fn kanban_environment_health(
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

#[tauri::command]
pub fn kanban_create_local_card(
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

#[tauri::command]
pub fn kanban_update_local_card(
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

#[tauri::command]
pub fn kanban_finish_local_refinement(
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
    let (source_status, project_id, parent_id, finalized, existing_child_count): (String, String, Option<String>, bool, i64) = transaction
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
    if !matches!(
        source_status.as_str(),
        "needs_refinement" | "refining" | "needs_refinement_input" | "ready"
    ) {
        return Err("Only a card being refined can finish refinement".to_string());
    }
    update_local_card(&transaction, id, title, Some(content))?;
    if let Some(children) = children.filter(|items| !items.is_empty()) {
        finalize_breakdown(&transaction, id, &project_id, children)?;
    } else if source_status != "ready" {
        let now = unix_timestamp();
        transaction.execute(
            "UPDATE kanban_cards SET status = 'ready', workflow_revision = workflow_revision + 1, updated_at = ?1,
                sort_order = (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards AS destination WHERE destination.status = 'ready')
             WHERE id = ?2 AND status = ?3",
            params![now, id, source_status],
        ).map_err(db_error)?;
        transaction.execute("INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, from_status, to_status) VALUES (?1, ?2, 'agent', 'status_transition', 'success', ?3, 'ready')", params![id, now, source_status]).map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)?;
    get_card(connection, id)?.ok_or_else(|| "Local Kanban card was not found".to_string())
}

fn set_card_parent(
    connection: &Connection,
    child_id: &str,
    parent_id: Option<&str>,
) -> Result<KanbanCard, String> {
    let (provider, status, project_id, has_children, finalized): (String, String, Option<String>, bool, bool) = connection.query_row(
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
        let (parent_provider, parent_project, parent_parent, parent_environment, parent_status, parent_finalized): (String, Option<String>, Option<String>, bool, String, bool) = connection.query_row(
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

fn finalize_breakdown(
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
            let (child_project, child_parent, status, provider): (Option<String>, Option<String>, String, String) = transaction.query_row(
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
        transaction.execute(
            "UPDATE kanban_cards SET parent_id=?1, status='ready', workflow_revision=workflow_revision+1, updated_at=?2,
             sort_order=(SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards AS destination WHERE destination.status='ready') WHERE id=?3",
            params![parent_id, now, child_id],
        ).map_err(db_error)?;
    }
    transaction.execute(
        "UPDATE kanban_cards SET hierarchy_finalized=1, status='ready', workflow_revision=workflow_revision+1, updated_at=?1 WHERE id=?2",
        params![now, parent_id],
    ).map_err(db_error)?;
    Ok(())
}

pub(crate) fn kanban_finish_external_refinement(id: String) -> Result<KanbanCard, String> {
    with_connection(|connection| finish_external_refinement(connection, &id))
}

pub(crate) fn finish_external_refinement(
    connection: &mut Connection,
    id: &str,
) -> Result<KanbanCard, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let (provider, status, revision): (String, String, i64) = transaction
        .query_row(
            "SELECT external_provider, status, workflow_revision FROM kanban_cards WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Kanban card was not found".to_string())?;
    if provider != "superthread" {
        return Err("Only an externally managed card can use this refinement action".to_string());
    }
    if status == "ready" {
        transaction.commit().map_err(db_error)?;
        return get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string());
    }
    if !matches!(
        status.as_str(),
        "needs_refinement" | "refining" | "needs_refinement_input"
    ) {
        return Err("Only a card being refined can finish refinement".to_string());
    }
    let now = unix_timestamp();
    let changed = transaction.execute(
        "UPDATE kanban_cards SET status = 'ready', workflow_revision = workflow_revision + 1, updated_at = ?1,
            sort_order = (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards AS destination WHERE destination.status = 'ready')
         WHERE id = ?2 AND status = ?3 AND workflow_revision = ?4",
        params![now, id, status, revision],
    ).map_err(db_error)?;
    if changed == 0 {
        return Err("Card changed; reload before finishing refinement".to_string());
    }
    transaction.execute(
        "INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, from_status, to_status) VALUES (?1, ?2, 'agent', 'status_transition', 'success', ?3, 'ready')",
        params![id, now, status],
    ).map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string())
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

pub(crate) fn validate_card_pi_start(
    card_id: &str,
    thread: &str,
    cwd: &str,
    supplied_project_id: &str,
) -> Result<(), String> {
    with_connection(|connection| {
        crate::store::migrate_store_schema(connection)?;
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

fn unique_superthread_project_id(connection: &Connection) -> Result<String, String> {
    crate::store::migrate_store_schema(connection)?;
    let ids = connection
        .prepare("SELECT id FROM projects WHERE kanban_source = 'superthread' ORDER BY id")
        .map_err(db_error)?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    match ids.as_slice() {
        [id] => Ok(id.clone()),
        [] => Err("Superthread sync requires exactly one Stacks project configured with kanban_source 'superthread'.".to_string()),
        _ => Err("Superthread sync is blocked because multiple Stacks projects are configured with kanban_source 'superthread'.".to_string()),
    }
}

fn reconcile_card_ownership(connection: &Connection) -> Result<(), String> {
    crate::store::migrate_store_schema(connection)?;
    let superthread_ids = connection
        .prepare("SELECT id FROM projects WHERE kanban_source = 'superthread' ORDER BY id")
        .map_err(db_error)?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let rows = connection
        .prepare("SELECT id, external_provider, project_id, board_id FROM kanban_cards ORDER BY id")
        .map_err(db_error)?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    for (id, provider, stored_project, board_id) in rows {
        let owner = if provider == "superthread" {
            match superthread_ids.as_slice() {
                [owner] => owner.clone(),
                [] => return Err(format!("Card {id} has no owner: configure exactly one Superthread Kanban project.")),
                _ => return Err(format!("Card {id} has ambiguous ownership: multiple Superthread Kanban projects are configured.")),
            }
        } else if provider.starts_with("local:") {
            let provider_project = provider.strip_prefix("local:").unwrap_or_default();
            stored_project
                .clone()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| (!provider_project.is_empty()).then(|| provider_project.to_string()))
                .or_else(|| (!board_id.trim().is_empty()).then(|| board_id.clone()))
                .ok_or_else(|| format!("Local card {id} has no deterministic project ownership."))?
        } else {
            return Err(format!("Card {id} uses unsupported provider {provider}."));
        };
        let source: Option<String> = connection
            .query_row(
                "SELECT COALESCE(kanban_source, 'local') FROM projects WHERE id=?1",
                [&owner],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        let compatible = matches!(
            (provider.as_str(), source.as_deref()),
            ("superthread", Some("superthread"))
        ) || (provider.starts_with("local:")
            && source.as_deref() == Some("local"));
        if !compatible {
            return Err(format!("Card {id} references missing or incompatible project {owner}. Repair its project configuration before using the board."));
        }
        if stored_project.as_deref() != Some(owner.as_str()) {
            connection
                .execute(
                    "UPDATE kanban_cards SET project_id=?1 WHERE id=?2",
                    params![owner, id],
                )
                .map_err(db_error)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn kanban_sync_superthread_cards(
    cards: Vec<KanbanCardSnapshot>,
) -> Result<BoardSnapshot, String> {
    with_connection(|connection| {
        reconcile_card_ownership(connection)?;
        sync_cards(connection, cards).map(|_| ())
    })?;
    with_connection(board_snapshot)
}

fn sync_cards(
    connection: &mut Connection,
    cards: Vec<KanbanCardSnapshot>,
) -> Result<Vec<KanbanCard>, String> {
    let superthread_project_id = unique_superthread_project_id(connection)?;
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
                    assignee_names = ?8, parent_id=?9, provider_parent_title=?10, provider_child_count=?11,
                    hierarchy_finalized=CASE WHEN ?11 > 0 THEN 1 ELSE hierarchy_finalized END, in_scope = 0, updated_at = ?12
                 WHERE external_provider = 'superthread' AND external_id = ?13",
                params![card.title.trim(), card.content, card.board_id, card.board_title, card.list_id,
                    card.list_title, card.card_url, serde_json::to_string(&card.assignee_names).map_err(|error| error.to_string())?,
                    card.task_parent_id.as_ref().map(|value| format!("superthread:{}", value)), card.task_parent_title,
                    card.total_task_children as i64, now, card.id.trim()],
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
                list_id, list_title, card_url, assignee_names, status, project_id, parent_id, provider_parent_title,
                provider_child_count, hierarchy_finalized, created_at, updated_at, sort_order, in_scope
             ) VALUES (?1, 'superthread', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'needs_refinement', ?11, ?12, ?13, ?14,
                CASE WHEN ?14 > 0 THEN 1 ELSE 0 END, ?15, ?15,
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
                project_id = excluded.project_id,
                parent_id = excluded.parent_id,
                provider_parent_title = excluded.provider_parent_title,
                provider_child_count = excluded.provider_child_count,
                hierarchy_finalized = excluded.hierarchy_finalized,
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
                superthread_project_id,
                card.task_parent_id.as_ref().map(|value| format!("superthread:{}", value)),
                card.task_parent_title,
                card.total_task_children as i64,
                now,
            ],
        ).map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)?;
    list_cards(connection)
}

fn validate_project_deletion(
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

#[tauri::command]
pub fn kanban_validate_project_deletion(project_id: String) -> Result<(), String> {
    with_connection(|connection| validate_project_deletion(connection, &project_id).map(|_| ()))
}

#[tauri::command]
pub fn kanban_delete_project_records(project_id: String) -> Result<(), String> {
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

fn validate_card_deletion(connection: &Connection, id: &str) -> Result<bool, String> {
    let Some(card) = get_card(connection, id)? else {
        return Ok(false);
    };
    if card.provider != "local" || card.status != "needs_refinement" || card.environment.is_some() {
        return Err(
            "Only local Needs refinement cards without environments can be deleted".to_string(),
        );
    }
    let child_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM kanban_cards WHERE parent_id=?1",
            [id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if child_count > 0 {
        return Err("A parent with children cannot be deleted".to_string());
    }
    Ok(true)
}

#[tauri::command]
pub fn kanban_delete_card(id: String) -> Result<BoardChange, String> {
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

#[tauri::command]
pub fn kanban_set_status(
    id: String,
    status: String,
    expected_revision: i64,
    actor: String,
) -> Result<CardSnapshot, String> {
    if !STATUSES.contains(&status.as_str()) {
        return Err(format!("Unknown Kanban status: {status}"));
    }
    with_connection(|connection| {
        set_card_status(connection, &id, &status, expected_revision, &actor, || {
            ensure_card_directory(&id).map(|_| ())
        })
        .map(|_| ())
    })?;
    fresh_card_snapshot(&id)
}

fn set_card_status<F>(
    connection: &mut Connection,
    id: &str,
    status: &str,
    expected_revision: i64,
    actor: &str,
    ensure_directory: F,
) -> Result<KanbanCard, String>
where
    F: FnOnce() -> Result<(), String>,
{
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let (current, revision, finalized): (String, i64, bool) = transaction
        .query_row(
            "SELECT status, workflow_revision, hierarchy_finalized FROM kanban_cards WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? != 0)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Kanban card was not found".to_string())?;
    if finalized {
        return Err("A finalized aggregate parent has no workflow".to_string());
    }
    // Check status before revision so a retry of an already successful transition is a no-op.
    if current == status {
        transaction.commit().map_err(db_error)?;
        return get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string());
    }
    if revision != expected_revision {
        return Err("Card changed; reload before trying again".to_string());
    }
    if !is_legal_status_transition(&current, status) {
        return Err(format!(
            "Illegal Kanban transition from {current} to {status}"
        ));
    }
    ensure_directory()?;
    let now = unix_timestamp();
    let changed = transaction.execute(
        "UPDATE kanban_cards SET status = ?1, workflow_revision = workflow_revision + 1, updated_at = ?2,
            sort_order = (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards AS destination WHERE destination.status = ?1)
         WHERE id = ?3 AND workflow_revision = ?4",
        params![status, now, id, expected_revision],
    ).map_err(db_error)?;
    if changed == 0 {
        return Err("Card changed; reload before trying again".to_string());
    }
    transaction.execute("INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, from_status, to_status) VALUES (?1, ?2, ?3, 'status_transition', 'success', ?4, ?5)",
        params![id, now, if actor == "agent" { "agent" } else { "user" }, current, status]).map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string())
}

fn is_legal_status_transition(current: &str, next: &str) -> bool {
    matches!(
        (current, next),
        ("needs_refinement", "refining")
            | ("needs_refinement", "ready")
            | ("refining", "needs_refinement")
            | ("refining", "needs_refinement_input")
            | ("needs_refinement_input", "refining")
            | ("needs_refinement_input", "needs_refinement")
            | ("ready", "needs_refinement")
            | ("ready", "agent_working")
            | ("agent_working", "needs_human")
            | ("needs_human", "agent_working")
            | ("needs_human", "approved")
            | ("approved", "needs_human")
    )
}

#[tauri::command]
pub fn kanban_close_card(id: String, expected_revision: i64) -> Result<CardSnapshot, String> {
    with_connection(|connection| {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let (status, revision, finalized): (String, i64, bool) = transaction
            .query_row(
                "SELECT status, workflow_revision, hierarchy_finalized FROM kanban_cards WHERE id=?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? != 0)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Kanban card was not found".to_string())?;
        if finalized {
            return Err("A finalized aggregate parent has no workflow".to_string());
        }
        if revision != expected_revision {
            return Err("Card changed; reload before closing".to_string());
        }
        if status == "done" {
            return Err("The card is already Done".to_string());
        }
        let now = unix_timestamp();
        transaction.execute(
            "UPDATE kanban_cards SET status='done', completion_outcome='closed', delivery_operation_stage=NULL, delivery_error=NULL,
             workflow_revision=workflow_revision+1, updated_at=?1,
             sort_order=(SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards AS destination WHERE destination.status='done')
             WHERE id=?2 AND workflow_revision=?3", params![now, id, expected_revision],
        ).map_err(db_error)?;
        transaction.execute(
            "INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, from_status, to_status, summary)
             VALUES (?1, ?2, 'user', 'close', 'success', ?3, 'done', 'Closed without delivery; work preserved')",
            params![id, now, status],
        ).map_err(db_error)?;
        transaction.commit().map_err(db_error)
    })?;
    fresh_card_snapshot(&id)
}

#[tauri::command]
pub fn kanban_reorder_cards(
    status: String,
    expected_card_ids: Vec<String>,
    card_ids: Vec<String>,
) -> Result<BoardChange, String> {
    if !STATUSES.contains(&status.as_str()) {
        return Err(format!("Unknown Kanban status: {status}"));
    }
    with_connection(|connection| {
        reorder_cards(connection, &status, &expected_card_ids, &card_ids).map(|_| ())
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

fn reorder_cards(
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

fn reject_duplicate_ids(field: &str, ids: &[String]) -> Result<(), String> {
    let mut unique = HashSet::new();
    if let Some(duplicate) = ids.iter().find(|id| !unique.insert(id.as_str())) {
        return Err(format!(
            "Reorder {field} contains duplicate card ID: {duplicate}"
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn kanban_set_project(id: String, project_id: String) -> Result<CardSnapshot, String> {
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

fn set_card_project(
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
    if !REFINEMENT_STATUSES.contains(&status.as_str()) {
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
        crate::store::migrate_store_schema(connection)?;
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

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command fields stay explicit for frontend serialization.
pub fn kanban_create_environment(
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

#[tauri::command]
pub fn kanban_save_environment_layout(
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

fn save_environment_layout(
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

#[tauri::command]
pub fn kanban_set_merge_target(
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

#[tauri::command]
pub async fn kanban_approve_and_commit(
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

fn approve_and_commit_with_failure_record(
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

fn approve_and_commit(
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

#[tauri::command]
pub async fn kanban_cleanup_environment(
    id: String,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = REPOSITORY_OPERATION_LOCK.get_or_init(|| Mutex::new(())).lock().map_err(|_| "Repository operation lock failed".to_string())?;
        let result = with_connection(|connection| {
            validate_card_environment_project(connection, &id)?;
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
            let (status, completion_outcome, card_revision, delivery_stage): (String, Option<String>, i64, Option<String>) = transaction.query_row("SELECT status, completion_outcome, workflow_revision, delivery_operation_stage FROM kanban_cards WHERE id=?1", [&id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).map_err(db_error)?;
            if status != "done" { return Err("Only a Done card environment can be cleaned up".to_string()); }
            if card_revision != expected_workflow_revision { return Err("Card changed; reload before cleanup".to_string()); }
            let (source_path, source_branch, repository_id, target_path, target_branch, recorded_tip, environment_revision): (String, String, String, String, String, String, i64) = transaction.query_row(
                "SELECT worktree_path, branch, repository_id, target_checkout_path, target_branch, source_revision, revision FROM card_environments WHERE card_id=?1", [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
            ).map_err(db_error)?;
            if environment_revision != expected_environment_revision { return Err("Card environment changed; reload before cleanup".to_string()); }
            if delivery_stage.as_deref() == Some("deleting_remote_branch") {
                let remote_ref = format!("refs/heads/{source_branch}");
                let remote = git_output(&target_path, &["ls-remote", "--heads", "origin", &remote_ref])?;
                if !remote.is_empty() {
                    let deleted = Command::new("git").args(["-C", &target_path, "push", "origin", "--delete", &source_branch]).output().map_err(|error| error.to_string())?;
                    if !deleted.status.success() { return Err(format!("PR is merged, but remote branch deletion still failed: {}", String::from_utf8_lossy(&deleted.stderr).trim())); }
                }
                transaction.execute("UPDATE kanban_cards SET delivery_operation_stage=NULL, delivery_error=NULL WHERE id=?1", [&id]).map_err(db_error)?;
            }
            let source = validate_checkout(&source_path, Some(&repository_id))?;
            let target = validate_checkout(&target_path, Some(&repository_id))?;
            if source.target_branch != source_branch || target.target_branch != target_branch { return Err("Source or target checkout changed branches before cleanup".to_string()); }
            let current_tip = git_output(&source_path, &["rev-parse", "HEAD"])?;
            if completion_outcome.as_deref() == Some("merged") && current_tip != recorded_tip { return Err("The source branch has new commits since merge; merge again before cleanup".to_string()); }
            let rewritten_pr_evidence = transaction.query_row(
                "SELECT COUNT(*) FROM card_pull_requests pr
                 WHERE pr.card_id=?1 AND pr.state='merged' AND pr.head_revision=?2",
                params![id, current_tip], |row| row.get::<_, i64>(0),
            ).unwrap_or(0) > 0;
            if completion_outcome.as_deref() == Some("merged") && !rewritten_pr_evidence && !Command::new("git").args(["-C", &target_path, "merge-base", "--is-ancestor", &current_tip, "HEAD"]).status().map_err(|error| error.to_string())?.success() {
                return Err("The source tip is no longer reachable from the recorded target and no verified squash/rebase PR evidence exists".to_string());
            }
            ensure_registered_distinct_worktree(&target_path, &source_path)?;
            let removed = Command::new("git").args(["-C", &target_path, "worktree", "remove", "--", &source_path]).output().map_err(|error| error.to_string())?;
            if !removed.status.success() { return Err(format!("Git could not remove the source worktree: {}", String::from_utf8_lossy(&removed.stderr).trim())); }
            if completion_outcome.as_deref() == Some("merged") {
                let delete_flag = if rewritten_pr_evidence { "-D" } else { "-d" };
                let deleted = Command::new("git").args(["-C", &target_path, "branch", delete_flag, "--", &source_branch]).output().map_err(|error| error.to_string())?;
                if !deleted.status.success() { return Err(format!("Worktree was removed, but Git safely retained the source branch: {}", String::from_utf8_lossy(&deleted.stderr).trim())); }
            }
            transaction.execute("DELETE FROM card_environments WHERE card_id=?1 AND revision=?2", params![id, expected_environment_revision]).map_err(db_error)?;
            transaction.execute("UPDATE kanban_cards SET workflow_revision=workflow_revision+1, updated_at=?1 WHERE id=?2 AND workflow_revision=?3", params![unix_timestamp(), id, expected_workflow_revision]).map_err(db_error)?;
            transaction.execute("INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, summary) VALUES (?1, ?2, 'user', 'cleanup', 'success', ?3)", params![id, unix_timestamp(), if completion_outcome.as_deref() == Some("closed") { "Removed source worktree and retained branch" } else { "Removed source worktree and branch" }]).map_err(db_error)?;
            transaction.commit().map_err(db_error)?;
            get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
        });
        if let Err(detail) = &result { record_operation_failure(&id, "cleanup", "cleanup_failed", detail); }
        result
    }).await.map_err(|error| format!("Cleanup worker failed: {error}"))?
}

fn feature_environment_title(title: &str) -> String {
    let mut title = title.trim();
    while let Some(rest) = title.strip_prefix("[FE]") {
        title = rest.trim_start();
    }
    format!("[FE] {title}")
}

#[derive(Deserialize)]
struct PrMetadata {
    title: String,
    body: String,
}

#[derive(Debug)]
struct ProjectDeliverySettings {
    path: String,
    workflow: String,
    target_branch: String,
    merge_strategy: String,
}

fn project_delivery_settings(
    connection: &Connection,
    card_id: &str,
) -> Result<ProjectDeliverySettings, String> {
    connection.query_row(
        "SELECT p.path, p.delivery_workflow, p.target_branch, p.github_merge_strategy, p.require_passing_ci, p.require_approval
         FROM kanban_cards c JOIN projects p ON p.id=c.project_id WHERE c.id=?1", [card_id], |row| Ok(ProjectDeliverySettings {
            path: row.get(0)?, workflow: row.get(1)?, target_branch: row.get(2)?, merge_strategy: row.get(3)?,
        }),
    ).map_err(|error| match error { rusqlite::Error::QueryReturnedNoRows => "The card's project was not found".to_string(), other => db_error(other) })
}

fn refresh_pull_request(
    connection: &mut Connection,
    id: &str,
) -> Result<Option<CardPullRequest>, String> {
    let settings = project_delivery_settings(connection, id)?;
    if settings.workflow != "github_pull_request" {
        return Ok(None);
    }
    let (branch, feature_environment, source_revision): (String, bool, Option<String>) = connection.query_row(
        "SELECT e.branch, c.feature_environment, e.source_revision FROM kanban_cards c JOIN card_environments e ON e.card_id=c.id WHERE c.id=?1",
        [id], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0, row.get(2)?)),
    ).map_err(db_error)?;
    let repository = crate::github::repository_name(&settings.path)?;
    let output = crate::github::run_gh(Some(Path::new(&settings.path)), &[
        "pr", "list", "--repo", &repository, "--state", "all", "--head", &branch, "--limit", "20",
        "--json", "number,title,url,isDraft,state,mergedAt,statusCheckRollup,mergeable,mergeStateStatus,reviews,headRefOid,baseRefName",
    ])?;
    let values: Vec<serde_json::Value> = serde_json::from_str(&output)
        .map_err(|error| format!("Invalid GitHub pull request response: {error}"))?;
    let matches_identity = |value: &&serde_json::Value| {
        value["baseRefName"].as_str() == Some(settings.target_branch.as_str())
            && value["headRefOid"]
                .as_str()
                .is_none_or(|head| source_revision.as_deref().is_none_or(|tip| head == tip))
    };
    let value = values
        .iter()
        .filter(matches_identity)
        .find(|value| value["state"].as_str() == Some("OPEN"))
        .or_else(|| {
            values
                .iter()
                .filter(matches_identity)
                .find(|value| !value["mergedAt"].is_null())
        })
        .or_else(|| values.iter().filter(matches_identity).next());
    let Some(value) = value else {
        connection
            .execute("DELETE FROM card_pull_requests WHERE card_id=?1", [id])
            .map_err(db_error)?;
        if !values.is_empty() {
            connection.execute("UPDATE kanban_cards SET delivery_error='No pull request matches the configured target branch and unchanged shipped source revision.' WHERE id=?1", [id]).map_err(db_error)?;
        }
        return Ok(None);
    };
    let number = value["number"]
        .as_u64()
        .ok_or("Pull request number is missing")?;
    let mut title = value["title"]
        .as_str()
        .unwrap_or("Untitled pull request")
        .to_string();
    if feature_environment
        && value["state"].as_str() == Some("OPEN")
        && title != feature_environment_title(&title)
    {
        title = feature_environment_title(&title);
        crate::github::run_gh(
            Some(Path::new(&settings.path)),
            &[
                "pr",
                "edit",
                &number.to_string(),
                "--repo",
                &repository,
                "--title",
                &title,
            ],
        )?;
    }
    let state = if value["mergedAt"].is_null() {
        value["state"]
            .as_str()
            .unwrap_or("CLOSED")
            .to_ascii_lowercase()
    } else {
        "merged".to_string()
    };
    let checks = value["statusCheckRollup"].as_array();
    let ci_status = match checks {
        None => "unknown",
        Some(values) if values.is_empty() => "no_ci",
        Some(values)
            if values.iter().any(|v| {
                matches!(
                    v["conclusion"].as_str().or(v["state"].as_str()),
                    Some("FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT")
                )
            }) =>
        {
            "failure"
        }
        Some(values)
            if values.iter().any(|v| {
                matches!(
                    v["status"].as_str().or(v["state"].as_str()),
                    Some("QUEUED" | "IN_PROGRESS" | "PENDING" | "EXPECTED")
                )
            }) =>
        {
            "pending"
        }
        Some(values)
            if values.iter().all(|v| {
                matches!(
                    v["conclusion"]
                        .as_str()
                        .or(v["state"].as_str())
                        .or(v["status"].as_str()),
                    Some("SUCCESS" | "COMPLETED" | "NEUTRAL" | "SKIPPED")
                )
            }) =>
        {
            "success"
        }
        Some(_) => "unknown",
    };
    let mut latest_reviews = HashMap::<String, &serde_json::Value>::new();
    for review in value["reviews"].as_array().into_iter().flatten() {
        let author = review["author"]["login"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        let replace = latest_reviews.get(&author).is_none_or(|current| {
            review["submittedAt"].as_str().unwrap_or("")
                >= current["submittedAt"].as_str().unwrap_or("")
        });
        if replace {
            latest_reviews.insert(author, review);
        }
    }
    let review_state = if latest_reviews
        .values()
        .any(|v| v["state"].as_str() == Some("CHANGES_REQUESTED"))
    {
        "changes_requested"
    } else if latest_reviews
        .values()
        .any(|v| v["state"].as_str() == Some("APPROVED"))
    {
        "approved"
    } else {
        "pending"
    };
    let has_conflicts = value["mergeable"].as_str() == Some("CONFLICTING")
        || value["mergeStateStatus"].as_str() == Some("DIRTY");
    let mergeable = value["mergeable"].as_str() == Some("MERGEABLE");
    connection.execute(
        "INSERT INTO card_pull_requests (card_id, repository, number, title, url, state, draft, ci_status, review_state, has_conflicts, mergeable, head_revision, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
         ON CONFLICT(card_id) DO UPDATE SET repository=excluded.repository, number=excluded.number, title=excluded.title, url=excluded.url,
          state=excluded.state, draft=excluded.draft, ci_status=excluded.ci_status, review_state=excluded.review_state,
          has_conflicts=excluded.has_conflicts, mergeable=excluded.mergeable, head_revision=excluded.head_revision, updated_at=excluded.updated_at",
        params![id, repository, number as i64, title, value["url"].as_str().unwrap_or_default(), state, value["isDraft"].as_bool().unwrap_or(false) as i64,
            ci_status, review_state, has_conflicts as i64, mergeable as i64, value["headRefOid"].as_str(), unix_timestamp()],
    ).map_err(db_error)?;
    if state == "open" {
        connection.execute("UPDATE kanban_cards SET delivery_error=NULL WHERE id=?1 AND delivery_operation_stage IS NULL", [id]).map_err(db_error)?;
    } else if state == "merged" {
        connection.execute("UPDATE kanban_cards SET status='done', completion_outcome='merged', delivery_operation_stage=NULL, delivery_error=NULL,
            workflow_revision=workflow_revision+CASE WHEN status='done' THEN 0 ELSE 1 END, updated_at=?1 WHERE id=?2 AND completion_outcome IS NOT 'closed'", params![unix_timestamp(), id]).map_err(db_error)?;
    } else if state == "closed" {
        connection.execute("UPDATE kanban_cards SET delivery_error='The associated pull request was closed without merging. Create or associate a replacement PR.', delivery_operation_stage=NULL WHERE id=?1", [id]).map_err(db_error)?;
    }
    let card = get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string())?;
    Ok(card.pull_request)
}

#[tauri::command]
pub async fn kanban_refresh_pull_request(id: String) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = with_connection(|connection| {
            refresh_pull_request(connection, &id)?;
            get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
        });
        if let Err(detail) = &result {
            record_operation_failure(&id, "refresh_pr", "refresh_pr_failed", detail);
        }
        result
    })
    .await
    .map_err(|error| format!("GitHub refresh worker failed: {error}"))?
}

#[tauri::command]
pub async fn kanban_create_pull_request(
    id: String,
    expected_workflow_revision: i64,
) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = REPOSITORY_OPERATION_LOCK.get_or_init(|| Mutex::new(())).lock().map_err(|_| "Repository operation lock failed".to_string())?;
        with_connection(|connection| {
            let settings = project_delivery_settings(connection, &id)?;
            if settings.workflow != "github_pull_request" { return Err("This project uses Local merge delivery".to_string()); }
            let (status, revision, title, content, feature_environment, source_path, branch, source_revision): (String, i64, String, String, bool, String, String, Option<String>) = connection.query_row(
                "SELECT c.status,c.workflow_revision,c.title,c.content,c.feature_environment,e.worktree_path,e.branch,e.source_revision FROM kanban_cards c JOIN card_environments e ON e.card_id=c.id WHERE c.id=?1",
                [&id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get::<_,i64>(4)? != 0,row.get(5)?,row.get(6)?,row.get(7)?)),
            ).map_err(db_error)?;
            if status != "approved" || revision != expected_workflow_revision { return Err("Card changed or is not Ready to merge".to_string()); }
            let source = validate_checkout(&source_path, None)?;
            if source.target_branch != branch || source_revision.as_deref() != Some(source.target_revision.as_str()) { return Err("The source branch changed after Ship It; ship it again before creating a PR".to_string()); }
            connection.execute("UPDATE kanban_cards SET delivery_operation_stage='creating_pr', delivery_error=NULL WHERE id=?1", [&id]).map_err(db_error)?;
            if refresh_pull_request(connection, &id)?.is_some_and(|pr| pr.state == "open") {
                return get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string());
            }
            let repository = crate::github::repository_name(&settings.path)?;
            let push = Command::new("git").args(["-C", &source_path, "push", "--set-upstream", "origin", &branch]).output().map_err(|error| error.to_string())?;
            if !push.status.success() { return Err(format!("Could not push the card branch: {}", String::from_utf8_lossy(&push.stderr).trim())); }
            connection.execute("UPDATE kanban_cards SET delivery_operation_stage='branch_pushed' WHERE id=?1", [&id]).map_err(db_error)?;
            let git_dir = git_output(&source_path, &["rev-parse", "--git-dir"])?;
            let metadata_path = { let path = PathBuf::from(git_dir); if path.is_absolute() { path } else { Path::new(&source_path).join(path) }.join("stacks-pr-metadata.json") };
            let metadata = fs::read_to_string(&metadata_path).ok().and_then(|text| serde_json::from_str::<PrMetadata>(&text).ok());
            let _ = fs::remove_file(metadata_path);
            let mut pr_title = metadata.as_ref().map(|m| m.title.trim().to_string()).filter(|v| !v.is_empty()).unwrap_or(title);
            if feature_environment { pr_title = feature_environment_title(&pr_title); }
            let body = metadata.map(|m| m.body).filter(|v| !v.trim().is_empty()).unwrap_or(content);
            crate::github::run_gh(Some(Path::new(&source_path)), &["pr", "create", "--repo", &repository, "--base", &settings.target_branch, "--head", &branch, "--title", &pr_title, "--body", &body])?;
            connection.execute("UPDATE kanban_cards SET delivery_operation_stage='pr_created' WHERE id=?1", [&id]).map_err(db_error)?;
            refresh_pull_request(connection, &id)?;
            connection.execute("UPDATE kanban_cards SET delivery_operation_stage=NULL WHERE id=?1", [&id]).map_err(db_error)?;
            get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
        }).map_err(|error| { record_operation_failure(&id, "create_pr", "create_pr_failed", &error); error })
    }).await.map_err(|error| format!("Create PR worker failed: {error}"))?
}

#[tauri::command]
pub async fn kanban_merge_pull_request(
    id: String,
    expected_workflow_revision: i64,
) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = REPOSITORY_OPERATION_LOCK.get_or_init(|| Mutex::new(())).lock().map_err(|_| "Repository operation lock failed".to_string())?;
        with_connection(|connection| {
            let settings = project_delivery_settings(connection, &id)?;
            if settings.workflow != "github_pull_request" { return Err("This project uses Local merge delivery".to_string()); }
            let (status, revision): (String, i64) = connection.query_row("SELECT status,workflow_revision FROM kanban_cards WHERE id=?1", [&id], |row| Ok((row.get(0)?,row.get(1)?))).map_err(db_error)?;
            if status != "approved" || revision != expected_workflow_revision { return Err("Card changed or is not Ready to merge".to_string()); }
            refresh_pull_request(connection, &id)?;
            let card = get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())?;
            let pr = card.pull_request.ok_or("No open pull request is associated with this card")?;
            if !pr.blockers.is_empty() { return Err(format!("Pull request is not ready: {}", pr.blockers.join("; "))); }
            connection.execute("UPDATE kanban_cards SET delivery_operation_stage='merging_pr', delivery_error=NULL WHERE id=?1", [&id]).map_err(db_error)?;
            let number = pr.number.to_string();
            let flag = match settings.merge_strategy.as_str() { "squash" => "--squash", "rebase" => "--rebase", _ => "--merge" };
            crate::github::run_gh(Some(Path::new(&settings.path)), &["pr", "merge", &number, "--repo", &pr.repository, flag])?;
            connection.execute("UPDATE card_pull_requests SET state='merged', updated_at=?1 WHERE card_id=?2", params![unix_timestamp(), id]).map_err(db_error)?;
            connection.execute("UPDATE kanban_cards SET status='done',completion_outcome='merged',delivery_operation_stage='deleting_remote_branch',workflow_revision=workflow_revision+1,updated_at=?1 WHERE id=?2", params![unix_timestamp(), id]).map_err(db_error)?;
            let branch: String = connection.query_row("SELECT branch FROM card_environments WHERE card_id=?1", [&id], |row| row.get(0)).map_err(db_error)?;
            let deletion = Command::new("git").args(["-C", &settings.path, "push", "origin", "--delete", &branch]).output();
            match deletion {
                Ok(output) if output.status.success() => { connection.execute("UPDATE kanban_cards SET delivery_operation_stage=NULL WHERE id=?1", [&id]).map_err(db_error)?; }
                Ok(output) => { connection.execute("UPDATE kanban_cards SET delivery_error=?1 WHERE id=?2", params![format!("PR merged, but remote branch deletion needs retry: {}", String::from_utf8_lossy(&output.stderr).trim()), id]).map_err(db_error)?; }
                Err(error) => { connection.execute("UPDATE kanban_cards SET delivery_error=?1 WHERE id=?2", params![format!("PR merged, but remote branch deletion needs retry: {error}"), id]).map_err(db_error)?; }
            }
            get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
        }).map_err(|error| { record_operation_failure(&id, "merge_pr", "merge_pr_failed", &error); error })
    }).await.map_err(|error| format!("Merge PR worker failed: {error}"))?
}

fn record_operation_failure(card_id: &str, event_type: &str, error_code: &str, detail: &str) {
    let _ = with_connection(|connection| {
        if matches!(
            event_type,
            "create_pr" | "merge_pr" | "refresh_pr" | "merge"
        ) {
            connection
                .execute(
                    "UPDATE kanban_cards SET delivery_error=?1 WHERE id=?2",
                    params![detail, card_id],
                )
                .map_err(db_error)?;
        }
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
    // Serialize the complete read/mutate/revision cycle. SQLite serializes writes,
    // but without this lock a second window could commit between a mutation and
    // its revision bookkeeping, causing one logical operation to claim another's
    // entity changes.
    let _guard = BOARD_OPERATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Kanban board operation lock failed".to_string())?;
    let path = app_data_file("workflow.sqlite3")?;
    let mut connection = Connection::open(path).map_err(db_error)?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(db_error)?;
    migrate(&connection)?;
    let before = serialized_board_entities(&mut connection)?;
    let result = work(&mut connection);
    let after = serialized_board_entities(&mut connection)?;
    if let Some(change) = commit_board_revision(&mut connection, &before, &after)? {
        if let Some(app) = APP_HANDLE.get() {
            if let Err(error) = app.emit("kanban-board-changed", &change) {
                eprintln!("Kanban mutation committed at board revision {}, but event delivery failed: {error}", change.board_revision);
            }
        }
    }
    result
}

fn serialized_board_entities(
    connection: &mut Connection,
) -> Result<HashMap<String, String>, String> {
    let mut cards = list_cards(connection)?;
    cards
        .iter_mut()
        .map(|card| {
            // A revision is metadata about freshness, not part of the serialized
            // entity change being detected.
            card.record_revision = 0;
            serde_json::to_string(card)
                .map(|serialized| (card.id.clone(), serialized))
                .map_err(|error| error.to_string())
        })
        .collect()
}

fn board_revision(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT board_revision FROM kanban_board_metadata WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(db_error)
}

fn board_snapshot(connection: &mut Connection) -> Result<BoardSnapshot, String> {
    Ok(BoardSnapshot {
        cards: list_cards(connection)?,
        board_revision: board_revision(connection)?,
    })
}

fn fresh_card_snapshot(id: &str) -> Result<CardSnapshot, String> {
    with_connection(|connection| {
        let card =
            get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string())?;
        Ok(CardSnapshot {
            card,
            board_revision: board_revision(connection)?,
        })
    })
}

fn commit_board_revision(
    connection: &mut Connection,
    before: &HashMap<String, String>,
    after: &HashMap<String, String>,
) -> Result<Option<BoardChange>, String> {
    let mut changed_ids = after
        .iter()
        .filter(|(id, value)| before.get(*id) != Some(*value))
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    let mut removed_ids = before
        .keys()
        .filter(|id| !after.contains_key(*id))
        .cloned()
        .collect::<Vec<_>>();
    changed_ids.sort();
    removed_ids.sort();
    if changed_ids.is_empty() && removed_ids.is_empty() {
        return Ok(None);
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    transaction
        .execute(
            "UPDATE kanban_board_metadata SET board_revision=board_revision+1 WHERE singleton=1",
            [],
        )
        .map_err(db_error)?;
    for id in &changed_ids {
        transaction
            .execute(
                "UPDATE kanban_cards SET record_revision=record_revision+1 WHERE id=?1",
                [id],
            )
            .map_err(db_error)?;
    }
    let revision: i64 = transaction
        .query_row(
            "SELECT board_revision FROM kanban_board_metadata WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    let mut upserts = Vec::with_capacity(changed_ids.len());
    for id in changed_ids {
        if let Some(card) = get_card(connection, &id)? {
            upserts.push(card);
        }
    }
    Ok(Some(BoardChange {
        upserts,
        removed_ids,
        board_revision: revision,
    }))
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
                CHECK(status IN ('needs_refinement', 'refining', 'needs_refinement_input', 'ready', 'agent_working', 'needs_human', 'approved', 'done')),
            completion_outcome TEXT CHECK(completion_outcome IN ('merged', 'closed')),
            feature_environment INTEGER NOT NULL DEFAULT 0,
            delivery_operation_stage TEXT,
            delivery_error TEXT,
            workflow_revision INTEGER NOT NULL DEFAULT 1,
            record_revision INTEGER NOT NULL DEFAULT 1,
            project_id TEXT,
            workspace_id TEXT,
            parent_id TEXT,
            hierarchy_finalized INTEGER NOT NULL DEFAULT 0,
            provider_child_count INTEGER NOT NULL DEFAULT 0,
            provider_parent_title TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            in_scope INTEGER NOT NULL DEFAULT 1,
            UNIQUE(external_provider, external_id)
         );
         CREATE INDEX IF NOT EXISTS kanban_cards_status_idx ON kanban_cards(status, updated_at);
         CREATE TABLE IF NOT EXISTS kanban_board_metadata (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            board_revision INTEGER NOT NULL DEFAULT 0
         );
         INSERT OR IGNORE INTO kanban_board_metadata(singleton, board_revision) VALUES (1, 0);
         CREATE TABLE IF NOT EXISTS card_pull_requests (
            card_id TEXT PRIMARY KEY REFERENCES kanban_cards(id) ON DELETE CASCADE,
            repository TEXT NOT NULL,
            number INTEGER NOT NULL,
            title TEXT NOT NULL,
            url TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('open', 'closed', 'merged')),
            draft INTEGER NOT NULL DEFAULT 0,
            ci_status TEXT NOT NULL DEFAULT 'unknown',
            review_state TEXT NOT NULL DEFAULT 'unknown',
            has_conflicts INTEGER NOT NULL DEFAULT 0,
            mergeable INTEGER NOT NULL DEFAULT 0,
            head_revision TEXT,
            updated_at INTEGER NOT NULL,
            UNIQUE(repository, number)
         );
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
            layout_revision INTEGER NOT NULL DEFAULT 1,
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
    migrate_done_status(connection)?;
    migrate_refinement_statuses(connection)?;
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
    if !columns.iter().any(|column| column == "record_revision") {
        connection
            .execute(
                "ALTER TABLE kanban_cards ADD COLUMN record_revision INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .map_err(db_error)?;
    }
    for (name, sql) in [
        (
            "parent_id",
            "ALTER TABLE kanban_cards ADD COLUMN parent_id TEXT",
        ),
        (
            "hierarchy_finalized",
            "ALTER TABLE kanban_cards ADD COLUMN hierarchy_finalized INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "provider_child_count",
            "ALTER TABLE kanban_cards ADD COLUMN provider_child_count INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "provider_parent_title",
            "ALTER TABLE kanban_cards ADD COLUMN provider_parent_title TEXT",
        ),
    ] {
        if !columns.iter().any(|column| column == name) {
            connection.execute(sql, []).map_err(db_error)?;
        }
    }
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS kanban_cards_parent_idx ON kanban_cards(parent_id);
         INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (51, unixepoch());",
        )
        .map_err(db_error)?;
    let environment_columns = connection
        .prepare("PRAGMA table_info(card_environments)")
        .map_err(db_error)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let layout_columns = connection
        .prepare("PRAGMA table_info(card_layouts)")
        .map_err(db_error)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    if !layout_columns
        .iter()
        .any(|column| column == "layout_revision")
    {
        connection
            .execute(
                "ALTER TABLE card_layouts ADD COLUMN layout_revision INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .map_err(db_error)?;
    }
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (52, unixepoch())",
            [],
        )
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

fn migrate_done_status(connection: &Connection) -> Result<(), String> {
    let sql: String = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='kanban_cards'",
            [],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if sql.contains("'done'") {
        return Ok(());
    }
    connection.execute_batch(
        "PRAGMA foreign_keys=OFF;
         PRAGMA legacy_alter_table=ON;
         BEGIN IMMEDIATE;
         ALTER TABLE kanban_cards RENAME TO kanban_cards_legacy_delivery;
         CREATE TABLE kanban_cards (
            id TEXT PRIMARY KEY, external_provider TEXT NOT NULL, external_id TEXT NOT NULL,
            title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', board_id TEXT NOT NULL DEFAULT '',
            board_title TEXT NOT NULL DEFAULT '', list_id TEXT NOT NULL DEFAULT '', list_title TEXT NOT NULL DEFAULT '',
            card_url TEXT NOT NULL DEFAULT '', assignee_names TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'needs_refinement' CHECK(status IN ('needs_refinement','refining','needs_refinement_input','ready','agent_working','needs_human','approved','done')),
            completion_outcome TEXT CHECK(completion_outcome IN ('merged','closed')),
            feature_environment INTEGER NOT NULL DEFAULT 0, delivery_operation_stage TEXT, delivery_error TEXT,
            workflow_revision INTEGER NOT NULL DEFAULT 1, project_id TEXT, workspace_id TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
            in_scope INTEGER NOT NULL DEFAULT 1, UNIQUE(external_provider, external_id)
         );
         INSERT INTO kanban_cards (id, external_provider, external_id, title, content, board_id, board_title, list_id, list_title,
            card_url, assignee_names, status, completion_outcome, workflow_revision, project_id, workspace_id, created_at, updated_at, sort_order, in_scope)
         SELECT id, external_provider, external_id, title, content, board_id, board_title, list_id, list_title,
            card_url, assignee_names, CASE status WHEN 'merged' THEN 'done' ELSE status END,
            CASE status WHEN 'merged' THEN 'merged' ELSE NULL END, workflow_revision, project_id, workspace_id, created_at, updated_at, sort_order, in_scope
         FROM kanban_cards_legacy_delivery;
         DROP TABLE kanban_cards_legacy_delivery;
         CREATE INDEX IF NOT EXISTS kanban_cards_status_idx ON kanban_cards(status, updated_at);
         COMMIT;
         PRAGMA legacy_alter_table=OFF;
         PRAGMA foreign_keys=ON;"
    ).map_err(db_error)
}

fn migrate_refinement_statuses(connection: &Connection) -> Result<(), String> {
    let sql: String = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='kanban_cards'",
            [],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if sql.contains("'needs_refinement_input'") {
        connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, unixepoch())",
            [],
        ).map_err(db_error)?;
        return Ok(());
    }
    connection.execute_batch(
        "PRAGMA foreign_keys=OFF;
         PRAGMA legacy_alter_table=ON;
         BEGIN IMMEDIATE;
         ALTER TABLE kanban_cards RENAME TO kanban_cards_legacy_refinement;
         CREATE TABLE kanban_cards (
            id TEXT PRIMARY KEY, external_provider TEXT NOT NULL, external_id TEXT NOT NULL,
            title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', board_id TEXT NOT NULL DEFAULT '',
            board_title TEXT NOT NULL DEFAULT '', list_id TEXT NOT NULL DEFAULT '', list_title TEXT NOT NULL DEFAULT '',
            card_url TEXT NOT NULL DEFAULT '', assignee_names TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'needs_refinement' CHECK(status IN ('needs_refinement','refining','needs_refinement_input','ready','agent_working','needs_human','approved','done')),
            completion_outcome TEXT CHECK(completion_outcome IN ('merged','closed')),
            feature_environment INTEGER NOT NULL DEFAULT 0, delivery_operation_stage TEXT, delivery_error TEXT,
            workflow_revision INTEGER NOT NULL DEFAULT 1, project_id TEXT, workspace_id TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
            in_scope INTEGER NOT NULL DEFAULT 1, UNIQUE(external_provider, external_id)
         );
         INSERT INTO kanban_cards (id, external_provider, external_id, title, content, board_id, board_title, list_id, list_title,
            card_url, assignee_names, status, completion_outcome, feature_environment, delivery_operation_stage, delivery_error,
            workflow_revision, project_id, workspace_id, created_at, updated_at, sort_order, in_scope)
         SELECT id, external_provider, external_id, title, content, board_id, board_title, list_id, list_title,
            card_url, assignee_names, status, completion_outcome, feature_environment, delivery_operation_stage, delivery_error,
            workflow_revision, project_id, workspace_id, created_at, updated_at, sort_order, in_scope
         FROM kanban_cards_legacy_refinement;
         DROP TABLE kanban_cards_legacy_refinement;
         CREATE INDEX IF NOT EXISTS kanban_cards_status_idx ON kanban_cards(status, updated_at);
         INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, unixepoch());
         COMMIT;
         PRAGMA legacy_alter_table=OFF;
         PRAGMA foreign_keys=ON;"
    ).map_err(db_error)?;
    let foreign_key_errors: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .map_err(db_error)?;
    if foreign_key_errors > 0 {
        return Err("Kanban database migration left invalid foreign-key relationships".to_string());
    }
    Ok(())
}

fn list_cards(connection: &mut Connection) -> Result<Vec<KanbanCard>, String> {
    let mut cards = {
        let mut statement = connection.prepare(
            "SELECT id, external_provider, external_id, title, content, board_id, board_title, list_id, list_title,
                    card_url, assignee_names, status, completion_outcome, feature_environment, delivery_operation_stage, delivery_error,
                    workflow_revision, record_revision, project_id, created_at, updated_at, sort_order, in_scope,
                    parent_id, hierarchy_finalized, provider_child_count, provider_parent_title
             FROM kanban_cards WHERE in_scope = 1 ORDER BY sort_order ASC, created_at ASC, id ASC"
        ).map_err(db_error)?;
        let mapped = statement.query_map([], map_card).map_err(db_error)?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    for card in &mut cards {
        card.environment = load_environment(connection, &card.id)?;
        card.pull_request = load_pull_request(connection, card)?;
        card.events = load_events(connection, &card.id)?;
    }
    enrich_relationships(connection, &mut cards)?;
    Ok(cards)
}

fn get_card(connection: &Connection, id: &str) -> Result<Option<KanbanCard>, String> {
    let mut card = connection.query_row(
        "SELECT id, external_provider, external_id, title, content, board_id, board_title, list_id, list_title,
                card_url, assignee_names, status, completion_outcome, feature_environment, delivery_operation_stage, delivery_error,
                workflow_revision, record_revision, project_id, created_at, updated_at, sort_order, in_scope,
                parent_id, hierarchy_finalized, provider_child_count, provider_parent_title
         FROM kanban_cards WHERE id = ?1",
        [id],
        map_card,
    ).optional().map_err(db_error)?;
    if let Some(card) = &mut card {
        card.environment = load_environment(connection, id)?;
        card.pull_request = load_pull_request(connection, card)?;
        card.events = load_events(connection, id)?;
        let mut cards = vec![card.clone()];
        enrich_relationships(connection, &mut cards)?;
        *card = cards.remove(0);
    }
    Ok(card)
}

fn relationship_summary(
    connection: &Connection,
    id: &str,
) -> Result<Option<CardRelationshipSummary>, String> {
    connection
        .query_row(
            "SELECT id, external_id, title, status FROM kanban_cards WHERE id=?1",
            [id],
            |row| {
                Ok(CardRelationshipSummary {
                    id: row.get(0)?,
                    external_id: row.get(1)?,
                    title: row.get(2)?,
                    status: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(db_error)
}

fn earliest_workflow_status<'a>(statuses: impl IntoIterator<Item = &'a str>) -> Option<String> {
    statuses
        .into_iter()
        .min_by_key(|status| {
            STATUSES
                .iter()
                .position(|candidate| candidate == status)
                .unwrap_or(STATUSES.len())
        })
        .map(str::to_string)
}

fn effective_card_status(
    connection: &Connection,
    id: &str,
    stored_status: &str,
    hierarchy_finalized: bool,
) -> Result<String, String> {
    if !hierarchy_finalized {
        return Ok(stored_status.to_string());
    }
    let mut statement = connection
        .prepare("SELECT status FROM kanban_cards WHERE parent_id=?1 AND in_scope=1")
        .map_err(db_error)?;
    let child_statuses = statement
        .query_map([id], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(
        earliest_workflow_status(child_statuses.iter().map(String::as_str))
            .unwrap_or_else(|| stored_status.to_string()),
    )
}

fn enrich_relationships(connection: &Connection, cards: &mut [KanbanCard]) -> Result<(), String> {
    for card in cards {
        if let Some(parent) = &card.parent {
            if let Some(summary) = relationship_summary(connection, &parent.id)? {
                card.parent = Some(summary);
            }
        }
        let mut statement = connection.prepare(
            "SELECT id, external_id, title, status FROM kanban_cards WHERE parent_id=?1 AND in_scope=1 ORDER BY created_at, CAST(external_id AS INTEGER), id"
        ).map_err(db_error)?;
        card.children = statement
            .query_map([&card.id], |row| {
                Ok(CardRelationshipSummary {
                    id: row.get(0)?,
                    external_id: row.get(1)?,
                    title: row.get(2)?,
                    status: row.get(3)?,
                })
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        card.child_count = card.child_count.max(card.children.len() as u64);
        if card.hierarchy_finalized {
            card.status =
                earliest_workflow_status(card.children.iter().map(|child| child.status.as_str()))
                    .unwrap_or_else(|| card.status.clone());
        }
    }
    Ok(())
}

fn load_pull_request(
    connection: &Connection,
    card: &KanbanCard,
) -> Result<Option<CardPullRequest>, String> {
    let Some(mut pull_request) = connection.query_row(
        "SELECT repository, number, title, url, state, draft, ci_status, review_state, has_conflicts, mergeable
         FROM card_pull_requests WHERE card_id=?1", [&card.id], |row| Ok(CardPullRequest {
            repository: row.get(0)?, number: row.get::<_, i64>(1)? as u64, title: row.get(2)?, url: row.get(3)?,
            state: row.get(4)?, draft: row.get::<_, i64>(5)? != 0, ci_status: row.get(6)?, review_state: row.get(7)?,
            has_conflicts: row.get::<_, i64>(8)? != 0, mergeable: row.get::<_, i64>(9)? != 0, blockers: Vec::new(),
        })
    ).optional().map_err(db_error)? else { return Ok(None); };
    let policies = card
        .project_id
        .as_deref()
        .and_then(|project_id| {
            connection
                .query_row(
                    "SELECT require_passing_ci, require_approval FROM projects WHERE id=?1",
                    [project_id],
                    |row| Ok((row.get::<_, i64>(0)? != 0, row.get::<_, i64>(1)? != 0)),
                )
                .optional()
                .ok()
                .flatten()
        })
        .unwrap_or((true, false));
    if pull_request.state != "open" {
        pull_request.blockers.push(
            if pull_request.state == "merged" {
                "Pull request is already merged"
            } else {
                "Pull request was closed without merging"
            }
            .to_string(),
        );
    }
    if pull_request.draft {
        pull_request
            .blockers
            .push("Pull request is a draft".to_string());
    }
    if pull_request.has_conflicts {
        pull_request
            .blockers
            .push("Pull request has merge conflicts".to_string());
    }
    if !pull_request.mergeable {
        pull_request
            .blockers
            .push("GitHub merge readiness is unknown or blocked".to_string());
    }
    if policies.0 && pull_request.ci_status != "success" {
        pull_request.blockers.push(
            match pull_request.ci_status.as_str() {
                "pending" => "CI is pending",
                "failure" => "CI is failing",
                "no_ci" => "Required CI is missing",
                _ => "CI state is unknown",
            }
            .to_string(),
        );
    }
    if pull_request.review_state == "changes_requested" {
        pull_request
            .blockers
            .push("A reviewer requested changes".to_string());
    }
    if policies.1 && pull_request.review_state != "approved" {
        pull_request
            .blockers
            .push("A current approval is required".to_string());
    }
    Ok(Some(pull_request))
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
    let (split_layout, focused_pane_id, layout_revision) = connection
        .query_row(
            "SELECT split_layout, focused_pane_id, layout_revision FROM card_layouts WHERE environment_id = ?1",
            [&id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)?)),
        )
        .optional()
        .map_err(db_error)?
        .map(|(layout, focused, layout_revision)| {
            (
                serde_json::from_str(&layout).unwrap_or(serde_json::json!({"kind":"empty"})),
                focused,
                layout_revision,
            )
        })
        .unwrap_or((serde_json::json!({"kind":"empty"}), None, 1));
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
        layout_revision,
        split_layout,
        focused_pane_id,
        panes,
    }))
}

fn map_card(row: &rusqlite::Row<'_>) -> rusqlite::Result<KanbanCard> {
    let parent_id = row.get::<_, Option<String>>(23)?;
    let provider_parent_title = row.get::<_, Option<String>>(26)?;
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
        completion_outcome: row.get(12)?,
        feature_environment: row.get::<_, i64>(13)? != 0,
        pull_request: None,
        delivery_operation_stage: row.get(14)?,
        delivery_error: row.get(15)?,
        workflow_revision: row.get(16)?,
        record_revision: row.get(17)?,
        project_id: row.get(18)?,
        environment: None,
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
        sort_order: row.get(21)?,
        in_scope: row.get(22)?,
        parent: parent_id.map(|id| CardRelationshipSummary {
            external_id: id.strip_prefix("superthread:").unwrap_or(&id).to_string(),
            id,
            title: provider_parent_title.unwrap_or_default(),
            status: String::new(),
        }),
        hierarchy_finalized: row.get::<_, i64>(24)? != 0,
        child_count: row.get::<_, i64>(25)? as u64,
        children: Vec::new(),
        events: Vec::new(),
    })
}

fn validate_card_environment_project(connection: &Connection, card_id: &str) -> Result<(), String> {
    crate::store::migrate_store_schema(connection)?;
    let (card_project, environment_project, repository_id, provider): (String, String, Option<String>, String) = connection.query_row(
        "SELECT c.project_id, e.project_id, e.repository_id, c.external_provider FROM kanban_cards c JOIN card_environments e ON e.card_id=c.id WHERE c.id=?1",
        [card_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional().map_err(db_error)?.ok_or_else(|| "The card environment or project ownership is missing".to_string())?;
    if card_project != environment_project {
        return Err("The card/environment project mismatch blocks this operation".to_string());
    }
    let (project_path, source): (String, String) = connection
        .query_row(
            "SELECT path, COALESCE(kanban_source, 'local') FROM projects WHERE id=?1",
            [&card_project],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "The card's owning project no longer exists".to_string())?;
    if (provider == "superthread") != (source == "superthread") {
        return Err("The card's owning project is not compatible with its provider".to_string());
    }
    if let Some(expected) = repository_id.filter(|value| !value.trim().is_empty()) {
        if repository_identity(&project_path)? != expected {
            return Err(
                "The owning project's configured checkout belongs to a different Git repository"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn health_issue(code: &str, message: impl Into<String>, step: &str) -> EnvironmentHealthIssue {
    EnvironmentHealthIssue {
        code: code.to_string(),
        message: message.into(),
        step: step.to_string(),
    }
}

fn environment_health(
    connection: &Connection,
    card_id: &str,
) -> Result<CardEnvironmentHealth, String> {
    let card = get_card(connection, card_id)?
        .ok_or_else(|| format!("Kanban card {card_id} was not found"))?;
    let mut issues = Vec::new();
    let required_step = match card.status.as_str() {
        "agent_working" => Some("work"),
        "needs_human" => Some("approval"),
        "approved" => Some("merge"),
        _ => None,
    };
    let Some(environment) = card.environment else {
        if let Some(step) = required_step {
            issues.push(health_issue(
                "environment_missing",
                format!("This card needs a usable environment before {step}."),
                step,
            ));
        }
        return Ok(CardEnvironmentHealth {
            card_id: card.id,
            issues,
        });
    };

    let source_step = match card.status.as_str() {
        "needs_human" => "approval",
        "approved" => "merge",
        "done" => "cleanup",
        _ => "work",
    };
    let target_step = if card.status == "done" {
        "cleanup"
    } else {
        "merge"
    };
    if environment.lifecycle_state != "ready" {
        issues.push(health_issue(
            "environment_not_ready",
            "The recorded environment is not ready for workflow operations.",
            source_step,
        ));
    }
    let card_project_id = card.project_id.as_deref().unwrap_or_default();
    if environment.project_id.trim().is_empty() {
        issues.push(health_issue(
            "project_metadata_missing",
            "The environment has no recorded project.",
            source_step,
        ));
    } else if environment.project_id != card_project_id {
        issues.push(health_issue(
            "environment_project_mismatch",
            "The card and its environment belong to different projects. Project-dependent operations are blocked.",
            source_step,
        ));
    }
    crate::store::migrate_store_schema(connection)?;
    let project_path: Option<String> = connection
        .query_row(
            "SELECT path FROM projects WHERE id=?1",
            [card_project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    if project_path.is_none() {
        issues.push(health_issue(
            "card_project_missing",
            "The card's owning project no longer exists.",
            source_step,
        ));
    }
    if environment.branch.trim().is_empty() {
        issues.push(health_issue(
            "source_branch_missing",
            "The source branch metadata is missing.",
            source_step,
        ));
    }
    let repository_id = environment
        .repository_id
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    if repository_id.is_none() {
        issues.push(health_issue(
            "repository_metadata_missing",
            "The environment has no recorded repository. Set the merge target again.",
            if card.status == "agent_working" || card.status == "needs_human" {
                "approval"
            } else {
                target_step
            },
        ));
    }
    let target_path = environment
        .target_checkout_path
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    if target_path.is_none() {
        issues.push(health_issue(
            "target_checkout_missing",
            "The target checkout metadata is missing. Set the merge target before continuing.",
            target_step,
        ));
    }
    let target_branch = environment
        .target_branch
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    if target_branch.is_none() {
        issues.push(health_issue(
            "target_branch_missing",
            "The target branch metadata is missing. Set the merge target before continuing.",
            target_step,
        ));
    } else if target_branch == Some(environment.branch.as_str()) {
        issues.push(health_issue(
            "source_target_branch_same",
            "The source and target branches are not distinct.",
            target_step,
        ));
    }
    if card.status == "done"
        && card.completion_outcome.as_deref() == Some("merged")
        && environment
            .source_revision
            .as_deref()
            .is_none_or(str::is_empty)
    {
        issues.push(health_issue(
            "source_revision_missing",
            "The merged source revision metadata is missing.",
            "cleanup",
        ));
    }

    if let (Some(project_path), Some(expected_repository)) =
        (project_path.as_deref(), repository_id)
    {
        match repository_identity(project_path) {
            Ok(actual) if actual != expected_repository => issues.push(health_issue(
                "project_repository_mismatch",
                "The owning project's configured checkout belongs to a different repository.",
                source_step,
            )),
            Err(_) => issues.push(health_issue(
                "project_checkout_unavailable",
                "Stacks could not identify the owning project's configured repository.",
                source_step,
            )),
            _ => {}
        }
    }

    let source_path = environment.worktree_path.as_str();
    let source_canonical = match Path::new(source_path).canonicalize() {
        Ok(path) => Some(path),
        Err(_) => {
            issues.push(health_issue(
                "source_checkout_unavailable",
                format!("The source checkout is missing or inaccessible at {source_path}."),
                source_step,
            ));
            None
        }
    };
    let mut source_tip = None;
    if let Some(source) = source_canonical.as_ref().and_then(|path| path.to_str()) {
        match repository_identity(source) {
            Ok(actual) if repository_id.is_some_and(|expected| expected != actual) => {
                issues.push(health_issue(
                    "source_repository_mismatch",
                    "The source checkout belongs to a different repository.",
                    source_step,
                ))
            }
            Err(_) => issues.push(health_issue(
                "source_repository_unavailable",
                "Stacks could not identify the source repository.",
                source_step,
            )),
            _ => {}
        }
        match git_output(source, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
            Ok(branch) if !environment.branch.is_empty() && branch != environment.branch => issues
                .push(health_issue(
                    "source_branch_mismatch",
                    format!(
                        "The source checkout is on {branch}, expected {}.",
                        environment.branch
                    ),
                    source_step,
                )),
            Err(_) => issues.push(health_issue(
                "source_checkout_detached",
                "The source checkout is detached; a named branch is required.",
                source_step,
            )),
            _ => {}
        }
        match has_git_operation(source) {
            Ok(true) => issues.push(health_issue(
                "source_git_operation_in_progress",
                "The source checkout has an in-progress Git operation.",
                source_step,
            )),
            Err(_) => issues.push(health_issue(
                "source_git_state_unavailable",
                "Stacks could not determine whether the source checkout has an in-progress Git operation.",
                source_step,
            )),
            _ => {}
        }
        match git_output(source, &["rev-parse", "HEAD"]) {
            Ok(revision) => source_tip = Some(revision),
            Err(_) => issues.push(health_issue(
                "source_revision_unavailable",
                "Stacks could not read the source checkout revision.",
                source_step,
            )),
        }
    }

    let target_canonical = if let Some(target_path) = target_path {
        match Path::new(target_path).canonicalize() {
            Ok(path) => Some(path),
            Err(_) => {
                issues.push(health_issue(
                    "target_checkout_unavailable",
                    format!("The target checkout is missing or inaccessible at {target_path}."),
                    target_step,
                ));
                None
            }
        }
    } else {
        None
    };
    if let Some(target) = target_canonical.as_ref().and_then(|path| path.to_str()) {
        match repository_identity(target) {
            Ok(actual) if repository_id.is_some_and(|expected| expected != actual) => {
                issues.push(health_issue(
                    "target_repository_mismatch",
                    "The target checkout belongs to a different repository.",
                    target_step,
                ))
            }
            Err(_) => issues.push(health_issue(
                "target_repository_unavailable",
                "Stacks could not identify the target repository.",
                target_step,
            )),
            _ => {}
        }
        match git_output(target, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
            Ok(branch) if target_branch.is_some_and(|expected| expected != branch) => {
                issues.push(health_issue(
                    "target_branch_mismatch",
                    format!(
                        "The target checkout is on {branch}, expected {}.",
                        target_branch.unwrap_or_default()
                    ),
                    target_step,
                ))
            }
            Err(_) => issues.push(health_issue(
                "target_checkout_detached",
                "The target checkout is detached; a named branch is required.",
                target_step,
            )),
            _ => {}
        }
        match has_git_operation(target) {
            Ok(true) => issues.push(health_issue(
                "target_git_operation_in_progress",
                "The target checkout has an in-progress Git operation.",
                target_step,
            )),
            Err(_) => issues.push(health_issue(
                "target_git_state_unavailable",
                "Stacks could not determine whether the target checkout has an in-progress Git operation.",
                target_step,
            )),
            _ => {}
        }
    }

    if let (Some(target), Some(source)) = (
        target_canonical.as_ref().and_then(|path| path.to_str()),
        source_canonical.as_ref().and_then(|path| path.to_str()),
    ) {
        let registered = ensure_registered_distinct_worktree(target, source).is_ok();
        if !registered {
            issues.push(health_issue(
                "source_worktree_not_registered",
                "The source checkout is not a distinct registered worktree of the target repository.",
                target_step,
            ));
        }
        if card.status == "done"
            && card.completion_outcome.as_deref() == Some("merged")
            && registered
        {
            if let (Some(recorded), Some(current)) = (
                environment.source_revision.as_deref(),
                source_tip.as_deref(),
            ) {
                if recorded != current {
                    issues.push(health_issue(
                        "source_revision_changed",
                        "The source branch has new commits since merge; merge again before cleanup.",
                        "cleanup",
                    ));
                } else {
                    match git_status_success(target, &["merge-base", "--is-ancestor", current, "HEAD"]) {
                        Ok(false) => issues.push(health_issue(
                            "source_revision_not_merged",
                            "The merged source revision is no longer reachable from the target branch.",
                            "cleanup",
                        )),
                        Err(_) => issues.push(health_issue(
                            "ancestry_check_failed",
                            "Stacks could not verify that the source revision is reachable from the target branch.",
                            "cleanup",
                        )),
                        _ => {}
                    }
                }
            }
        }
    }

    Ok(CardEnvironmentHealth {
        card_id: card.id,
        issues,
    })
}

fn git_status_success(path: &str, args: &[&str]) -> Result<bool, String> {
    Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .status()
        .map(|status| status.success())
        .map_err(|error| error.to_string())
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
        "REVERT_HEAD",
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

    fn test_project(connection: &Connection, id: &str, source: &str, path: &str) {
        crate::store::migrate_store_schema(connection).unwrap();
        connection.execute(
            "INSERT OR REPLACE INTO projects (id, name, path, kanban_source, sort_order) VALUES (?1, ?1, ?2, ?3, 0)",
            params![id, path, source],
        ).unwrap();
    }

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

    fn insert_ordered_card(
        connection: &Connection,
        id: &str,
        status: &str,
        order: i64,
        updated_at: i64,
    ) {
        connection.execute(
            "INSERT INTO kanban_cards (id,external_provider,external_id,title,status,created_at,updated_at,sort_order,in_scope)
             VALUES (?1,'local:p',?1,?1,?2,?3,?4,?3,1)",
            params![id, status, order, updated_at],
        ).unwrap();
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn status_transition_retry_with_stale_revision_is_unchanged() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        connection.execute(
            "INSERT INTO kanban_cards (id,external_provider,external_id,title,status,workflow_revision,created_at,updated_at,sort_order)
             VALUES ('card','local:p','1','Card','needs_refinement',7,1,11,4)",
            [],
        ).unwrap();

        let changed =
            set_card_status(&mut connection, "card", "ready", 7, "user", || Ok(())).unwrap();
        assert_eq!(changed.status, "ready");
        assert_eq!(changed.workflow_revision, 8);
        let after_first: (i64, i64, i64, i64) = connection.query_row(
            "SELECT workflow_revision,sort_order,updated_at,(SELECT COUNT(*) FROM card_events WHERE card_id='card') FROM kanban_cards WHERE id='card'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
        let event_time: i64 = connection
            .query_row(
                "SELECT created_at FROM card_events WHERE card_id='card'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(after_first.2, event_time);

        let retried = set_card_status(&mut connection, "card", "ready", 7, "user", || {
            panic!("idempotent retry must not create a directory")
        })
        .unwrap();
        let after_retry: (i64, i64, i64, i64) = connection.query_row(
            "SELECT workflow_revision,sort_order,updated_at,(SELECT COUNT(*) FROM card_events WHERE card_id='card') FROM kanban_cards WHERE id='card'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
        assert_eq!(retried.workflow_revision, 8);
        assert_eq!(after_retry, after_first);
    }

    #[test]
    fn non_idempotent_status_transition_still_checks_revision() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        insert_ordered_card(&connection, "card", "needs_refinement", 0, 12);
        connection
            .execute(
                "UPDATE kanban_cards SET workflow_revision=3 WHERE id='card'",
                [],
            )
            .unwrap();
        let error =
            set_card_status(&mut connection, "card", "ready", 2, "user", || Ok(())).unwrap_err();
        assert!(error.contains("Card changed"));
        assert_eq!(
            get_card(&connection, "card").unwrap().unwrap().status,
            "needs_refinement"
        );
    }

    #[test]
    fn reorder_retry_is_idempotent_and_uses_one_timestamp() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        for (index, id) in ["a", "hidden", "b"].iter().enumerate() {
            insert_ordered_card(&connection, id, "ready", index as i64, 10 + index as i64);
        }
        let expected = ids(&["a", "hidden", "b"]);
        let desired = ids(&["b", "hidden", "a"]);
        reorder_cards(&mut connection, "ready", &expected, &desired).unwrap();
        let first = connection
            .prepare("SELECT id,sort_order,updated_at FROM kanban_cards ORDER BY sort_order,id")
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            first.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(),
            vec!["b", "hidden", "a"]
        );
        assert!(first.iter().all(|row| row.2 == first[0].2));

        reorder_cards(&mut connection, "ready", &expected, &desired).unwrap();
        let retried = connection
            .prepare("SELECT id,sort_order,updated_at FROM kanban_cards ORDER BY sort_order,id")
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(retried, first);
    }

    #[test]
    fn concurrent_reorder_conflicts_without_overwriting_first_order() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        for (index, id) in ["a", "b", "c"].iter().enumerate() {
            insert_ordered_card(&connection, id, "ready", index as i64, 1);
        }
        let expected = ids(&["a", "b", "c"]);
        reorder_cards(&mut connection, "ready", &expected, &ids(&["b", "a", "c"])).unwrap();
        let before_conflict = connection
            .prepare("SELECT id,sort_order,updated_at FROM kanban_cards ORDER BY sort_order,id")
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let error =
            reorder_cards(&mut connection, "ready", &expected, &ids(&["c", "b", "a"])).unwrap_err();
        assert!(error.starts_with(REORDER_CONFLICT_CODE));
        let after_conflict = connection
            .prepare("SELECT id,sort_order,updated_at FROM kanban_cards ORDER BY sort_order,id")
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(after_conflict, before_conflict);
    }

    #[test]
    fn reorder_rejects_invalid_payloads_without_mutation() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        insert_ordered_card(&connection, "a", "ready", 0, 1);
        insert_ordered_card(&connection, "b", "ready", 1, 2);
        insert_ordered_card(&connection, "other", "approved", 0, 3);
        insert_ordered_card(&connection, "hidden", "ready", 2, 4);
        connection
            .execute("UPDATE kanban_cards SET in_scope=0 WHERE id='hidden'", [])
            .unwrap();
        let original = connection
            .prepare("SELECT id,sort_order,updated_at FROM kanban_cards ORDER BY id")
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        let cases = [
            (
                ids(&["a", "a", "b"]),
                ids(&["a", "b"]),
                "expected_card_ids contains duplicate",
            ),
            (
                ids(&["a", "b"]),
                ids(&["a", "a", "b"]),
                "card_ids contains duplicate",
            ),
            (ids(&["a", "b"]), ids(&["a"]), "exactly the same IDs"),
            (ids(&["a"]), ids(&["a"]), "incomplete"),
            (
                ids(&["a", "b", "missing"]),
                ids(&["a", "b", "missing"]),
                "Unknown reordered card ID",
            ),
            (
                ids(&["a", "b", "other"]),
                ids(&["a", "b", "other"]),
                "effective lane approved",
            ),
            (
                ids(&["a", "b", "hidden"]),
                ids(&["a", "b", "hidden"]),
                "not in scope",
            ),
        ];
        for (expected, desired, message) in cases {
            assert!(reorder_cards(&mut connection, "ready", &expected, &desired)
                .unwrap_err()
                .contains(message));
            let unchanged = connection
                .prepare("SELECT id,sort_order,updated_at FROM kanban_cards ORDER BY id")
                .unwrap()
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert_eq!(unchanged, original);
        }
    }

    #[test]
    fn reorder_uses_aggregate_parents_effective_child_lane() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        insert_ordered_card(&connection, "parent", "ready", 0, 1);
        insert_ordered_card(&connection, "child", "needs_human", 1, 1);
        connection
            .execute(
                "UPDATE kanban_cards SET hierarchy_finalized=1 WHERE id='parent'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE kanban_cards SET parent_id='parent' WHERE id='child'",
                [],
            )
            .unwrap();

        let error = reorder_cards(
            &mut connection,
            "ready",
            &ids(&["parent"]),
            &ids(&["parent"]),
        )
        .unwrap_err();
        assert!(error.contains("effective lane needs_human"));
        let cards = reorder_cards(
            &mut connection,
            "needs_human",
            &ids(&["parent", "child"]),
            &ids(&["child", "parent"]),
        )
        .unwrap();
        assert_eq!(
            cards
                .iter()
                .filter(|card| card.status == "needs_human")
                .map(|card| card.id.as_str())
                .collect::<Vec<_>>(),
            vec!["child", "parent"]
        );
    }

    #[test]
    fn revision_schema_migrates_existing_cards_and_initializes_board_metadata() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kanban_cards (
            id TEXT PRIMARY KEY, external_provider TEXT NOT NULL, external_id TEXT NOT NULL,
            title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', board_id TEXT NOT NULL DEFAULT '',
            board_title TEXT NOT NULL DEFAULT '', list_id TEXT NOT NULL DEFAULT '', list_title TEXT NOT NULL DEFAULT '',
            card_url TEXT NOT NULL DEFAULT '', assignee_names TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'needs_refinement' CHECK(status IN ('needs_refinement','refining','needs_refinement_input','ready','agent_working','needs_human','approved','done')),
            completion_outcome TEXT, feature_environment INTEGER NOT NULL DEFAULT 0, delivery_operation_stage TEXT,
            delivery_error TEXT, workflow_revision INTEGER NOT NULL DEFAULT 1, project_id TEXT, workspace_id TEXT,
            parent_id TEXT, hierarchy_finalized INTEGER NOT NULL DEFAULT 0, provider_child_count INTEGER NOT NULL DEFAULT 0,
            provider_parent_title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0, in_scope INTEGER NOT NULL DEFAULT 1,
            UNIQUE(external_provider, external_id));
            INSERT INTO kanban_cards(id,external_provider,external_id,title,created_at,updated_at)
            VALUES ('legacy','local:p','1','Legacy',1,1);") .unwrap();
        migrate(&connection).unwrap();
        let record: i64 = connection
            .query_row(
                "SELECT record_revision FROM kanban_cards WHERE id='legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(record, 1);
        assert_eq!(board_revision(&connection).unwrap(), 0);
    }

    #[test]
    fn revision_bookkeeping_touches_derived_relationships_once_per_transaction() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        connection
            .execute_batch(
                "INSERT INTO kanban_cards
            (id,external_provider,external_id,title,status,created_at,updated_at,parent_id)
            VALUES ('parent','local:p','1','Parent','needs_refinement',1,1,NULL),
                   ('child','local:p','2','Child','needs_refinement',1,1,'parent');",
            )
            .unwrap();
        let before = serialized_board_entities(&mut connection).unwrap();
        connection
            .execute(
                "UPDATE kanban_cards SET title='Changed', status='ready' WHERE id='child'",
                [],
            )
            .unwrap();
        connection.execute("INSERT INTO card_events(card_id,created_at,actor,event_type,outcome) VALUES ('child',2,'user','test','success')", []).unwrap();
        let after = serialized_board_entities(&mut connection).unwrap();
        let change = commit_board_revision(&mut connection, &before, &after)
            .unwrap()
            .unwrap();
        assert_eq!(change.board_revision, 1);
        assert_eq!(
            change
                .upserts
                .iter()
                .map(|card| card.id.as_str())
                .collect::<Vec<_>>(),
            vec!["child", "parent"]
        );
        let revisions = connection
            .prepare("SELECT id,record_revision FROM kanban_cards ORDER BY id")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(revisions, vec![("child".into(), 2), ("parent".into(), 2)]);
        assert!(commit_board_revision(&mut connection, &after, &after)
            .unwrap()
            .is_none());
        assert_eq!(board_revision(&connection).unwrap(), 1);
    }

    #[test]
    fn revisions_report_deletion_and_card_order_has_stable_id_tie_breaker() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        connection.execute_batch("INSERT INTO kanban_cards(id,external_provider,external_id,title,created_at,updated_at,sort_order)
            VALUES ('z','local:p','1','Z',1,1,0), ('a','local:p','2','A',1,1,0);").unwrap();
        assert_eq!(
            list_cards(&mut connection)
                .unwrap()
                .iter()
                .map(|card| card.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "z"]
        );
        let before = serialized_board_entities(&mut connection).unwrap();
        connection
            .execute("DELETE FROM kanban_cards WHERE id='a'", [])
            .unwrap();
        let after = serialized_board_entities(&mut connection).unwrap();
        let change = commit_board_revision(&mut connection, &before, &after)
            .unwrap()
            .unwrap();
        assert_eq!(change.removed_ids, vec!["a"]);
        assert_eq!(change.board_revision, 1);
    }

    #[test]
    fn project_reassignment_allows_only_refinement_statuses_and_renumbers_cards() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();

        for (index, status) in REFINEMENT_STATUSES.iter().enumerate() {
            let id = format!("local:source:{}", index + 1);
            connection.execute(
                "INSERT INTO kanban_cards (id,external_provider,external_id,title,status,project_id,created_at,updated_at) VALUES (?1,'local:source',?2,?1,?3,'source',1,1)",
                params![id, (index + 10).to_string(), status],
            ).unwrap();

            let updated =
                set_card_project(&mut connection, &id, "destination", "Destination").unwrap();
            assert_eq!(updated.status, *status);
            assert_eq!(updated.project_id.as_deref(), Some("destination"));
            assert_eq!(updated.external_id, (index + 1).to_string());
            assert_eq!(updated.board_title, "Destination");
        }
    }

    #[test]
    fn project_reassignment_rejects_ready_and_later_statuses_without_changes() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();

        for (index, status) in ["ready", "agent_working", "needs_human", "approved", "done"]
            .iter()
            .enumerate()
        {
            let id = format!("local:source:{status}");
            let original_number = (index + 10).to_string();
            connection.execute(
                "INSERT INTO kanban_cards (id,external_provider,external_id,title,status,project_id,created_at,updated_at) VALUES (?1,'local:source',?2,?1,?3,'source',1,1)",
                params![id, original_number, status],
            ).unwrap();

            let error =
                set_card_project(&mut connection, &id, "destination", "Destination").unwrap_err();
            assert!(error.contains("only be reassigned during refinement"));
            let unchanged = get_card(&connection, &id).unwrap().unwrap();
            assert_eq!(unchanged.status, *status);
            assert_eq!(unchanged.project_id.as_deref(), Some("source"));
            assert_eq!(unchanged.external_id, original_number);
        }
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
            None,
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

        assert!(finish_local_refinement(&mut connection, "local:test", None, "  ", None).is_err());
        assert_eq!(
            get_card(&connection, "local:test").unwrap().unwrap().status,
            "needs_refinement"
        );
    }

    #[test]
    fn hierarchy_migration_defaults_are_additive() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        connection.execute(
            "INSERT INTO kanban_cards (id,external_provider,external_id,title,created_at,updated_at) VALUES ('legacy','local:p','1','Legacy',1,1)",
            [],
        ).unwrap();
        let values: (Option<String>, i64, i64, Option<String>) = connection.query_row(
            "SELECT parent_id,hierarchy_finalized,provider_child_count,provider_parent_title FROM kanban_cards WHERE id='legacy'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
        assert_eq!(values, (None, 0, 0, None));
    }

    #[test]
    fn hierarchy_assignment_enforces_same_project_and_two_levels() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        for (id, project) in [("parent", "p1"), ("child", "p1"), ("other", "p2")] {
            connection.execute(
                "INSERT INTO kanban_cards (id,external_provider,external_id,title,status,project_id,created_at,updated_at) VALUES (?1,'local:' || ?2,?1,?1,'needs_refinement',?2,1,1)",
                params![id, project],
            ).unwrap();
        }
        let assigned = set_card_parent(&connection, "child", Some("parent")).unwrap();
        assert_eq!(
            assigned.parent.as_ref().map(|parent| parent.id.as_str()),
            Some("parent")
        );
        assert!(set_card_parent(&connection, "other", Some("parent"))
            .unwrap_err()
            .contains("same project"));
        assert!(set_card_parent(&connection, "parent", Some("child"))
            .unwrap_err()
            .contains("cannot itself have a parent"));
        assert!(set_card_parent(&connection, "child", Some("child"))
            .unwrap_err()
            .contains("own parent"));
        assert!(set_card_parent(&connection, "child", None)
            .unwrap()
            .parent
            .is_none());
    }

    #[test]
    fn breakdown_is_atomic_numbers_children_and_derives_parent_status() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        test_project(&connection, "p", "local", "/tmp/p");
        let parent = create_local_card(&mut connection, "p", "P", "Parent", "Draft").unwrap();
        let draft = create_local_card(&mut connection, "p", "P", "Draft child", "Draft").unwrap();
        set_card_parent(&connection, &draft.id, Some(&parent.id)).unwrap();
        let specs = vec![
            ApprovedChildSpec {
                id: Some(draft.id.clone()),
                title: "Existing".into(),
                content: "Existing brief".into(),
            },
            ApprovedChildSpec {
                id: None,
                title: "New".into(),
                content: "New brief".into(),
            },
        ];
        let aggregate = finish_local_refinement(
            &mut connection,
            &parent.id,
            Some("Aggregate"),
            "Parent brief",
            Some(&specs),
        )
        .unwrap();
        assert!(aggregate.hierarchy_finalized);
        assert_eq!(aggregate.child_count, 2);
        assert_eq!(aggregate.status, "ready");
        assert!(aggregate
            .children
            .iter()
            .all(|child| child.status == "ready"));
        assert_eq!(
            aggregate
                .children
                .iter()
                .map(|child| child.external_id.as_str())
                .collect::<Vec<_>>(),
            vec!["2", "3"]
        );

        connection
            .execute(
                "UPDATE kanban_cards SET status='done' WHERE parent_id=?1",
                [&parent.id],
            )
            .unwrap();
        assert_eq!(
            get_card(&connection, &parent.id).unwrap().unwrap().status,
            "done"
        );
        connection
            .execute(
                "UPDATE kanban_cards SET status='needs_refinement' WHERE id=?1",
                [&draft.id],
            )
            .unwrap();
        assert_eq!(
            get_card(&connection, &parent.id).unwrap().unwrap().status,
            "needs_refinement"
        );
        assert!(update_local_card(&connection, &parent.id, Some("Unlocked"), None).is_err());
        assert!(validate_card_deletion(&connection, &parent.id)
            .unwrap_err()
            .contains("children"));
    }

    #[test]
    fn invalid_breakdown_rolls_back_parent_and_children() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        test_project(&connection, "p", "local", "/tmp/p");
        let parent = create_local_card(&mut connection, "p", "P", "Parent", "Original").unwrap();
        let draft =
            create_local_card(&mut connection, "p", "P", "Draft", "Original child").unwrap();
        set_card_parent(&connection, &draft.id, Some(&parent.id)).unwrap();
        let invalid = vec![ApprovedChildSpec {
            id: None,
            title: "Replacement".into(),
            content: "Brief".into(),
        }];
        assert!(finish_local_refinement(
            &mut connection,
            &parent.id,
            None,
            "Changed",
            Some(&invalid)
        )
        .is_err());
        let unchanged = get_card(&connection, &parent.id).unwrap().unwrap();
        assert_eq!(unchanged.content, "Original");
        assert!(!unchanged.hierarchy_finalized);
        assert_eq!(
            get_card(&connection, &draft.id).unwrap().unwrap().content,
            "Original child"
        );
    }

    #[test]
    fn finishing_external_refinement_marks_the_card_ready_and_is_idempotent() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        let now = unix_timestamp();
        connection.execute(
            "INSERT INTO kanban_cards
             (id, external_provider, external_id, title, content, status, workflow_revision, created_at, updated_at)
             VALUES ('superthread:42', 'superthread', '42', 'External card', 'Saved final brief', 'needs_refinement', 4, ?1, ?1)",
            [now],
        ).unwrap();

        let updated = finish_external_refinement(&mut connection, "superthread:42").unwrap();
        assert_eq!(updated.status, "ready");
        assert_eq!(updated.workflow_revision, 5);
        assert_eq!(connection.query_row(
            "SELECT COUNT(*) FROM card_events WHERE card_id='superthread:42' AND from_status='needs_refinement' AND to_status='ready'",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 1);

        let retried = finish_external_refinement(&mut connection, "superthread:42").unwrap();
        assert_eq!(retried.status, "ready");
        assert_eq!(retried.workflow_revision, 5);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM card_events WHERE card_id='superthread:42'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn external_refinement_finishes_from_active_and_waiting_states() {
        for source in ["refining", "needs_refinement_input"] {
            let mut connection = Connection::open_in_memory().unwrap();
            migrate(&connection).unwrap();
            connection.execute(
                "INSERT INTO kanban_cards (id,external_provider,external_id,title,status,workflow_revision,created_at,updated_at) VALUES ('superthread:42','superthread','42','External',?1,3,1,1)",
                [source],
            ).unwrap();
            let updated = finish_external_refinement(&mut connection, "superthread:42").unwrap();
            assert_eq!(updated.status, "ready");
            let recorded: String = connection
                .query_row(
                    "SELECT from_status FROM card_events WHERE card_id='superthread:42'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(recorded, source);
        }
    }

    #[test]
    fn external_refinement_action_rejects_local_cards() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        local_card(&mut connection);

        let error = finish_external_refinement(&mut connection, "local:test").unwrap_err();
        assert!(error.contains("externally managed card"));
        assert_eq!(
            get_card(&connection, "local:test").unwrap().unwrap().status,
            "needs_refinement"
        );
    }

    #[test]
    fn sync_preserves_local_workflow_state() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        test_project(
            &connection,
            "superthread-project",
            "superthread",
            "/tmp/superthread",
        );
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
            task_parent_id: None,
            task_parent_title: None,
            total_task_children: 0,
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
        assert_eq!(cards[0].project_id.as_deref(), Some("superthread-project"));
    }

    #[test]
    fn superthread_sync_persists_parent_references_and_provider_counts() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        test_project(
            &connection,
            "superthread-project",
            "superthread",
            "/tmp/superthread",
        );
        let snapshot =
            |id: &str, title: &str, parent: Option<(&str, &str)>, count| KanbanCardSnapshot {
                id: id.into(),
                title: title.into(),
                content: String::new(),
                board_id: "b".into(),
                board_title: "Board".into(),
                list_id: "l".into(),
                list_title: "List".into(),
                card_url: String::new(),
                assignee_names: Vec::new(),
                task_parent_id: parent.map(|value| value.0.into()),
                task_parent_title: parent.map(|value| value.1.into()),
                total_task_children: count,
                in_scope: true,
            };
        let cards = sync_cards(
            &mut connection,
            vec![
                snapshot("10", "Parent", None, 1),
                snapshot("11", "Child", Some(("10", "Parent")), 0),
            ],
        )
        .unwrap();
        let parent = cards.iter().find(|card| card.external_id == "10").unwrap();
        let child = cards.iter().find(|card| card.external_id == "11").unwrap();
        assert_eq!(parent.child_count, 1);
        assert!(parent.hierarchy_finalized);
        assert_eq!(parent.children[0].id, child.id);
        assert_eq!(
            child.parent.as_ref().map(|value| value.id.as_str()),
            Some("superthread:10")
        );
    }

    #[test]
    fn rejects_unknown_statuses_and_accepts_the_refinement_cycle() {
        assert!(!STATUSES.contains(&"waiting_for_magic"));
        for transition in [
            ("needs_refinement", "refining"),
            ("refining", "needs_refinement_input"),
            ("needs_refinement_input", "refining"),
            ("refining", "needs_refinement"),
            ("needs_refinement_input", "needs_refinement"),
            ("ready", "needs_refinement"),
        ] {
            assert!(
                is_legal_status_transition(transition.0, transition.1),
                "{transition:?}"
            );
        }
        assert!(!is_legal_status_transition(
            "needs_refinement_input",
            "agent_working"
        ));
        assert!(!is_legal_status_transition("refining", "approved"));
    }

    #[test]
    fn finishing_refinement_records_each_actual_in_progress_source() {
        for source in ["needs_refinement", "refining", "needs_refinement_input"] {
            let mut connection = Connection::open_in_memory().unwrap();
            migrate(&connection).unwrap();
            local_card(&mut connection);
            connection
                .execute(
                    "UPDATE kanban_cards SET status=?1 WHERE id='local:test'",
                    [source],
                )
                .unwrap();

            let updated = finish_local_refinement(
                &mut connection,
                "local:test",
                None,
                "Approved brief",
                None,
            )
            .unwrap();
            assert_eq!(updated.status, "ready");
            let recorded: String = connection.query_row(
                "SELECT from_status FROM card_events WHERE card_id='local:test' ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            ).unwrap();
            assert_eq!(recorded, source);
        }
    }

    #[test]
    fn reconciles_local_and_superthread_ownership_deterministically() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        test_project(&connection, "local-owner", "local", "/tmp/local");
        test_project(&connection, "remote-owner", "superthread", "/tmp/remote");
        connection.execute(
            "INSERT INTO kanban_cards (id, external_provider, external_id, title, project_id, created_at, updated_at) VALUES
             ('local:legacy', 'local:local-owner', '1', 'Local', NULL, 1, 1),
             ('superthread:legacy', 'superthread', '2', 'Remote', 'local-owner', 1, 1)", [],
        ).unwrap();

        reconcile_card_ownership(&connection).unwrap();

        assert_eq!(
            get_card(&connection, "local:legacy")
                .unwrap()
                .unwrap()
                .project_id
                .as_deref(),
            Some("local-owner")
        );
        assert_eq!(
            get_card(&connection, "superthread:legacy")
                .unwrap()
                .unwrap()
                .project_id
                .as_deref(),
            Some("remote-owner")
        );
    }

    #[test]
    fn rejects_ambiguous_superthread_ownership_and_blocked_project_deletion() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        test_project(&connection, "remote-one", "superthread", "/tmp/one");
        test_project(&connection, "remote-two", "superthread", "/tmp/two");
        connection.execute(
            "INSERT INTO kanban_cards (id, external_provider, external_id, title, project_id, created_at, updated_at) VALUES ('superthread:legacy', 'superthread', '1', 'Remote', NULL, 1, 1)", [],
        ).unwrap();
        assert!(reconcile_card_ownership(&connection)
            .unwrap_err()
            .contains("ambiguous"));

        test_project(&connection, "local-owner", "local", "/tmp/local");
        connection.execute(
            "INSERT INTO kanban_cards (id, external_provider, external_id, title, status, project_id, created_at, updated_at) VALUES ('local:active', 'local:local-owner', '1', 'Active', 'ready', 'local-owner', 1, 1)", [],
        ).unwrap();
        assert!(validate_project_deletion(&connection, "local-owner")
            .unwrap_err()
            .contains("active card"));
        connection
            .execute(
                "UPDATE kanban_cards SET status='done', completion_outcome='merged' WHERE id='local:active'",
                [],
            )
            .unwrap();
        assert_eq!(
            validate_project_deletion(&connection, "local-owner").unwrap(),
            vec!["local:active"]
        );
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
        test_project(
            &connection,
            "superthread-project",
            "superthread",
            "/tmp/superthread",
        );
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
                task_parent_id: None,
                task_parent_title: None,
                total_task_children: 0,
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

    fn environment_with_layout(connection: &mut Connection, layout_revision: i64) {
        local_card(connection);
        connection.execute(
            "INSERT INTO card_environments (id, card_id, project_id, worktree_path, branch, lifecycle_state, revision, created_at, updated_at)
             VALUES ('environment:test', 'local:test', 'project', '/repo-card-1', 'stacks/card-1', 'ready', 4, 1, 11)", [],
        ).unwrap();
        connection.execute(
            "INSERT INTO card_panes (id, environment_id, role, kind, sort_order) VALUES ('pane:old', 'environment:test', 'shell', 'terminal', 0)", [],
        ).unwrap();
        connection.execute(
            "INSERT INTO card_layouts (environment_id, split_layout, focused_pane_id, layout_revision, updated_at)
             VALUES ('environment:test', '{\"kind\":\"leaf\",\"terminalId\":\"pane:old\"}', 'pane:old', ?1, 1)",
            [layout_revision],
        ).unwrap();
    }

    #[test]
    fn layout_revision_migration_preserves_existing_layout_and_panes() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        environment_with_layout(&mut connection, 7);
        connection
            .execute("ALTER TABLE card_layouts DROP COLUMN layout_revision", [])
            .unwrap();

        migrate(&connection).unwrap();

        let layout: (String, Option<String>, i64) = connection.query_row(
            "SELECT split_layout, focused_pane_id, layout_revision FROM card_layouts WHERE environment_id='environment:test'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert!(layout.0.contains("pane:old"));
        assert_eq!(layout.1.as_deref(), Some("pane:old"));
        assert_eq!(layout.2, 1);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM card_panes WHERE id='pane:old'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn layout_saves_are_atomic_and_independent_from_environment_revisions() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        environment_with_layout(&mut connection, 2);

        save_environment_layout(
            &mut connection,
            "local:test",
            serde_json::json!({"kind":"split","direction":"row","children":[{"kind":"leaf","terminalId":"pane:a"},{"kind":"leaf","terminalId":"pane:b"}]}),
            Some("pane:b".into()),
            vec![
                CardPane { id: "pane:a".into(), role: "shell".into(), kind: "terminal".into(), command: None, sort_order: 0 },
                CardPane { id: "pane:b".into(), role: "shell".into(), kind: "terminal".into(), command: None, sort_order: 1 },
            ],
            2,
        ).unwrap();

        let environment_state: (i64, i64) = connection
            .query_row(
                "SELECT revision, updated_at FROM card_environments WHERE id='environment:test'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(environment_state, (4, 11));
        let loaded = get_card(&connection, "local:test")
            .unwrap()
            .unwrap()
            .environment
            .unwrap();
        assert_eq!(loaded.revision, 4);
        assert_eq!(loaded.layout_revision, 3);
        assert_eq!(loaded.focused_pane_id.as_deref(), Some("pane:b"));
        assert_eq!(
            loaded
                .panes
                .iter()
                .filter(|pane| pane.role == "shell")
                .count(),
            2
        );

        // A repository writer advances only the environment revision. The current
        // layout revision remains valid, and a focus-only save leaves it untouched.
        assert_eq!(connection.execute(
            "UPDATE card_environments SET revision=revision+1 WHERE id='environment:test' AND revision=4",
            [],
        ).unwrap(), 1);
        save_environment_layout(
            &mut connection,
            "local:test",
            loaded.split_layout.clone(),
            Some("pane:a".into()),
            loaded.panes.clone(),
            3,
        )
        .unwrap();
        let revisions: (i64, i64) = connection.query_row(
            "SELECT e.revision, l.layout_revision FROM card_environments e JOIN card_layouts l ON l.environment_id=e.id WHERE e.id='environment:test'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(revisions, (5, 4));

        let before_stale: (String, Option<String>, i64) = connection.query_row(
            "SELECT split_layout, focused_pane_id, layout_revision FROM card_layouts WHERE environment_id='environment:test'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        let stale_error = save_environment_layout(
            &mut connection,
            "local:test",
            serde_json::json!({"kind":"leaf","terminalId":"pane:stale"}),
            Some("pane:stale".into()),
            vec![CardPane {
                id: "pane:stale".into(),
                role: "shell".into(),
                kind: "terminal".into(),
                command: None,
                sort_order: 0,
            }],
            3,
        )
        .unwrap_err();
        assert!(stale_error.contains("Card layout changed; reload"));
        let after_stale: (String, Option<String>, i64) = connection.query_row(
            "SELECT split_layout, focused_pane_id, layout_revision FROM card_layouts WHERE environment_id='environment:test'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(after_stale, before_stale);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM card_panes WHERE environment_id='environment:test' AND role='shell'", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM card_panes WHERE id='pane:stale'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );

        // Layout writes do not make a current repository revision stale.
        assert_eq!(connection.execute(
            "UPDATE card_environments SET lifecycle_state='cleanup_pending', revision=revision+1 WHERE id='environment:test' AND revision=5",
            [],
        ).unwrap(), 1);
    }

    #[test]
    fn environment_aggregate_restores_layout_and_panes() {
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
        let environment = get_card(&connection, "local:test")
            .unwrap()
            .unwrap()
            .environment
            .unwrap();
        assert_eq!(environment.worktree_path, "/repo-card-1");
        assert_eq!(environment.revision, 4);
        assert_eq!(environment.layout_revision, 1);
        assert_eq!(environment.panes[0].id, "pane:shell");
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

    #[test]
    fn migrates_legacy_merged_cards_to_done_with_merged_outcome() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kanban_cards (
            id TEXT PRIMARY KEY, external_provider TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '', board_id TEXT NOT NULL DEFAULT '', board_title TEXT NOT NULL DEFAULT '',
            list_id TEXT NOT NULL DEFAULT '', list_title TEXT NOT NULL DEFAULT '', card_url TEXT NOT NULL DEFAULT '',
            assignee_names TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL CHECK(status IN ('needs_refinement','ready','agent_working','needs_human','approved','merged')),
            workflow_revision INTEGER NOT NULL DEFAULT 1, project_id TEXT, workspace_id TEXT, created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, in_scope INTEGER NOT NULL DEFAULT 1,
            UNIQUE(external_provider, external_id));
            INSERT INTO kanban_cards (id,external_provider,external_id,title,status,created_at,updated_at)
            VALUES ('legacy','local:p','1','Legacy','merged',1,1);").unwrap();
        migrate(&connection).unwrap();
        let result: (String, Option<String>) = connection
            .query_row(
                "SELECT status,completion_outcome FROM kanban_cards WHERE id='legacy'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(result, ("done".to_string(), Some("merged".to_string())));
    }

    #[test]
    fn migrates_current_status_constraint_without_losing_rows_or_relationships() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        connection.execute("INSERT INTO kanban_cards (id,external_provider,external_id,title,status,feature_environment,delivery_operation_stage,delivery_error,workflow_revision,project_id,workspace_id,created_at,updated_at,sort_order,in_scope) VALUES ('kept','local:p','9','Kept','needs_refinement',1,'stage','detail',7,'p','w',1,2,3,1)", []).unwrap();
        connection.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome) VALUES ('kept',1,'user','test','success')", []).unwrap();
        connection.execute("INSERT INTO card_environments (id,card_id,project_id,worktree_path,created_at,updated_at) VALUES ('env','kept','p','/tmp/work',1,1)", []).unwrap();
        connection.execute("INSERT INTO card_pull_requests (card_id,repository,number,title,url,state,updated_at) VALUES ('kept','o/r',9,'PR','url','open',1)", []).unwrap();
        connection.execute_batch(
            "PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; BEGIN;
             ALTER TABLE kanban_cards RENAME TO cards_expanded;
             CREATE TABLE kanban_cards (
                id TEXT PRIMARY KEY, external_provider TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '', board_id TEXT NOT NULL DEFAULT '', board_title TEXT NOT NULL DEFAULT '',
                list_id TEXT NOT NULL DEFAULT '', list_title TEXT NOT NULL DEFAULT '', card_url TEXT NOT NULL DEFAULT '', assignee_names TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'needs_refinement' CHECK(status IN ('needs_refinement','ready','agent_working','needs_human','approved','done')),
                completion_outcome TEXT CHECK(completion_outcome IN ('merged','closed')), feature_environment INTEGER NOT NULL DEFAULT 0,
                delivery_operation_stage TEXT, delivery_error TEXT, workflow_revision INTEGER NOT NULL DEFAULT 1, project_id TEXT, workspace_id TEXT,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, in_scope INTEGER NOT NULL DEFAULT 1,
                UNIQUE(external_provider,external_id));
             INSERT INTO kanban_cards (id,external_provider,external_id,title,content,board_id,board_title,list_id,list_title,card_url,assignee_names,status,completion_outcome,feature_environment,delivery_operation_stage,delivery_error,workflow_revision,project_id,workspace_id,created_at,updated_at,sort_order,in_scope)
             SELECT id,external_provider,external_id,title,content,board_id,board_title,list_id,list_title,card_url,assignee_names,status,completion_outcome,feature_environment,delivery_operation_stage,delivery_error,workflow_revision,project_id,workspace_id,created_at,updated_at,sort_order,in_scope FROM cards_expanded;
             DROP TABLE cards_expanded; COMMIT;
             PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;"
        ).unwrap();

        migrate(&connection).unwrap();
        let kept: (String, i64, Option<String>, Option<String>, i64) = connection.query_row(
            "SELECT status,feature_environment,delivery_operation_stage,delivery_error,workflow_revision FROM kanban_cards WHERE id='kept'",
            [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
        ).unwrap();
        assert_eq!(
            kept,
            (
                "needs_refinement".into(),
                1,
                Some("stage".into()),
                Some("detail".into()),
                7
            )
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM card_events WHERE card_id='kept'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM card_environments WHERE card_id='kept'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM card_pull_requests WHERE card_id='kept'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        connection
            .execute(
                "UPDATE kanban_cards SET status='refining' WHERE id='kept'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE kanban_cards SET status='needs_refinement_input' WHERE id='kept'",
                [],
            )
            .unwrap();
    }

    #[test]
    fn feature_environment_prefix_is_applied_exactly_once() {
        assert_eq!(feature_environment_title("Title"), "[FE] Title");
        assert_eq!(feature_environment_title("[FE] Title"), "[FE] Title");
        assert_eq!(feature_environment_title("[FE] [FE] Title"), "[FE] Title");
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
            uuid::Uuid::new_v4()
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
        test_project(&connection, "p", "local", target.to_str().unwrap());
        let now = unix_timestamp();
        connection.execute("INSERT INTO kanban_cards (id, external_provider, external_id, title, status, workflow_revision, project_id, created_at, updated_at) VALUES ('local:approve', 'local:p', '1', 'Approve', 'needs_human', 5, 'p', ?1, ?1)", [now]).unwrap();
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
            approve_and_commit_with_failure_record(&mut connection, "local:approve", 5, 2, false)
                .unwrap();
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
    fn approved_card_can_be_shipped_again_after_its_source_revision_changes() {
        let (root, target, source) = merge_repository();
        let mut connection = approval_connection(&source, &target);
        let first = approve_and_commit(&mut connection, "local:approve", 5, 2, false).unwrap();
        assert_eq!(first.card.status, "approved");

        fs::write(source.join("after-ship.txt"), "follow-up\n").unwrap();
        git_ok(&source, &["add", "."]);
        git_ok(&source, &["commit", "-m", "follow-up after ship"]);
        let changed_tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        let merge_error = merge_card(&mut connection, "local:approve", 6, 3).unwrap_err();
        assert!(
            merge_error.to_lowercase().contains("ship it again"),
            "{merge_error}"
        );

        let refreshed = approve_and_commit(&mut connection, "local:approve", 6, 3, false).unwrap();
        assert_eq!(refreshed.card.status, "approved");
        assert_eq!(refreshed.card.workflow_revision, 7);
        assert_eq!(
            refreshed
                .card
                .environment
                .as_ref()
                .unwrap()
                .source_revision
                .as_deref(),
            Some(changed_tip.as_str())
        );
        assert!(refreshed.message.contains("re-verified"));
        assert_eq!(
            merge_card(&mut connection, "local:approve", 7, 4)
                .unwrap()
                .card
                .status,
            "done"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn approval_reconciles_the_expected_agent_status_cycle() {
        for (status, revision) in [("agent_working", 6), ("needs_human", 7)] {
            let (root, target, source) = merge_repository();
            let mut connection = approval_connection(&source, &target);
            connection.execute("UPDATE kanban_cards SET status=?1, workflow_revision=?2 WHERE id='local:approve'", params![status, revision]).unwrap();
            let result = approve_and_commit(&mut connection, "local:approve", 5, 2, false).unwrap();
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
            let detail = approve_and_commit_with_failure_record(
                &mut connection,
                "local:approve",
                5,
                2,
                false,
            )
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
        assert!(
            approve_and_commit(&mut connection, "local:approve", 5, 2, false)
                .unwrap_err()
                .contains("expected unexpected")
        );
        connection
            .execute(
                "UPDATE card_environments SET branch='feature' WHERE card_id='local:approve'",
                [],
            )
            .unwrap();
        assert!(
            approve_and_commit(&mut connection, "local:approve", 4, 2, false)
                .unwrap_err()
                .contains("Card changed")
        );
        assert!(
            approve_and_commit(&mut connection, "local:approve", 5, 1, false)
                .unwrap_err()
                .contains("environment changed")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merge_creates_explicit_commit_and_transitions_only_after_verification() {
        let (root, target, source) = merge_repository();
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        crate::store::migrate_store_schema(&connection).unwrap();
        let now = unix_timestamp();
        connection.execute("INSERT INTO projects (id,name,path,kanban_source,delivery_workflow,target_branch,github_merge_strategy,require_passing_ci,require_approval) VALUES ('p','Project',?1,'local','local_merge','main','merge',1,0)", [target.to_str().unwrap()]).unwrap();
        connection.execute("INSERT INTO kanban_cards (id, external_provider, external_id, title, status, workflow_revision, project_id, created_at, updated_at) VALUES ('local:merge', 'local:p', '1', 'Merge', 'approved', 3, 'p', ?1, ?1)", [now]).unwrap();
        let repository = repository_identity(target.to_str().unwrap()).unwrap();
        let source_tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        let target_tip = git_output(target.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        connection.execute("INSERT INTO card_environments (id, card_id, project_id, worktree_path, branch, repository_id, target_checkout_path, target_branch, source_revision, target_revision, revision, created_at, updated_at) VALUES ('e', 'local:merge', 'p', ?1, 'feature', ?2, ?3, 'main', ?4, ?5, 2, ?6, ?6)", params![source.to_str().unwrap(), repository, target.to_str().unwrap(), source_tip, target_tip, now]).unwrap();
        let result = merge_card(&mut connection, "local:merge", 3, 2).unwrap();
        assert_eq!(result.card.status, "done");
        assert_eq!(result.card.completion_outcome.as_deref(), Some("merged"));
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

    fn health_codes(connection: &Connection, card_id: &str) -> Vec<String> {
        environment_health(connection, card_id)
            .unwrap()
            .issues
            .into_iter()
            .map(|issue| issue.code)
            .collect()
    }

    #[test]
    fn environment_health_is_status_aware_when_environment_is_absent() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        local_card(&mut connection);
        for status in [
            "needs_refinement",
            "refining",
            "needs_refinement_input",
            "ready",
            "done",
        ] {
            connection
                .execute(
                    "UPDATE kanban_cards SET status=?1 WHERE id='local:test'",
                    [status],
                )
                .unwrap();
            assert!(
                health_codes(&connection, "local:test").is_empty(),
                "{status}"
            );
        }
        for (status, step) in [
            ("agent_working", "work"),
            ("needs_human", "approval"),
            ("approved", "merge"),
        ] {
            connection
                .execute(
                    "UPDATE kanban_cards SET status=?1 WHERE id='local:test'",
                    [status],
                )
                .unwrap();
            let health = environment_health(&connection, "local:test").unwrap();
            assert_eq!(health.issues[0].code, "environment_missing");
            assert_eq!(health.issues[0].step, step);
        }
    }

    #[test]
    fn environment_health_accepts_healthy_and_dirty_active_worktrees() {
        let (root, target, source) = merge_repository();
        let connection = approval_connection(&source, &target);
        assert!(health_codes(&connection, "local:approve").is_empty());
        fs::write(
            source.join("feature.txt"),
            "ordinary implementation change\n",
        )
        .unwrap();
        assert!(health_codes(&connection, "local:approve").is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn environment_health_reports_metadata_repository_branch_and_git_operation_blockers() {
        let (root, target, source) = merge_repository();
        let connection = approval_connection(&source, &target);
        connection.execute("UPDATE card_environments SET target_checkout_path=NULL, target_branch=NULL WHERE card_id='local:approve'", []).unwrap();
        let codes = health_codes(&connection, "local:approve");
        assert!(codes.contains(&"target_checkout_missing".to_string()));
        assert!(codes.contains(&"target_branch_missing".to_string()));

        connection.execute("UPDATE card_environments SET target_checkout_path=?1, target_branch='wrong-target', branch='wrong', repository_id='wrong-repository' WHERE card_id='local:approve'", [target.to_str().unwrap()]).unwrap();
        let operation_marker = git_output(
            source.to_str().unwrap(),
            &["rev-parse", "--git-path", "MERGE_HEAD"],
        )
        .unwrap();
        fs::write(&operation_marker, "in progress\n").unwrap();
        let codes = health_codes(&connection, "local:approve");
        assert!(codes.contains(&"source_repository_mismatch".to_string()));
        assert!(codes.contains(&"target_repository_mismatch".to_string()));
        assert!(codes.contains(&"source_branch_mismatch".to_string()));
        assert!(codes.contains(&"target_branch_mismatch".to_string()));
        assert!(codes.contains(&"source_git_operation_in_progress".to_string()));
        fs::remove_file(operation_marker).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn environment_health_reports_missing_detached_and_unregistered_source_worktrees() {
        let (root, target, source) = merge_repository();
        let connection = approval_connection(&source, &target);
        git_ok(&source, &["checkout", "--detach"]);
        assert!(health_codes(&connection, "local:approve")
            .contains(&"source_checkout_detached".to_string()));
        git_ok(&source, &["checkout", "feature"]);

        connection.execute("UPDATE card_environments SET worktree_path=?1, branch='main' WHERE card_id='local:approve'", [target.to_str().unwrap()]).unwrap();
        assert!(health_codes(&connection, "local:approve")
            .contains(&"source_worktree_not_registered".to_string()));
        connection.execute("UPDATE card_environments SET worktree_path='/missing/stacks/source' WHERE card_id='local:approve'", []).unwrap();
        assert!(health_codes(&connection, "local:approve")
            .contains(&"source_checkout_unavailable".to_string()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn environment_health_checks_merged_cleanup_revisions_and_ancestry() {
        let (root, target, source) = merge_repository();
        let connection = approval_connection(&source, &target);
        git_ok(&target, &["merge", "--no-ff", "feature", "-m", "merge"]);
        let source_tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        let target_tip = git_output(target.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        connection
            .execute(
                "UPDATE kanban_cards SET status='done', completion_outcome='merged' WHERE id='local:approve'",
                [],
            )
            .unwrap();
        connection.execute("UPDATE card_environments SET source_revision=?1, target_revision=?2 WHERE card_id='local:approve'", params![source_tip, target_tip]).unwrap();
        assert!(health_codes(&connection, "local:approve").is_empty());

        fs::write(source.join("later.txt"), "later\n").unwrap();
        git_ok(&source, &["add", "."]);
        git_ok(&source, &["commit", "-m", "later"]);
        assert!(health_codes(&connection, "local:approve")
            .contains(&"source_revision_changed".to_string()));

        let new_tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        connection
            .execute(
                "UPDATE card_environments SET source_revision=?1 WHERE card_id='local:approve'",
                [new_tip],
            )
            .unwrap();
        assert!(health_codes(&connection, "local:approve")
            .contains(&"source_revision_not_merged".to_string()));
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
