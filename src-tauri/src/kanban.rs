use crate::{
    fs_paths::{app_data_dir, app_data_file},
    pi_rpc::{delete_pi_session_impl, PiRpcRegistry},
    pty::kill_ptys,
    pty_cwd::PtyRegistry,
    workspace_setup::{run_workspace_setup_durable, WorkspaceSetupState},
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::AtomicBool, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

static REPOSITORY_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static BOARD_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static DATABASE_INITIALIZATION: OnceLock<Result<(), String>> = OnceLock::new();

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

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EnvironmentCreationOperation {
    id: String,
    phase: String,
    error: Option<String>,
    source_path: Option<String>,
    source_branch: Option<String>,
    cleanup_available: bool,
    custom_command: bool,
    revision: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CardCleanupOperation {
    status: String,
    phase: String,
    error_code: Option<String>,
    error_detail: Option<String>,
    started_at: i64,
    updated_at: i64,
    completed_at: Option<i64>,
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
    runtime_cleanup_status: Option<String>,
    runtime_cleanup_error: Option<String>,
    workflow_revision: i64,
    record_revision: i64,
    project_id: Option<String>,
    parent: Option<CardRelationshipSummary>,
    child_count: u64,
    children: Vec<CardRelationshipSummary>,
    hierarchy_finalized: bool,
    environment: Option<CardEnvironment>,
    creation_operation: Option<EnvironmentCreationOperation>,
    cleanup_operation: Option<CardCleanupOperation>,
    created_at: i64,
    updated_at: i64,
    sort_order: i64,
    in_scope: bool,
    events: Vec<CardEvent>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RuntimeResourceOutcome {
    resource_type: String,
    id: String,
    success: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CardRuntimeCleanupResult {
    card: KanbanCard,
    outcomes: Vec<RuntimeResourceOutcome>,
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

#[derive(Debug, Serialize)]
pub struct KanbanPullRequestRefreshResult {
    card: KanbanCard,
    error: Option<String>,
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
    let projects = connection
        .prepare("SELECT id, COALESCE(kanban_source, 'local') FROM projects ORDER BY id")
        .map_err(db_error)?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(db_error)?;
    let superthread_ids = projects
        .iter()
        .filter_map(|(id, source)| (source == "superthread").then(|| id.clone()))
        .collect::<Vec<_>>();
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
        let source = projects.get(&owner).map(String::as_str);
        let compatible = matches!(
            (provider.as_str(), source),
            ("superthread", Some("superthread"))
        ) || (provider.starts_with("local:") && source == Some("local"));
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

#[derive(Default)]
struct CardRuntimeTargets {
    pi: HashSet<String>,
    pty: HashSet<String>,
}

fn persisted_runtime_targets(
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

fn commit_card_close(
    connection: &mut Connection,
    id: &str,
    expected_revision: i64,
) -> Result<CardRuntimeTargets, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let (status, revision, finalized): (String, i64, bool) = transaction
        .query_row(
            "SELECT status, workflow_revision, hierarchy_finalized FROM kanban_cards WHERE id=?1",
            [id],
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
    let targets = persisted_runtime_targets(&transaction, id)?;
    let now = unix_timestamp();
    let changed = transaction.execute(
        "UPDATE kanban_cards SET status='done', completion_outcome='closed', delivery_operation_stage=NULL, delivery_error=NULL,
         runtime_cleanup_status='pending', runtime_cleanup_error=NULL, workflow_revision=workflow_revision+1, updated_at=?1,
         sort_order=(SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards AS destination WHERE destination.status='done')
         WHERE id=?2 AND workflow_revision=?3 AND status!='done'", params![now, id, expected_revision],
    ).map_err(db_error)?;
    if changed != 1 {
        return Err("Card changed; reload before closing".to_string());
    }
    transaction.execute(
        "INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, from_status, to_status, summary)
         VALUES (?1, ?2, 'user', 'close', 'success', ?3, 'done', 'Closed without delivery; runtime cleanup pending')",
        params![id, now, status],
    ).map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    Ok(targets)
}

fn execute_runtime_cleanup<StopPi, DeletePi, StopPty>(
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

fn run_runtime_cleanup(
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

fn persist_runtime_cleanup_result(
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

fn finish_runtime_cleanup(
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

#[tauri::command]
pub fn kanban_close_card(
    id: String,
    expected_revision: i64,
    pi_registry: State<'_, Mutex<PiRpcRegistry>>,
    pty_registry: State<'_, Mutex<PtyRegistry>>,
) -> Result<CardRuntimeCleanupResult, String> {
    let targets =
        with_connection(|connection| commit_card_close(connection, &id, expected_revision))?;
    finish_runtime_cleanup(&id, targets, pi_registry.inner(), pty_registry.inner())
}

#[tauri::command]
pub fn kanban_retry_runtime_cleanup(
    id: String,
    pi_registry: State<'_, Mutex<PiRpcRegistry>>,
    pty_registry: State<'_, Mutex<PtyRegistry>>,
) -> Result<CardRuntimeCleanupResult, String> {
    let targets = with_connection(|connection| {
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct WorktreeEvidence {
    path: String,
    branch: Option<String>,
    revision: Option<String>,
}

#[derive(Debug, Clone)]
struct CreationOperationRow {
    card_id: String,
    project_id: String,
    repository_id: String,
    expected_workflow_revision: i64,
    target_checkout_path: String,
    target_branch: String,
    observed_target_revision: String,
    setup_command: String,
    custom_command: bool,
    phase: String,
    attempt_token: Option<String>,
    result_path: String,
    pre_worktrees: String,
    pre_branches: String,
    setup_result_cwd: Option<String>,
    source_path: Option<String>,
    source_branch: Option<String>,
    source_revision: Option<String>,
    source_worktree_new: bool,
    source_branch_new: bool,
    worktree_removed: bool,
}

fn worktree_inventory(target: &str) -> Result<Vec<WorktreeEvidence>, String> {
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

fn branch_inventory(target: &str) -> Result<BTreeMap<String, String>, String> {
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

fn load_creation_operation_row(
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

fn update_creation_phase(
    card_id: &str,
    phase: &str,
    error: Option<&str>,
    cleanup_available: bool,
) -> Result<(), String> {
    with_connection(|connection| {
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let changed = tx.execute("UPDATE environment_creation_operations SET phase=?1,error=?2,cleanup_available=?3,revision=revision+1,updated_at=?4 WHERE card_id=?5", params![phase,error,cleanup_available as i64,unix_timestamp(),card_id]).map_err(db_error)?;
        if changed != 1 {
            return Err("Environment creation operation disappeared".to_string());
        }
        tx.commit().map_err(db_error)
    })
}

fn prepare_creation_operation(
    id: &str,
    expected_revision: i64,
    setup_command: &str,
    custom_command: bool,
) -> Result<CreationOperationRow, String> {
    if setup_command.trim().is_empty() {
        return Err("Setup command cannot be empty".to_string());
    }
    let (project_id, project_path, configured_branch) = with_connection(|connection| {
        crate::store::migrate_store_schema(connection)?;
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
    with_connection(|connection| {
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
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
    with_connection(|connection| load_creation_operation_row(connection, id))?
        .ok_or_else(|| "Could not reload environment creation operation".to_string())
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

fn persist_validated_source(
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
    with_connection(|connection| {
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        tx.execute("UPDATE environment_creation_operations SET phase='setup_complete',post_worktrees=?1,post_branches=?2,source_path=?3,source_branch=?4,source_revision=?5,source_worktree_new=?6,source_branch_new=?7,error=NULL,cleanup_available=?8,revision=revision+1,updated_at=?9 WHERE card_id=?10",
            params![serde_json::to_string(&post_worktrees).map_err(|e| e.to_string())?,serde_json::to_string(&post_branches).map_err(|e| e.to_string())?,source.target_checkout_path,source.target_branch,source.target_revision,worktree_new as i64,branch_new as i64,worktree_new as i64,unix_timestamp(),op.card_id]).map_err(db_error)?;
        tx.commit().map_err(db_error)
    })?;
    with_connection(|connection| load_creation_operation_row(connection, &op.card_id))?
        .ok_or_else(|| "Could not reload validated environment operation".to_string())
}

fn creation_recovery(
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
    with_connection(|connection| {
        connection.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,error_code,error_detail) VALUES (?1,?2,'system','environment_start','failure','recovery_required',?3)", params![card_id,unix_timestamp(),detail]).map_err(db_error)?;
        get_card(connection, card_id)?.ok_or_else(|| "Kanban card was not found".to_string())
    })
}

fn compensate_creation(op: &CreationOperationRow) -> Result<KanbanCard, String> {
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
        with_connection(|connection| {
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
    with_connection(|connection| {
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
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

fn setup_process_alive(result_path: &str) -> bool {
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

fn run_environment_creation(
    id: String,
    expected_workflow_revision: i64,
    setup_command: String,
    custom_command: bool,
    explicit_retry: bool,
    cancelled: &AtomicBool,
) -> Result<KanbanCard, String> {
    if let Some(card) = with_connection(|connection| get_card(connection, &id))? {
        if card.environment.is_some() {
            with_connection(|connection| validate_card_environment_project(connection, &id))?;
            return Ok(card);
        }
    }
    let mut op = match with_connection(|connection| load_creation_operation_row(connection, &id))? {
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
    let current_project = with_connection(|connection| {
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
            return with_connection(|connection| get_card(connection, &id))?
                .ok_or_else(|| "Kanban card was not found".to_string());
        }
    }
    if op.phase == "recovery_required" {
        if Path::new(&op.result_path).is_file() {
            let cwd = fs::read_to_string(&op.result_path)
                .map_err(|e| e.to_string())?
                .trim()
                .to_string();
            with_connection(|connection| {
                connection.execute("UPDATE environment_creation_operations SET phase='setup_complete',setup_result_cwd=?1,error=NULL,revision=revision+1,updated_at=?2 WHERE card_id=?3", params![cwd,unix_timestamp(),id]).map(|_| ()).map_err(db_error)
            })?;
            op = with_connection(|connection| load_creation_operation_row(connection, &id))?
                .unwrap();
        } else {
            if !explicit_retry {
                return with_connection(|connection| get_card(connection, &id))?
                    .ok_or_else(|| "Kanban card was not found".to_string());
            }
            if setup_process_alive(&op.result_path) {
                return with_connection(|connection| get_card(connection, &id))?
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
                with_connection(|connection| {
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
        with_connection(|connection| {
            connection.execute("UPDATE environment_creation_operations SET phase='setup_running',attempt_token=?1,error=NULL,revision=revision+1,updated_at=?2 WHERE card_id=?3 AND phase='prepared'", params![token,unix_timestamp(),id]).map(|_| ()).map_err(db_error)
        })?;
        match run_workspace_setup_durable(
            op.setup_command.clone(),
            op.target_checkout_path.clone(),
            cancelled,
            Path::new(&op.result_path),
        ) {
            Ok(result) => {
                with_connection(|connection| {
                    connection.execute("UPDATE environment_creation_operations SET phase='setup_complete',setup_result_cwd=?1,setup_output=?2,revision=revision+1,updated_at=?3 WHERE card_id=?4", params![result.cwd,result.output,unix_timestamp(),id]).map(|_| ()).map_err(db_error)
                })?;
            }
            Err(error) => {
                update_creation_phase(&id, "compensation_pending", Some(&error), false)?;
                op = with_connection(|connection| load_creation_operation_row(connection, &id))?
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
        op = with_connection(|connection| load_creation_operation_row(connection, &id))?.unwrap();
    } else if op.phase == "setup_running" {
        if Path::new(&op.result_path).is_file() {
            let cwd = fs::read_to_string(&op.result_path)
                .map_err(|e| e.to_string())?
                .trim()
                .to_string();
            with_connection(|connection| {
                connection.execute("UPDATE environment_creation_operations SET phase='setup_complete',setup_result_cwd=?1,revision=revision+1,updated_at=?2 WHERE card_id=?3", params![cwd,unix_timestamp(),id]).map(|_| ()).map_err(db_error)
            })?;
            op = with_connection(|connection| load_creation_operation_row(connection, &id))?
                .unwrap();
        } else if setup_process_alive(&op.result_path) {
            update_creation_phase(
                &id,
                "setup_running",
                Some("Setup is still running in the background. Resume after it finishes."),
                false,
            )?;
            return with_connection(|connection| get_card(connection, &id))?
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
            op = with_connection(|connection| load_creation_operation_row(connection, &id))?
                .unwrap();
            compensate_creation(&op)
        }
    }
}

#[tauri::command]
pub async fn kanban_start_environment(
    state: State<'_, WorkspaceSetupState>,
    id: String,
    expected_workflow_revision: i64,
    setup_command: String,
    custom_command: bool,
    explicit_retry: Option<bool>,
) -> Result<KanbanCard, String> {
    let cancelled = state.begin();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = REPOSITORY_OPERATION_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| "Repository operation lock failed".to_string())?;
        run_environment_creation(
            id,
            expected_workflow_revision,
            setup_command,
            custom_command,
            explicit_retry.unwrap_or(false),
            &cancelled,
        )
    })
    .await
    .map_err(|error| format!("Environment creation worker failed: {error}"))?
}

#[tauri::command]
pub async fn kanban_cleanup_environment_creation(id: String) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = REPOSITORY_OPERATION_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| "Repository operation lock failed".to_string())?;
        let op = with_connection(|connection| load_creation_operation_row(connection, &id))?
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
    .await
    .map_err(|error| format!("Environment cleanup worker failed: {error}"))?
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
fn kanban_create_environment(
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
    let project_path_snapshot = with_connection(|connection| {
        crate::store::migrate_store_schema(connection)?;
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
        transaction.execute(
            "UPDATE kanban_cards SET project_id = ?1, workspace_id = NULL, status = 'agent_working', workflow_revision = workflow_revision + 1, updated_at = ?2,
             sort_order = (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards AS destination WHERE destination.status = 'agent_working') WHERE id = ?3",
            params![project_id, now, id],
        ).map_err(db_error)?;
        transaction.execute("INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, from_status, to_status, summary) VALUES (?1, ?2, 'user', 'environment_start', 'success', 'ready', 'agent_working', ?3)",
            params![id, now, format!("Created source worktree {} on {}", worktree_path, source.target_branch)]).map_err(db_error)?;
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

#[derive(Debug, Clone, Serialize)]
pub struct TargetMergePrepareResult {
    operation_id: Option<String>,
    state: String,
    card: KanbanCard,
    message: String,
    idempotent: bool,
}

#[derive(Debug, Clone)]
struct TargetMergeOperation {
    id: String,
    card_id: String,
    environment_id: String,
    workflow_revision: i64,
    environment_revision: i64,
    initial_status: String,
    source_path: String,
    source_revision: String,
    target_revision: String,
    phase: String,
    conflict_paths: Vec<String>,
}

fn load_target_merge_operation(
    connection: &Connection,
    card_id: &str,
) -> Result<Option<TargetMergeOperation>, String> {
    connection.query_row(
        "SELECT id,card_id,environment_id,workflow_revision,environment_revision,initial_status,source_path,source_revision,target_revision,phase,conflict_paths FROM card_target_merge_operations WHERE card_id=?1",
        [card_id],
        |row| Ok(TargetMergeOperation {
            id: row.get(0)?, card_id: row.get(1)?, environment_id: row.get(2)?, workflow_revision: row.get(3)?,
            environment_revision: row.get(4)?, initial_status: row.get(5)?, source_path: row.get(6)?,
            source_revision: row.get(7)?, target_revision: row.get(8)?, phase: row.get(9)?,
            conflict_paths: serde_json::from_str::<Vec<String>>(&row.get::<_, String>(10)?).unwrap_or_default(),
        }),
    ).optional().map_err(db_error)
}

fn current_target_merge_result(
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
            "The target merge has conflicts that need the work agent"
        } else {
            "The target was merged and is ready for verification"
        }
        .to_string(),
        idempotent: false,
    })
}

#[tauri::command]
pub async fn kanban_prepare_target_merge(
    id: String,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
) -> Result<TargetMergePrepareResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = REPOSITORY_OPERATION_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| "Repository operation lock failed".to_string())?;
        with_connection(|connection| {
            prepare_target_merge(
                connection,
                &id,
                expected_workflow_revision,
                expected_environment_revision,
            )
        })
    })
    .await
    .map_err(|error| format!("Target merge worker failed: {error}"))?
}

fn prepare_target_merge(
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
        .transaction_with_behavior(TransactionBehavior::Immediate)
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
    if !matches!(status.as_str(), "needs_human" | "approved") {
        return Err("Only a Needs you or Ready to merge card can merge in its target".to_string());
    }
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

    let remote_key = format!("branch.{target_branch}.remote");
    let merge_key = format!("branch.{target_branch}.merge");
    let remote = git_output(&source_path, &["config", "--get", &remote_key]).map_err(|_| format!("Target branch {target_branch} has no upstream remote. Configure it with: git branch --set-upstream-to <remote>/<branch> {target_branch}"))?;
    let merge_ref = git_output(&source_path, &["config", "--get", &merge_key]).map_err(|_| format!("Target branch {target_branch} has no upstream tracking ref. Configure it with: git branch --set-upstream-to <remote>/<branch> {target_branch}"))?;
    if remote.trim().is_empty() || remote == "." || !merge_ref.starts_with("refs/heads/") {
        return Err(format!("Target branch {target_branch} has an invalid fetchable upstream ({remote}, {merge_ref}). Configure a remote-tracking upstream before retrying"));
    }
    let fetch = Command::new("git")
        .args([
            "-C",
            &source_path,
            "fetch",
            "--no-tags",
            &remote,
            &merge_ref,
        ])
        .output()
        .map_err(|error| format!("Could not fetch target upstream {remote}: {error}"))?;
    if !fetch.status.success() {
        let detail = String::from_utf8_lossy(&fetch.stderr).trim().to_string();
        return Err(format!("Could not fetch {remote} for target branch {target_branch}. Check network access and authentication, then retry. {detail}"));
    }
    let source_revision = git_output(&source_path, &["rev-parse", "HEAD"])?;
    let target_revision = git_output(&source_path, &["rev-parse", "FETCH_HEAD"])?;
    if git_status_success(
        &source_path,
        &["merge-base", "--is-ancestor", &target_revision, "HEAD"],
    )? {
        let now = unix_timestamp();
        transaction.execute("UPDATE card_environments SET source_revision=?1,target_revision=?2,revision=revision+1,updated_at=?3 WHERE id=?4 AND revision=?5", params![source_revision,target_revision,now,environment_id,expected_environment]).map_err(db_error)?;
        transaction.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,from_status,to_status,summary) VALUES (?1,?2,'user','merge_target','success',?3,?3,'Fetched target revision was already contained in the source branch')", params![id,now,status]).map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        return Ok(TargetMergePrepareResult {
            operation_id: None,
            state: "noop".into(),
            card: get_card(connection, id)?
                .ok_or_else(|| "Kanban card was not found".to_string())?,
            message: format!("{target_branch} is already contained in {source_branch}"),
            idempotent: true,
        });
    }
    let operation_id = uuid::Uuid::new_v4().to_string();
    let now = unix_timestamp();
    transaction.execute("INSERT INTO card_target_merge_operations (id,card_id,environment_id,workflow_revision,environment_revision,initial_status,repository_id,source_path,source_branch,target_branch,upstream_remote,upstream_merge_ref,source_revision,target_revision,phase,conflict_paths,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'merged','[]',?15,?15)", params![operation_id,id,environment_id,expected_card,expected_environment,status,repository_id,source_path,source_branch,target_branch,remote,merge_ref,source_revision,target_revision,now]).map_err(db_error)?;
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

#[tauri::command]
pub async fn kanban_finalize_target_merge(
    id: String,
    operation_id: String,
) -> Result<WorkflowOperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = REPOSITORY_OPERATION_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| "Repository operation lock failed".to_string())?;
        with_connection(|connection| finalize_target_merge(connection, &id, &operation_id))
    })
    .await
    .map_err(|error| format!("Target merge finalization worker failed: {error}"))?
}

fn finalize_target_merge(
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
        return Err(
            "The exact fetched target revision is not contained in the source branch".to_string(),
        );
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
        .transaction_with_behavior(TransactionBehavior::Immediate)
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
    let now = unix_timestamp();
    transaction.execute("UPDATE card_environments SET source_revision=?1,target_revision=?2,revision=revision+1,updated_at=?3 WHERE id=?4 AND revision=?5", params![head,operation.target_revision,now,operation.environment_id,operation.environment_revision]).map_err(db_error)?;
    transaction.execute("UPDATE kanban_cards SET status='needs_human',delivery_error=NULL,workflow_revision=workflow_revision+1,updated_at=?1,sort_order=CASE WHEN status='needs_human' THEN sort_order ELSE (SELECT COALESCE(MAX(sort_order),-1)+1 FROM kanban_cards d WHERE d.status='needs_human') END WHERE id=?2 AND workflow_revision=?3", params![now,card_id,current_revision]).map_err(db_error)?;
    transaction.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,from_status,to_status,summary) VALUES (?1,?2,'user','merge_target','success',?3,'needs_human','Fetched target revision merged with an explicit merge commit')", params![card_id,now,operation.initial_status]).map_err(db_error)?;
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
        message: "Merged the latest target into the card branch; review it before Ship It"
            .to_string(),
        idempotent: false,
    })
}

#[tauri::command]
pub async fn kanban_abort_target_merge(
    id: String,
    operation_id: String,
) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = REPOSITORY_OPERATION_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| "Repository operation lock failed".to_string())?;
        with_connection(|connection| abort_target_merge(connection, &id, &operation_id))
    })
    .await
    .map_err(|error| format!("Target merge recovery worker failed: {error}"))?
}

fn changed_paths(path: &str) -> Result<Vec<String>, String> {
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

fn abort_target_merge(
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

const CLEANUP_PHASES: [&str; 7] = [
    "runtime_sessions",
    "validate_repository",
    "remove_worktree",
    "delete_local_branch",
    "delete_remote_branch",
    "remove_metadata",
    "record_completion",
];

#[derive(Debug, Clone)]
struct CleanupSnapshot {
    card_id: String,
    environment_id: String,
    workflow_revision: i64,
    environment_revision: i64,
    status: String,
    phase: String,
    completion_outcome: String,
    repository_id: String,
    source_path: String,
    target_path: String,
    source_branch: String,
    target_branch: String,
    source_revision: String,
    delete_local_branch: bool,
    delete_remote_branch: bool,
    merged_pr_head_revision: Option<String>,
    pane_ids: Vec<(String, String)>,
    registration_validated: bool,
}

#[tauri::command]
pub async fn kanban_cleanup_environment(
    app: AppHandle,
    id: String,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pty_registry = app.state::<Mutex<PtyRegistry>>();
        let pi_registry = app.state::<Mutex<PiRpcRegistry>>();
        run_cleanup(
            &id,
            expected_workflow_revision,
            expected_environment_revision,
            pty_registry.inner(),
            pi_registry.inner(),
        )
    })
    .await
    .map_err(|error| format!("Cleanup worker failed: {error}"))?
}

fn run_cleanup(
    id: &str,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
    pty_registry: &Mutex<PtyRegistry>,
    pi_registry: &Mutex<PiRpcRegistry>,
) -> Result<KanbanCard, String> {
    let _guard = REPOSITORY_OPERATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Repository operation lock failed".to_string())?;
    initialize_cleanup(
        id,
        expected_workflow_revision,
        expected_environment_revision,
    )?;
    loop {
        let operation = with_connection(|connection| load_cleanup_snapshot(connection, id))?;
        if operation.status == "completed" {
            return with_connection(|connection| {
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
}

fn initialize_cleanup(
    card_id: &str,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
) -> Result<(), String> {
    with_connection(|connection| {
        if connection
            .query_row(
                "SELECT COUNT(*) FROM card_cleanup_operations WHERE card_id=?1",
                [card_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(db_error)?
            > 0
        {
            return Ok(());
        }
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let (status, outcome, workflow_revision, delivery_stage): (String, Option<String>, i64, Option<String>) = transaction.query_row(
            "SELECT status, completion_outcome, workflow_revision, delivery_operation_stage FROM kanban_cards WHERE id=?1", [card_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).map_err(db_error)?;
        if status != "done" {
            return Err("Only a Done card environment can be cleaned up".to_string());
        }
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
        let (environment_id, _project_id, source_path, source_branch, repository_id, target_path, target_branch, source_revision, target_revision, environment_revision): (String, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, i64) = transaction.query_row(
            "SELECT id, project_id, worktree_path, branch, repository_id, target_checkout_path, target_branch, source_revision, target_revision, revision FROM card_environments WHERE card_id=?1", [card_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?)),
        ).map_err(db_error)?;
        if environment_revision != expected_environment_revision {
            return Err("Card environment changed; reload before cleanup".to_string());
        }
        let repository_id = repository_id
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Cleanup requires a recorded repository identity".to_string())?;
        let target_path =
            target_path.ok_or_else(|| "Cleanup requires a recorded target checkout".to_string())?;
        let target_branch =
            target_branch.ok_or_else(|| "Cleanup requires a recorded target branch".to_string())?;
        let source_revision = source_revision
            .ok_or_else(|| "Cleanup requires a recorded source revision".to_string())?;
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
        transaction.execute(
            "INSERT INTO card_cleanup_operations (card_id,environment_id,workflow_revision,environment_revision,status,phase,completion_outcome,repository_id,source_path,target_path,source_branch,target_branch,source_revision,target_revision,delete_local_branch,delete_remote_branch,merged_pr_repository,merged_pr_number,merged_pr_head_revision,pane_ids,started_at,updated_at)
             VALUES (?1,?2,?3,?4,'pending','runtime_sessions',?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?19)",
            params![card_id, environment_id, workflow_revision, environment_revision, outcome, repository_id, source_path, target_path, source_branch, target_branch, source_revision, target_revision, (outcome == "merged") as i64, (delivery_stage.as_deref() == Some("deleting_remote_branch")) as i64, pr_repository, pr_number, pr_head, pane_ids, now],
        ).map_err(db_error)?;
        transaction.execute("UPDATE card_environments SET lifecycle_state='cleanup_pending', updated_at=?1 WHERE id=?2", params![now, environment_id]).map_err(db_error)?;
        transaction.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,summary) VALUES (?1,?2,'user','cleanup_started','success','Cleanup intent and safety snapshot recorded')", params![card_id, now]).map_err(db_error)?;
        transaction.commit().map_err(db_error)
    })
}

fn load_cleanup_snapshot(
    connection: &Connection,
    card_id: &str,
) -> Result<CleanupSnapshot, String> {
    connection.query_row(
        "SELECT card_id,environment_id,workflow_revision,environment_revision,status,phase,completion_outcome,repository_id,source_path,target_path,source_branch,target_branch,source_revision,delete_local_branch,delete_remote_branch,merged_pr_head_revision,pane_ids,registration_validated FROM card_cleanup_operations WHERE card_id=?1",
        [card_id], |row| {
            let pane_json: String = row.get(16)?;
            Ok(CleanupSnapshot {
                card_id: row.get(0)?, environment_id: row.get(1)?, workflow_revision: row.get(2)?, environment_revision: row.get(3)?,
                status: row.get(4)?, phase: row.get(5)?, completion_outcome: row.get(6)?, repository_id: row.get(7)?,
                source_path: row.get(8)?, target_path: row.get(9)?, source_branch: row.get(10)?, target_branch: row.get(11)?, source_revision: row.get(12)?,
                delete_local_branch: row.get::<_, i64>(13)? != 0, delete_remote_branch: row.get::<_, i64>(14)? != 0,
                merged_pr_head_revision: row.get(15)?, pane_ids: serde_json::from_str(&pane_json).unwrap_or_default(), registration_validated: row.get::<_, i64>(17)? != 0,
            })
        },
    ).map_err(db_error)
}

fn execute_cleanup_phase(
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

fn cleanup_runtime_sessions(
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

fn validate_cleanup_repository(operation: &CleanupSnapshot) -> Result<(), String> {
    let target = validate_target_checkout(&operation.target_path, Some(&operation.repository_id))?;
    if target.target_branch != operation.target_branch {
        return Err(format!(
            "Target checkout is on {}, expected {}",
            target.target_branch, operation.target_branch
        ));
    }
    let source = validate_checkout(&operation.source_path, Some(&operation.repository_id))?;
    if source.target_checkout_path == target.target_checkout_path {
        return Err("Cleanup refuses to remove the primary checkout".to_string());
    }
    if source.target_branch != operation.source_branch {
        return Err(format!(
            "Source checkout is on {}, expected {}",
            source.target_branch, operation.source_branch
        ));
    }
    if source.target_revision != operation.source_revision {
        return Err("Source branch tip changed after cleanup intent was recorded".to_string());
    }
    ensure_registered_distinct_worktree(&operation.target_path, &operation.source_path)?;
    match local_ref_tip(&operation.target_path, &operation.source_branch)? {
        Some(tip) if tip == operation.source_revision => {}
        Some(_) => {
            return Err("Source branch tip changed after cleanup intent was recorded".to_string())
        }
        None => {
            return Err("The recorded source branch is absent before worktree removal".to_string())
        }
    }
    if operation.completion_outcome == "merged"
        && operation.merged_pr_head_revision.as_deref() != Some(&operation.source_revision)
    {
        let merged = git_status_success(
            &operation.target_path,
            &[
                "merge-base",
                "--is-ancestor",
                &operation.source_revision,
                "HEAD",
            ],
        )?;
        if !merged {
            return Err(
                "Source revision is not merged and no matching merged-PR evidence was recorded"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn remove_cleanup_worktree(operation: &CleanupSnapshot) -> Result<(), String> {
    if Path::new(&operation.source_path).exists() {
        // Repeat the complete safety check immediately before the destructive
        // command; the worktree may have changed after the validation phase.
        validate_cleanup_repository(operation)?;
        let output = Command::new("git")
            .args([
                "-C",
                &operation.target_path,
                "worktree",
                "remove",
                "--",
                &operation.source_path,
            ])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "Git could not remove the source worktree: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        return Ok(());
    }
    if !operation.registration_validated {
        return Err(
            "Source worktree is absent without persisted successful registration validation"
                .to_string(),
        );
    }
    validate_cleanup_target(operation).map_err(|error| {
        format!("Target checkout changed while reconciling worktree removal: {error}")
    })?;
    match local_ref_tip(&operation.target_path, &operation.source_branch)? {
        Some(tip) if tip == operation.source_revision => Ok(()),
        Some(_) => Err("Source branch tip changed while reconciling worktree removal".to_string()),
        None if !operation.delete_local_branch => Ok(()),
        None => Err("Source branch disappeared before its deletion phase".to_string()),
    }
}

fn delete_cleanup_local_branch(operation: &CleanupSnapshot) -> Result<(), String> {
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

fn delete_cleanup_remote_branch(operation: &CleanupSnapshot) -> Result<(), String> {
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

fn validate_cleanup_target(operation: &CleanupSnapshot) -> Result<(), String> {
    let target = validate_target_checkout(&operation.target_path, Some(&operation.repository_id))?;
    if target.target_branch != operation.target_branch {
        return Err(format!(
            "Target checkout is on {}, expected {}",
            target.target_branch, operation.target_branch
        ));
    }
    Ok(())
}

fn local_ref_tip(path: &str, branch: &str) -> Result<Option<String>, String> {
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

fn remove_cleanup_metadata(operation: &CleanupSnapshot) -> Result<(), String> {
    with_connection(|connection| {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
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
            let updated = transaction.execute("UPDATE kanban_cards SET workflow_revision=workflow_revision+1,updated_at=?1 WHERE id=?2 AND workflow_revision=?3", params![unix_timestamp(), operation.card_id, operation.workflow_revision]).map_err(db_error)?;
            if updated == 0 {
                return Err("Card changed before cleanup metadata removal".to_string());
            }
        }
        transaction.commit().map_err(db_error)
    })
}

fn advance_cleanup_phase(operation: &CleanupSnapshot) -> Result<(), String> {
    with_connection(|connection| advance_cleanup_phase_in_connection(connection, operation))
}

fn advance_cleanup_phase_in_connection(
    connection: &mut Connection,
    operation: &CleanupSnapshot,
) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    if operation.phase == "record_completion" {
        let now = unix_timestamp();
        let changed = transaction.execute("UPDATE card_cleanup_operations SET status='completed',error_code=NULL,error_detail=NULL,completed_at=?1,updated_at=?1 WHERE card_id=?2 AND phase=?3 AND status!='completed'", params![now, operation.card_id, operation.phase]).map_err(db_error)?;
        if changed == 0 {
            return Err("Cleanup operation changed while recording completion".to_string());
        }
        transaction.execute("UPDATE kanban_cards SET delivery_operation_stage=NULL,delivery_error=NULL WHERE id=?1", [&operation.card_id]).map_err(db_error)?;
        transaction.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,summary) VALUES (?1,?2,'user','cleanup','success',?3)", params![operation.card_id, now, if operation.completion_outcome == "closed" { "Removed source worktree and retained branches" } else { "Cleanup completed and safely deleted required branches" }]).map_err(db_error)?;
    } else {
        let next = next_cleanup_phase(&operation.phase)
            .ok_or_else(|| "Unknown or terminal cleanup phase".to_string())?;
        let now = unix_timestamp();
        let validation = (operation.phase == "validate_repository") as i64;
        let changed = transaction.execute("UPDATE card_cleanup_operations SET status='pending',phase=?1,error_code=NULL,error_detail=NULL,registration_validated=CASE WHEN ?2=1 THEN 1 ELSE registration_validated END,validation_completed_at=CASE WHEN ?2=1 THEN ?3 ELSE validation_completed_at END,updated_at=?3 WHERE card_id=?4 AND phase=?5 AND status!='completed'", params![next, validation, now, operation.card_id, operation.phase]).map_err(db_error)?;
        if changed == 0 {
            return Err("Cleanup operation changed while advancing its phase".to_string());
        }
        transaction.execute("UPDATE card_environments SET lifecycle_state='cleanup_pending',updated_at=?1 WHERE id=?2", params![now, operation.environment_id]).map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)
}

fn next_cleanup_phase(phase: &str) -> Option<&'static str> {
    let index = CLEANUP_PHASES
        .iter()
        .position(|candidate| *candidate == phase)?;
    CLEANUP_PHASES.get(index + 1).copied()
}

fn cleanup_error_code(phase: &str, _detail: &str) -> String {
    format!("cleanup_{}_failed", phase)
}

fn record_cleanup_failure(card_id: &str, phase: &str, code: &str, detail: &str) {
    let _ = with_connection(|connection| {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        transaction.execute("UPDATE card_cleanup_operations SET status='failed',error_code=?1,error_detail=?2,updated_at=?3 WHERE card_id=?4 AND phase=?5", params![code, detail, unix_timestamp(), card_id, phase]).map_err(db_error)?;
        transaction.execute("UPDATE card_environments SET lifecycle_state='cleanup_failed',updated_at=?1 WHERE card_id=?2", params![unix_timestamp(), card_id]).map_err(db_error)?;
        transaction.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,summary,error_code,error_detail) VALUES (?1,?2,'user','cleanup','failure',?3,?4,?5)", params![card_id, unix_timestamp(), format!("Cleanup failed during {phase}"), code, detail]).map_err(db_error)?;
        transaction.commit().map_err(db_error)
    });
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
pub async fn kanban_refresh_pull_request(
    id: String,
) -> Result<KanbanPullRequestRefreshResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let refresh_result = with_connection(|connection| refresh_pull_request(connection, &id));
        let error = refresh_result.err();
        if let Some(detail) = &error {
            record_operation_failure(&id, "refresh_pr", "refresh_pr_failed", detail);
        }
        let card = with_connection(|connection| {
            get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
        })?;
        Ok(KanbanPullRequestRefreshResult { card, error })
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

pub(crate) fn initialize_database() -> Result<(), String> {
    initialize_once(&DATABASE_INITIALIZATION, || {
        let path = app_data_file("workflow.sqlite3")
            .map_err(|error| format!("Could not locate the Kanban database: {error}"))?;
        let mut connection = Connection::open(&path).map_err(|error| {
            format!(
                "Could not open the Kanban database at {}: {error}",
                path.display()
            )
        })?;
        configure_connection(&connection)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| format!("Could not enable WAL mode: {error}"))?;
        initialize_connection(&mut connection, true)
    })
}

fn initialize_once(
    state: &OnceLock<Result<(), String>>,
    initialize: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    state.get_or_init(initialize).clone()
}

fn initialize_connection(
    connection: &mut Connection,
    import_legacy_json: bool,
) -> Result<(), String> {
    migrate(connection).map_err(|error| format!("Could not initialize Kanban schema: {error}"))?;
    crate::store::migrate_store_schema(connection)
        .map_err(|error| format!("Could not initialize project-store schema: {error}"))?;
    crate::project_direct::migrate(connection)
        .map_err(|error| format!("Could not initialize Direct-work schema: {error}"))?;
    crate::store::migrate_legacy_data(connection, import_legacy_json)
        .map_err(|error| format!("Could not initialize legacy project data: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("Could not re-enable database foreign keys: {error}"))?;
    let foreign_keys: i64 = connection
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .map_err(db_error)?;
    if foreign_keys != 1 {
        return Err("Database initialization completed without foreign keys enabled".to_string());
    }
    Ok(())
}

fn configure_connection(connection: &Connection) -> Result<(), String> {
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| format!("Could not configure the database busy timeout: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("Could not enable database foreign keys: {error}"))
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
    configure_connection(&connection)?;
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
        "CREATE TABLE IF NOT EXISTS schema_migrations (
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
            runtime_cleanup_status TEXT CHECK(runtime_cleanup_status IN ('pending', 'complete', 'failed')),
            runtime_cleanup_error TEXT,
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
         CREATE TABLE IF NOT EXISTS environment_creation_operations (
            id TEXT PRIMARY KEY,
            card_id TEXT NOT NULL UNIQUE REFERENCES kanban_cards(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL,
            repository_id TEXT NOT NULL,
            expected_workflow_revision INTEGER NOT NULL,
            target_checkout_path TEXT NOT NULL,
            target_branch TEXT NOT NULL,
            observed_target_revision TEXT NOT NULL,
            setup_command TEXT NOT NULL,
            custom_command INTEGER NOT NULL DEFAULT 0,
            phase TEXT NOT NULL CHECK(phase IN ('prepared','setup_running','setup_complete','attaching','compensation_pending','recovery_required')),
            attempt_token TEXT,
            result_path TEXT NOT NULL,
            pre_worktrees TEXT NOT NULL,
            pre_branches TEXT NOT NULL,
            post_worktrees TEXT,
            post_branches TEXT,
            setup_result_cwd TEXT,
            setup_output TEXT,
            source_path TEXT,
            source_branch TEXT,
            source_revision TEXT,
            source_worktree_new INTEGER NOT NULL DEFAULT 0,
            source_branch_new INTEGER NOT NULL DEFAULT 0,
            worktree_removed INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            cleanup_available INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS card_target_merge_operations (
            id TEXT PRIMARY KEY,
            card_id TEXT NOT NULL UNIQUE REFERENCES kanban_cards(id) ON DELETE CASCADE,
            environment_id TEXT NOT NULL,
            workflow_revision INTEGER NOT NULL,
            environment_revision INTEGER NOT NULL,
            initial_status TEXT NOT NULL CHECK(initial_status IN ('needs_human','approved')),
            repository_id TEXT NOT NULL,
            source_path TEXT NOT NULL,
            source_branch TEXT NOT NULL,
            target_branch TEXT NOT NULL,
            upstream_remote TEXT NOT NULL,
            upstream_merge_ref TEXT NOT NULL,
            source_revision TEXT NOT NULL,
            target_revision TEXT NOT NULL,
            phase TEXT NOT NULL CHECK(phase IN ('conflicted','merged')),
            conflict_paths TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS card_cleanup_operations (
            card_id TEXT PRIMARY KEY REFERENCES kanban_cards(id) ON DELETE CASCADE,
            environment_id TEXT NOT NULL,
            workflow_revision INTEGER NOT NULL,
            environment_revision INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending', 'failed', 'completed')),
            phase TEXT NOT NULL,
            completion_outcome TEXT NOT NULL CHECK(completion_outcome IN ('merged', 'closed')),
            repository_id TEXT NOT NULL,
            source_path TEXT NOT NULL,
            target_path TEXT NOT NULL,
            source_branch TEXT NOT NULL,
            target_branch TEXT NOT NULL,
            source_revision TEXT NOT NULL,
            target_revision TEXT,
            delete_local_branch INTEGER NOT NULL,
            delete_remote_branch INTEGER NOT NULL,
            merged_pr_repository TEXT,
            merged_pr_number INTEGER,
            merged_pr_head_revision TEXT,
            pane_ids TEXT NOT NULL DEFAULT '[]',
            registration_validated INTEGER NOT NULL DEFAULT 0,
            validation_completed_at INTEGER,
            error_code TEXT,
            error_detail TEXT,
            started_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER
         );
         CREATE TRIGGER IF NOT EXISTS card_cleanup_snapshot_immutable BEFORE UPDATE ON card_cleanup_operations
         WHEN NEW.environment_id IS NOT OLD.environment_id OR NEW.workflow_revision IS NOT OLD.workflow_revision
           OR NEW.environment_revision IS NOT OLD.environment_revision OR NEW.completion_outcome IS NOT OLD.completion_outcome
           OR NEW.repository_id IS NOT OLD.repository_id OR NEW.source_path IS NOT OLD.source_path OR NEW.target_path IS NOT OLD.target_path
           OR NEW.source_branch IS NOT OLD.source_branch OR NEW.target_branch IS NOT OLD.target_branch OR NEW.source_revision IS NOT OLD.source_revision
           OR NEW.target_revision IS NOT OLD.target_revision OR NEW.delete_local_branch IS NOT OLD.delete_local_branch OR NEW.delete_remote_branch IS NOT OLD.delete_remote_branch
           OR NEW.merged_pr_repository IS NOT OLD.merged_pr_repository OR NEW.merged_pr_number IS NOT OLD.merged_pr_number
           OR NEW.merged_pr_head_revision IS NOT OLD.merged_pr_head_revision OR NEW.pane_ids IS NOT OLD.pane_ids
         BEGIN SELECT RAISE(ABORT, 'cleanup operation snapshot is immutable'); END;
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
            "runtime_cleanup_status",
            "ALTER TABLE kanban_cards ADD COLUMN runtime_cleanup_status TEXT CHECK(runtime_cleanup_status IN ('pending', 'complete', 'failed'))",
        ),
        (
            "runtime_cleanup_error",
            "ALTER TABLE kanban_cards ADD COLUMN runtime_cleanup_error TEXT",
        ),
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
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS card_cleanup_operations (
            card_id TEXT PRIMARY KEY REFERENCES kanban_cards(id) ON DELETE CASCADE,
            environment_id TEXT NOT NULL, workflow_revision INTEGER NOT NULL, environment_revision INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','failed','completed')), phase TEXT NOT NULL,
            completion_outcome TEXT NOT NULL CHECK(completion_outcome IN ('merged','closed')),
            repository_id TEXT NOT NULL, source_path TEXT NOT NULL, target_path TEXT NOT NULL,
            source_branch TEXT NOT NULL, target_branch TEXT NOT NULL, source_revision TEXT NOT NULL, target_revision TEXT,
            delete_local_branch INTEGER NOT NULL, delete_remote_branch INTEGER NOT NULL,
            merged_pr_repository TEXT, merged_pr_number INTEGER, merged_pr_head_revision TEXT,
            pane_ids TEXT NOT NULL DEFAULT '[]', registration_validated INTEGER NOT NULL DEFAULT 0,
            validation_completed_at INTEGER, error_code TEXT, error_detail TEXT,
            started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
         );
         CREATE TRIGGER IF NOT EXISTS card_cleanup_snapshot_immutable BEFORE UPDATE ON card_cleanup_operations
         WHEN NEW.environment_id IS NOT OLD.environment_id OR NEW.workflow_revision IS NOT OLD.workflow_revision
           OR NEW.environment_revision IS NOT OLD.environment_revision OR NEW.completion_outcome IS NOT OLD.completion_outcome
           OR NEW.repository_id IS NOT OLD.repository_id OR NEW.source_path IS NOT OLD.source_path OR NEW.target_path IS NOT OLD.target_path
           OR NEW.source_branch IS NOT OLD.source_branch OR NEW.target_branch IS NOT OLD.target_branch OR NEW.source_revision IS NOT OLD.source_revision
           OR NEW.target_revision IS NOT OLD.target_revision OR NEW.delete_local_branch IS NOT OLD.delete_local_branch OR NEW.delete_remote_branch IS NOT OLD.delete_remote_branch
           OR NEW.merged_pr_repository IS NOT OLD.merged_pr_repository OR NEW.merged_pr_number IS NOT OLD.merged_pr_number
           OR NEW.merged_pr_head_revision IS NOT OLD.merged_pr_head_revision OR NEW.pane_ids IS NOT OLD.pane_ids
         BEGIN SELECT RAISE(ABORT, 'cleanup operation snapshot is immutable'); END;
         INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (53, unixepoch());"
    ).map_err(db_error)?;
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
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (70, unixepoch())",
            [],
        )
        .map_err(db_error)?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS card_target_merge_operations (
            id TEXT PRIMARY KEY, card_id TEXT NOT NULL UNIQUE REFERENCES kanban_cards(id) ON DELETE CASCADE,
            environment_id TEXT NOT NULL, workflow_revision INTEGER NOT NULL, environment_revision INTEGER NOT NULL,
            initial_status TEXT NOT NULL CHECK(initial_status IN ('needs_human','approved')),
            repository_id TEXT NOT NULL, source_path TEXT NOT NULL, source_branch TEXT NOT NULL, target_branch TEXT NOT NULL,
            upstream_remote TEXT NOT NULL, upstream_merge_ref TEXT NOT NULL, source_revision TEXT NOT NULL, target_revision TEXT NOT NULL,
            phase TEXT NOT NULL CHECK(phase IN ('conflicted','merged')), conflict_paths TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
         );
         INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (71, unixepoch());"
    ).map_err(db_error)?;
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
                    runtime_cleanup_status, runtime_cleanup_error, workflow_revision, record_revision, project_id, created_at, updated_at, sort_order, in_scope,
                    parent_id, hierarchy_finalized, provider_child_count, provider_parent_title
             FROM kanban_cards WHERE in_scope = 1 ORDER BY sort_order ASC, created_at ASC, id ASC"
        ).map_err(db_error)?;
        let mapped = statement.query_map([], map_card).map_err(db_error)?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    load_environments_batched(connection, &mut cards)?;
    load_creation_operations_batched(connection, &mut cards)?;
    load_cleanup_operations_batched(connection, &mut cards)?;
    load_pull_requests_batched(connection, &mut cards)?;
    load_events_batched(connection, &mut cards)?;
    enrich_relationships_batched(connection, &mut cards)?;
    Ok(cards)
}

fn get_card(connection: &Connection, id: &str) -> Result<Option<KanbanCard>, String> {
    let mut card = connection.query_row(
        "SELECT id, external_provider, external_id, title, content, board_id, board_title, list_id, list_title,
                card_url, assignee_names, status, completion_outcome, feature_environment, delivery_operation_stage, delivery_error,
                runtime_cleanup_status, runtime_cleanup_error, workflow_revision, record_revision, project_id, created_at, updated_at, sort_order, in_scope,
                parent_id, hierarchy_finalized, provider_child_count, provider_parent_title
         FROM kanban_cards WHERE id = ?1",
        [id],
        map_card,
    ).optional().map_err(db_error)?;
    if let Some(card) = &mut card {
        card.environment = load_environment(connection, id)?;
        card.creation_operation = load_creation_operation(connection, id)?;
        card.cleanup_operation = load_cleanup_operation(connection, id)?;
        card.pull_request = load_pull_request(connection, card)?;
        card.events = load_events(connection, id)?;
        let mut cards = vec![card.clone()];
        enrich_relationships(connection, &mut cards)?;
        *card = cards.remove(0);
    }
    Ok(card)
}

fn enrich_relationships_batched(
    connection: &Connection,
    cards: &mut [KanbanCard],
) -> Result<(), String> {
    let indexes = cards
        .iter()
        .enumerate()
        .map(|(index, card)| (card.id.clone(), index))
        .collect::<HashMap<_, _>>();
    {
        let mut statement = connection
            .prepare(
                "SELECT c.id, p.id, p.external_id, p.title, p.status
             FROM kanban_cards c JOIN kanban_cards p ON p.id=c.parent_id
             WHERE c.in_scope=1",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    CardRelationshipSummary {
                        id: row.get(1)?,
                        external_id: row.get(2)?,
                        title: row.get(3)?,
                        status: row.get(4)?,
                    },
                ))
            })
            .map_err(db_error)?;
        for row in rows {
            let (card_id, parent) = row.map_err(db_error)?;
            if let Some(index) = indexes.get(&card_id) {
                cards[*index].parent = Some(parent);
            }
        }
    }
    {
        let mut statement = connection
            .prepare(
                "SELECT parent_id, id, external_id, title, status FROM kanban_cards
             WHERE in_scope=1 AND parent_id IS NOT NULL
             ORDER BY parent_id, created_at, CAST(external_id AS INTEGER), id",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    CardRelationshipSummary {
                        id: row.get(1)?,
                        external_id: row.get(2)?,
                        title: row.get(3)?,
                        status: row.get(4)?,
                    },
                ))
            })
            .map_err(db_error)?;
        for row in rows {
            let (parent_id, child) = row.map_err(db_error)?;
            if let Some(index) = indexes.get(&parent_id) {
                cards[*index].children.push(child);
            }
        }
    }
    for card in cards {
        card.child_count = card.child_count.max(card.children.len() as u64);
        if card.hierarchy_finalized && !card.children.is_empty() {
            card.status = card
                .children
                .iter()
                .min_by_key(|child| {
                    STATUSES
                        .iter()
                        .position(|status| *status == child.status)
                        .unwrap_or(STATUSES.len())
                })
                .map(|child| child.status.clone())
                .unwrap_or(card.status.clone());
        }
    }
    Ok(())
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

fn load_environments_batched(
    connection: &Connection,
    cards: &mut [KanbanCard],
) -> Result<(), String> {
    let indexes = cards
        .iter()
        .enumerate()
        .map(|(index, card)| (card.id.clone(), index))
        .collect::<HashMap<_, _>>();
    let mut environment_indexes = HashMap::new();
    {
        let mut statement = connection.prepare(
            "SELECT e.card_id, e.id, e.project_id, e.worktree_path, e.branch, e.repository_id,
                    e.target_checkout_path, e.target_branch, e.source_revision, e.target_revision,
                    e.lifecycle_state, e.revision, l.split_layout, l.focused_pane_id, l.layout_revision
             FROM card_environments e
             JOIN kanban_cards c ON c.id=e.card_id
             LEFT JOIN card_layouts l ON l.environment_id=e.id
             WHERE c.in_scope=1"
        ).map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                let layout = row.get::<_, Option<String>>(12)?;
                Ok((
                    row.get::<_, String>(0)?,
                    CardEnvironment {
                        id: row.get(1)?,
                        card_id: row.get(0)?,
                        project_id: row.get(2)?,
                        worktree_path: row.get(3)?,
                        branch: row.get(4)?,
                        repository_id: row.get(5)?,
                        target_checkout_path: row.get(6)?,
                        target_branch: row.get(7)?,
                        source_revision: row.get(8)?,
                        target_revision: row.get(9)?,
                        lifecycle_state: row.get(10)?,
                        revision: row.get(11)?,
                        split_layout: layout
                            .and_then(|value| serde_json::from_str(&value).ok())
                            .unwrap_or(serde_json::json!({"kind":"empty"})),
                        focused_pane_id: row.get(13)?,
                        layout_revision: row.get::<_, Option<i64>>(14)?.unwrap_or(1),
                        panes: Vec::new(),
                    },
                ))
            })
            .map_err(db_error)?;
        for row in rows {
            let (card_id, environment) = row.map_err(db_error)?;
            if let Some(index) = indexes.get(&card_id) {
                environment_indexes.insert(environment.id.clone(), *index);
                cards[*index].environment = Some(environment);
            }
        }
    }
    let mut statement = connection
        .prepare(
            "SELECT p.environment_id, p.id, p.role, p.kind, p.command, p.sort_order
         FROM card_panes p JOIN card_environments e ON e.id=p.environment_id
         JOIN kanban_cards c ON c.id=e.card_id WHERE c.in_scope=1
         ORDER BY p.environment_id, p.sort_order",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                CardPane {
                    id: row.get(1)?,
                    role: row.get(2)?,
                    kind: row.get(3)?,
                    command: row.get(4)?,
                    sort_order: row.get(5)?,
                },
            ))
        })
        .map_err(db_error)?;
    for row in rows {
        let (environment_id, pane) = row.map_err(db_error)?;
        if let Some(index) = environment_indexes.get(&environment_id) {
            if let Some(environment) = &mut cards[*index].environment {
                environment.panes.push(pane);
            }
        }
    }
    Ok(())
}

fn load_creation_operations_batched(
    connection: &Connection,
    cards: &mut [KanbanCard],
) -> Result<(), String> {
    let indexes = cards
        .iter()
        .enumerate()
        .map(|(index, card)| (card.id.clone(), index))
        .collect::<HashMap<_, _>>();
    let mut statement = connection.prepare(
        "SELECT o.card_id, o.id, o.phase, o.error, o.source_path, o.source_branch, o.cleanup_available, o.custom_command, o.revision
         FROM environment_creation_operations o JOIN kanban_cards c ON c.id=o.card_id WHERE c.in_scope=1",
    ).map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                EnvironmentCreationOperation {
                    id: row.get(1)?,
                    phase: row.get(2)?,
                    error: row.get(3)?,
                    source_path: row.get(4)?,
                    source_branch: row.get(5)?,
                    cleanup_available: row.get::<_, i64>(6)? != 0,
                    custom_command: row.get::<_, i64>(7)? != 0,
                    revision: row.get(8)?,
                },
            ))
        })
        .map_err(db_error)?;
    for row in rows {
        let (card_id, operation) = row.map_err(db_error)?;
        if let Some(index) = indexes.get(&card_id) {
            cards[*index].creation_operation = Some(operation);
        }
    }
    Ok(())
}

fn load_cleanup_operations_batched(
    connection: &Connection,
    cards: &mut [KanbanCard],
) -> Result<(), String> {
    let indexes = cards
        .iter()
        .enumerate()
        .map(|(index, card)| (card.id.clone(), index))
        .collect::<HashMap<_, _>>();
    let mut statement = connection.prepare(
        "SELECT o.card_id, o.status, o.phase, o.error_code, o.error_detail, o.started_at, o.updated_at, o.completed_at
         FROM card_cleanup_operations o JOIN kanban_cards c ON c.id=o.card_id WHERE c.in_scope=1",
    ).map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                CardCleanupOperation {
                    status: row.get(1)?,
                    phase: row.get(2)?,
                    error_code: row.get(3)?,
                    error_detail: row.get(4)?,
                    started_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    completed_at: row.get(7)?,
                },
            ))
        })
        .map_err(db_error)?;
    for row in rows {
        let (card_id, operation) = row.map_err(db_error)?;
        if let Some(index) = indexes.get(&card_id) {
            cards[*index].cleanup_operation = Some(operation);
        }
    }
    Ok(())
}

fn load_pull_requests_batched(
    connection: &Connection,
    cards: &mut [KanbanCard],
) -> Result<(), String> {
    let indexes = cards
        .iter()
        .enumerate()
        .map(|(index, card)| (card.id.clone(), index))
        .collect::<HashMap<_, _>>();
    let mut statement = connection
        .prepare(
            "SELECT pr.card_id, pr.repository, pr.number, pr.title, pr.url, pr.state, pr.draft,
                pr.ci_status, pr.review_state, pr.has_conflicts, pr.mergeable,
                p.require_passing_ci, p.require_approval
         FROM card_pull_requests pr JOIN kanban_cards c ON c.id=pr.card_id
         LEFT JOIN projects p ON p.id=c.project_id WHERE c.in_scope=1",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            let policies = (
                row.get::<_, Option<i64>>(11)?
                    .map(|value| value != 0)
                    .unwrap_or(true),
                row.get::<_, Option<i64>>(12)?
                    .map(|value| value != 0)
                    .unwrap_or(false),
            );
            Ok((
                row.get::<_, String>(0)?,
                CardPullRequest {
                    repository: row.get(1)?,
                    number: row.get::<_, i64>(2)? as u64,
                    title: row.get(3)?,
                    url: row.get(4)?,
                    state: row.get(5)?,
                    draft: row.get::<_, i64>(6)? != 0,
                    ci_status: row.get(7)?,
                    review_state: row.get(8)?,
                    has_conflicts: row.get::<_, i64>(9)? != 0,
                    mergeable: row.get::<_, i64>(10)? != 0,
                    blockers: Vec::new(),
                },
                policies,
            ))
        })
        .map_err(db_error)?;
    for row in rows {
        let (card_id, mut pull_request, policies) = row.map_err(db_error)?;
        apply_pull_request_policy(&mut pull_request, policies);
        if let Some(index) = indexes.get(&card_id) {
            cards[*index].pull_request = Some(pull_request);
        }
    }
    Ok(())
}

fn load_events_batched(connection: &Connection, cards: &mut [KanbanCard]) -> Result<(), String> {
    let indexes = cards
        .iter()
        .enumerate()
        .map(|(index, card)| (card.id.clone(), index))
        .collect::<HashMap<_, _>>();
    let mut statement = connection.prepare(
        "SELECT card_id, id, created_at, actor, event_type, outcome, from_status, to_status, summary, error_code, error_detail
         FROM (SELECT e.*, ROW_NUMBER() OVER (PARTITION BY e.card_id ORDER BY e.created_at DESC, e.id DESC) AS event_rank
               FROM card_events e JOIN kanban_cards c ON c.id=e.card_id WHERE c.in_scope=1)
         WHERE event_rank <= 100 ORDER BY card_id, created_at DESC, id DESC"
    ).map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                CardEvent {
                    id: row.get(1)?,
                    created_at: row.get(2)?,
                    actor: row.get(3)?,
                    event_type: row.get(4)?,
                    outcome: row.get(5)?,
                    from_status: row.get(6)?,
                    to_status: row.get(7)?,
                    summary: row.get(8)?,
                    error_code: row.get(9)?,
                    error_detail: row.get(10)?,
                },
            ))
        })
        .map_err(db_error)?;
    for row in rows {
        let (card_id, event) = row.map_err(db_error)?;
        if let Some(index) = indexes.get(&card_id) {
            cards[*index].events.push(event);
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
    apply_pull_request_policy(&mut pull_request, policies);
    Ok(Some(pull_request))
}

fn apply_pull_request_policy(pull_request: &mut CardPullRequest, policies: (bool, bool)) {
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

fn load_creation_operation(
    connection: &Connection,
    card_id: &str,
) -> Result<Option<EnvironmentCreationOperation>, String> {
    connection.query_row(
        "SELECT id, phase, error, source_path, source_branch, cleanup_available, custom_command, revision
         FROM environment_creation_operations WHERE card_id=?1",
        [card_id],
        |row| Ok(EnvironmentCreationOperation {
            id: row.get(0)?,
            phase: row.get(1)?,
            error: row.get(2)?,
            source_path: row.get(3)?,
            source_branch: row.get(4)?,
            cleanup_available: row.get::<_, i64>(5)? != 0,
            custom_command: row.get::<_, i64>(6)? != 0,
            revision: row.get(7)?,
        }),
    ).optional().map_err(db_error)
}

fn load_cleanup_operation(
    connection: &Connection,
    card_id: &str,
) -> Result<Option<CardCleanupOperation>, String> {
    connection.query_row(
        "SELECT status, phase, error_code, error_detail, started_at, updated_at, completed_at FROM card_cleanup_operations WHERE card_id=?1",
        [card_id],
        |row| Ok(CardCleanupOperation {
            status: row.get(0)?, phase: row.get(1)?, error_code: row.get(2)?, error_detail: row.get(3)?,
            started_at: row.get(4)?, updated_at: row.get(5)?, completed_at: row.get(6)?,
        }),
    ).optional().map_err(db_error)
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
    let parent_id = row.get::<_, Option<String>>(25)?;
    let provider_parent_title = row.get::<_, Option<String>>(28)?;
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
        runtime_cleanup_status: row.get(16)?,
        runtime_cleanup_error: row.get(17)?,
        workflow_revision: row.get(18)?,
        record_revision: row.get(19)?,
        project_id: row.get(20)?,
        environment: None,
        creation_operation: None,
        cleanup_operation: None,
        created_at: row.get(21)?,
        updated_at: row.get(22)?,
        sort_order: row.get(23)?,
        in_scope: row.get(24)?,
        parent: parent_id.map(|id| CardRelationshipSummary {
            external_id: id.strip_prefix("superthread:").unwrap_or(&id).to_string(),
            id,
            title: provider_parent_title.unwrap_or_default(),
            status: String::new(),
        }),
        hierarchy_finalized: row.get::<_, i64>(26)? != 0,
        child_count: row.get::<_, i64>(27)? as u64,
        children: Vec::new(),
        events: Vec::new(),
    })
}

fn validate_card_environment_project(connection: &Connection, card_id: &str) -> Result<(), String> {
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
    if card.hierarchy_finalized {
        return Ok(CardEnvironmentHealth {
            card_id: card.id,
            issues: Vec::new(),
        });
    }
    let mut issues = Vec::new();
    let pending_target_merge: Option<String> = connection
        .query_row(
            "SELECT phase FROM card_target_merge_operations WHERE card_id=?1",
            [card_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    if let Some(phase) = pending_target_merge {
        issues.push(health_issue(
            "target_merge_pending",
            if phase == "conflicted" {
                "A target merge is awaiting conflict resolution. Use Merge in target & resolve to resume or recover it."
            } else {
                "A completed target merge is awaiting final verification. Use Merge in target & resolve to resume or recover it."
            },
            if card.status == "approved" { "merge" } else { "approval" },
        ));
    }
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
            "Setup result {} is not a distinct registered worktree",
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
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TRACED_READS: AtomicUsize = AtomicUsize::new(0);

    fn count_traced_reads(sql: &str) {
        let sql = sql.trim_start();
        if sql.starts_with("SELECT") || sql.starts_with("WITH") {
            TRACED_READS.fetch_add(1, Ordering::Relaxed);
        }
    }

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
        crate::store::migrate_store_schema(&connection).unwrap();
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
        crate::store::migrate_store_schema(&connection).unwrap();
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
        crate::store::migrate_store_schema(&connection).unwrap();
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
        crate::store::migrate_store_schema(&connection).unwrap();
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
        crate::store::migrate_store_schema(&connection).unwrap();
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

    fn aggregate_test_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        crate::store::migrate_store_schema(&connection).unwrap();
        test_project(&connection, "one", "local", "/one");
        test_project(&connection, "two", "local", "/two");
        connection
            .execute(
                "UPDATE projects SET require_passing_ci=1, require_approval=1 WHERE id='one'",
                [],
            )
            .unwrap();
        for (id, project, external_id, status, parent_id, finalized, created, order) in [
            ("local:parent", "one", "10", "approved", None, 1, 3, 0),
            (
                "local:child",
                "one",
                "2",
                "needs_human",
                Some("local:parent"),
                0,
                1,
                1,
            ),
            ("local:other", "two", "1", "ready", None, 0, 2, 1),
        ] {
            connection.execute(
                "INSERT INTO kanban_cards (id,external_provider,external_id,title,status,project_id,parent_id,hierarchy_finalized,created_at,updated_at,sort_order)
                 VALUES (?1,?2,?3,?1,?4,?5,?6,?7,?8,?8,?9)",
                params![id, format!("local:{project}"), external_id, status, project, parent_id, finalized, created, order],
            ).unwrap();
        }
        for (card_id, environment_id, project_id) in [
            ("local:child", "environment:child", "one"),
            ("local:other", "environment:other", "two"),
        ] {
            connection.execute(
                "INSERT INTO card_environments (id,card_id,project_id,worktree_path,branch,lifecycle_state,revision,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,'feature','ready',4,1,1)",
                params![environment_id, card_id, project_id, format!("/{project_id}/worktree")],
            ).unwrap();
        }
        connection.execute("INSERT INTO card_layouts (environment_id,split_layout,focused_pane_id,layout_revision,updated_at) VALUES ('environment:child','not-json','pane:second',7,1)", []).unwrap();
        for (id, environment, order) in [
            ("pane:second", "environment:child", 2),
            ("pane:first", "environment:child", 1),
        ] {
            connection.execute("INSERT INTO card_panes (id,environment_id,role,kind,sort_order) VALUES (?1,?2,'shell','terminal',?3)", params![id, environment, order]).unwrap();
        }
        connection.execute(
            "INSERT INTO card_pull_requests (card_id,repository,number,title,url,state,draft,ci_status,review_state,has_conflicts,mergeable,updated_at)
             VALUES ('local:child','org/repo',7,'PR','url','closed',1,'failure','changes_requested',1,0,1)", [],
        ).unwrap();
        connection.execute(
            "INSERT INTO card_pull_requests (card_id,repository,number,title,url,state,draft,ci_status,review_state,has_conflicts,mergeable,updated_at)
             VALUES ('local:other','org/other',8,'PR','url','open',0,'failure','unknown',0,1,1)", [],
        ).unwrap();
        for index in 0..101 {
            for card_id in ["local:child", "local:other"] {
                connection.execute(
                    "INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,summary) VALUES (?1,5,'agent','test','success',?2)",
                    params![card_id, index.to_string()],
                ).unwrap();
            }
        }
        // Keep one card's project metadata absent to exercise pull-request policy defaults.
        connection
            .execute("DELETE FROM projects WHERE id='two'", [])
            .unwrap();
        connection
    }

    #[test]
    fn batched_list_preserves_aggregate_ownership_order_limits_and_defaults() {
        let mut connection = aggregate_test_connection();
        let cards = list_cards(&mut connection).unwrap();
        assert_eq!(
            cards
                .iter()
                .map(|card| card.id.as_str())
                .collect::<Vec<_>>(),
            vec!["local:parent", "local:child", "local:other"]
        );

        let parent = &cards[0];
        assert_eq!(parent.status, "needs_human");
        assert_eq!(parent.child_count, 1);
        assert_eq!(
            parent
                .children
                .iter()
                .map(|child| child.id.as_str())
                .collect::<Vec<_>>(),
            vec!["local:child"]
        );
        assert_eq!(cards[1].parent.as_ref().unwrap().title, "local:parent");

        let child_environment = cards[1].environment.as_ref().unwrap();
        assert_eq!(
            child_environment.split_layout,
            serde_json::json!({"kind":"empty"})
        );
        assert_eq!(child_environment.layout_revision, 7);
        assert_eq!(
            child_environment.focused_pane_id.as_deref(),
            Some("pane:second")
        );
        assert_eq!(
            child_environment
                .panes
                .iter()
                .map(|pane| pane.id.as_str())
                .collect::<Vec<_>>(),
            vec!["pane:first", "pane:second"]
        );
        let other_environment = cards[2].environment.as_ref().unwrap();
        assert_eq!(
            other_environment.split_layout,
            serde_json::json!({"kind":"empty"})
        );
        assert_eq!(other_environment.layout_revision, 1);
        assert_eq!(other_environment.focused_pane_id, None);

        assert_eq!(
            cards[1].pull_request.as_ref().unwrap().blockers,
            vec![
                "Pull request was closed without merging",
                "Pull request is a draft",
                "Pull request has merge conflicts",
                "GitHub merge readiness is unknown or blocked",
                "CI is failing",
                "A reviewer requested changes",
                "A current approval is required",
            ]
        );
        assert_eq!(
            cards[2].pull_request.as_ref().unwrap().blockers,
            vec!["CI is failing"]
        );
        for card in [&cards[1], &cards[2]] {
            assert_eq!(card.events.len(), 100);
            assert!(card
                .events
                .windows(2)
                .all(|events| events[0].id > events[1].id));
        }
    }

    #[test]
    fn list_read_count_is_constant_and_get_card_remains_targeted() {
        let mut connection = aggregate_test_connection();
        connection.trace(Some(count_traced_reads));
        TRACED_READS.store(0, Ordering::Relaxed);
        list_cards(&mut connection).unwrap();
        let initial_reads = TRACED_READS.load(Ordering::Relaxed);
        // Cards, environments/panes, creation and cleanup operations, PRs,
        // events, and relationships are each loaded in constant-size batches.
        assert_eq!(initial_reads, 9);
        for index in 0..25 {
            connection.execute(
                "INSERT INTO kanban_cards (id,external_provider,external_id,title,project_id,created_at,updated_at,sort_order)
                 VALUES (?1,'local:two',?2,?1,'two',10,10,10)",
                params![format!("local:extra:{index}"), (index + 100).to_string()],
            ).unwrap();
        }
        TRACED_READS.store(0, Ordering::Relaxed);
        assert_eq!(list_cards(&mut connection).unwrap().len(), 28);
        assert_eq!(TRACED_READS.load(Ordering::Relaxed), initial_reads);

        let child = get_card(&connection, "local:child").unwrap().unwrap();
        assert_eq!(child.environment.as_ref().unwrap().card_id, "local:child");
        assert_eq!(child.events.len(), 100);
        assert_eq!(child.children.len(), 0);
    }

    #[test]
    fn initialization_builds_all_schemas_and_connection_pragmas_and_is_guarded() {
        let path =
            std::env::temp_dir().join(format!("stacks-kanban-{}.sqlite3", uuid::Uuid::new_v4()));
        let mut connection = Connection::open(&path).unwrap();
        configure_connection(&connection).unwrap();
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        initialize_connection(&mut connection, false).unwrap();
        for table in ["kanban_cards", "projects", "project_direct_work"] {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                        [table],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                1
            );
        }
        assert_eq!(
            connection
                .pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "busy_timeout", |row| row.get::<_, i64>(0))
                .unwrap(),
            5000
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
                .unwrap(),
            "wal"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM schema_migrations WHERE version=3",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        drop(connection);
        let _ = std::fs::remove_file(path);

        let state = OnceLock::new();
        let calls = AtomicUsize::new(0);
        assert!(initialize_once(&state, || {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok(())
        })
        .is_ok());
        assert!(initialize_once(&state, || {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok(())
        })
        .is_ok());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        let failed = OnceLock::new();
        assert_eq!(
            initialize_once(&failed, || Err("broken migration".into())).unwrap_err(),
            "broken migration"
        );
        assert_eq!(
            initialize_once(&failed, || Ok(())).unwrap_err(),
            "broken migration"
        );
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

    #[test]
    fn environment_creation_migration_persists_one_active_operation_per_card() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        let card = local_card(&mut connection);
        let insert = |connection: &Connection, id: &str| {
            connection.execute(
            "INSERT INTO environment_creation_operations (id,card_id,project_id,repository_id,expected_workflow_revision,target_checkout_path,target_branch,observed_target_revision,setup_command,phase,result_path,pre_worktrees,pre_branches,created_at,updated_at) VALUES (?1,?2,'project','repo',1,'/target','main','tip','setup','prepared','/result','[]','{}',1,1)",
            params![id,card.id],
        )
        };
        assert_eq!(insert(&connection, "operation:1").unwrap(), 1);
        assert!(insert(&connection, "operation:2").is_err());
        let operation = load_creation_operation(&connection, &card.id)
            .unwrap()
            .unwrap();
        assert_eq!(operation.phase, "prepared");
        assert_eq!(operation.revision, 1);
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

    fn upstream_merge_repository() -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "stacks-target-merge-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let remote = root.join("remote.git");
        let target = root.join("target");
        let source = root.join("source");
        fs::create_dir_all(&root).unwrap();
        git_ok(&root, &["init", "--bare", remote.to_str().unwrap()]);
        git_ok(
            &root,
            &["clone", remote.to_str().unwrap(), target.to_str().unwrap()],
        );
        git_ok(&target, &["config", "user.email", "stacks@example.com"]);
        git_ok(&target, &["config", "user.name", "Stacks Tests"]);
        git_ok(&target, &["checkout", "-b", "main"]);
        fs::write(target.join("base.txt"), "base\n").unwrap();
        git_ok(&target, &["add", "."]);
        git_ok(&target, &["commit", "-m", "base"]);
        git_ok(&target, &["push", "-u", "origin", "main"]);
        git_ok(
            &target,
            &["worktree", "add", "-b", "feature", source.to_str().unwrap()],
        );
        git_ok(&source, &["config", "user.email", "stacks@example.com"]);
        git_ok(&source, &["config", "user.name", "Stacks Tests"]);
        fs::write(source.join("feature.txt"), "feature\n").unwrap();
        git_ok(&source, &["add", "."]);
        git_ok(&source, &["commit", "-m", "feature"]);
        (root, target, source)
    }

    fn target_merge_connection(source: &Path, target: &Path, status: &str) -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        test_project(&connection, "p", "local", target.to_str().unwrap());
        let now = unix_timestamp();
        connection.execute("INSERT INTO kanban_cards (id,external_provider,external_id,title,status,workflow_revision,project_id,created_at,updated_at) VALUES ('local:target-merge','local:p','1','Target merge',?1,4,'p',?2,?2)", params![status,now]).unwrap();
        let repository = repository_identity(target.to_str().unwrap()).unwrap();
        let source_tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        let target_tip = git_output(target.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        connection.execute("INSERT INTO card_environments (id,card_id,project_id,worktree_path,branch,repository_id,target_checkout_path,target_branch,source_revision,target_revision,lifecycle_state,revision,created_at,updated_at) VALUES ('target-merge-e','local:target-merge','p',?1,'feature',?2,?3,'main',?4,?5,'ready',2,?6,?6)", params![source.to_str().unwrap(),repository,target.to_str().unwrap(),source_tip,target_tip,now]).unwrap();
        connection
    }

    fn advance_target(target: &Path, contents: &str) {
        fs::write(target.join("target.txt"), contents).unwrap();
        git_ok(target, &["add", "."]);
        git_ok(target, &["commit", "-m", "advance target"]);
        git_ok(target, &["push", "origin", "main"]);
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
    fn target_merge_fetches_upstream_and_creates_verified_explicit_commit() {
        for initial_status in ["needs_human", "approved"] {
            let (root, target, source) = upstream_merge_repository();
            let mut connection = target_merge_connection(&source, &target, initial_status);
            advance_target(&target, "target change\n");
            let prepared =
                prepare_target_merge(&mut connection, "local:target-merge", 4, 2).unwrap();
            assert_eq!(prepared.state, "merged");
            let operation_id = prepared.operation_id.unwrap();
            let result =
                finalize_target_merge(&mut connection, "local:target-merge", &operation_id)
                    .unwrap();
            assert_eq!(result.card.status, "needs_human");
            assert_eq!(result.card.workflow_revision, 5);
            assert_eq!(result.card.environment.unwrap().revision, 3);
            assert_eq!(
                git_output(
                    source.to_str().unwrap(),
                    &["rev-list", "--parents", "-n", "1", "HEAD"]
                )
                .unwrap()
                .split_whitespace()
                .count(),
                3
            );
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn target_merge_noop_preserves_status_and_creates_no_commit() {
        let (root, target, source) = upstream_merge_repository();
        let mut connection = target_merge_connection(&source, &target, "approved");
        let before = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        let result = prepare_target_merge(&mut connection, "local:target-merge", 4, 2).unwrap();
        assert_eq!(result.state, "noop");
        assert!(result.idempotent);
        assert_eq!(result.card.status, "approved");
        assert_eq!(
            git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap(),
            before
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn target_merge_rejects_dirty_source_and_missing_upstream_before_mutation() {
        let (root, target, source) = upstream_merge_repository();
        let mut connection = target_merge_connection(&source, &target, "needs_human");
        let before = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        fs::write(source.join("dirty.txt"), "dirty\n").unwrap();
        assert!(
            prepare_target_merge(&mut connection, "local:target-merge", 4, 2)
                .unwrap_err()
                .contains("modified or untracked")
        );
        fs::remove_file(source.join("dirty.txt")).unwrap();
        git_ok(&source, &["config", "--unset", "branch.main.remote"]);
        let error = prepare_target_merge(&mut connection, "local:target-merge", 4, 2).unwrap_err();
        assert!(error.contains("set-upstream-to"), "{error}");
        assert_eq!(
            git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap(),
            before
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn target_merge_fetch_failure_and_revision_conflicts_leave_source_unchanged() {
        let (root, target, source) = upstream_merge_repository();
        let mut connection = target_merge_connection(&source, &target, "needs_human");
        let before = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        assert!(
            prepare_target_merge(&mut connection, "local:target-merge", 3, 2)
                .unwrap_err()
                .contains("Card changed")
        );
        assert!(
            prepare_target_merge(&mut connection, "local:target-merge", 4, 1)
                .unwrap_err()
                .contains("environment changed")
        );
        git_ok(
            &source,
            &[
                "remote",
                "set-url",
                "origin",
                "/definitely/missing/stacks-target.git",
            ],
        );
        let error = prepare_target_merge(&mut connection, "local:target-merge", 4, 2).unwrap_err();
        assert!(
            error.contains("network access and authentication"),
            "{error}"
        );
        assert_eq!(
            git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap(),
            before
        );
        assert!(
            load_target_merge_operation(&connection, "local:target-merge")
                .unwrap()
                .is_none()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn target_merge_rejects_an_active_git_operation() {
        let (root, target, source) = upstream_merge_repository();
        let mut connection = target_merge_connection(&source, &target, "needs_human");
        let marker = git_output(
            source.to_str().unwrap(),
            &["rev-parse", "--git-path", "CHERRY_PICK_HEAD"],
        )
        .unwrap();
        fs::write(
            marker,
            git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap(),
        )
        .unwrap();
        let error = prepare_target_merge(&mut connection, "local:target-merge", 4, 2).unwrap_err();
        assert!(error.contains("in-progress Git operation"), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn target_merge_conflicts_can_be_finalized_or_safely_aborted() {
        let (root, target, source) = upstream_merge_repository();
        fs::write(source.join("base.txt"), "source version\n").unwrap();
        git_ok(&source, &["add", "."]);
        git_ok(&source, &["commit", "-m", "source conflict"]);
        fs::write(target.join("base.txt"), "target version\n").unwrap();
        git_ok(&target, &["add", "."]);
        git_ok(&target, &["commit", "-m", "target conflict"]);
        git_ok(&target, &["push", "origin", "main"]);
        let mut connection = target_merge_connection(&source, &target, "needs_human");
        let starting_revision =
            git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        let prepared = prepare_target_merge(&mut connection, "local:target-merge", 4, 2).unwrap();
        assert_eq!(prepared.state, "conflicted");
        assert!(health_codes(&connection, "local:target-merge")
            .contains(&"target_merge_pending".to_string()));
        let operation_id = prepared.operation_id.unwrap();
        fs::write(source.join("base.txt"), "resolved\n").unwrap();
        git_ok(&source, &["add", "."]);
        git_ok(&source, &["commit", "-m", "Merge target with resolution"]);
        assert_eq!(
            finalize_target_merge(&mut connection, "local:target-merge", &operation_id)
                .unwrap()
                .card
                .status,
            "needs_human"
        );

        // A second conflicted operation can be conservatively restored when no
        // paths outside Git's recorded merge result were touched.
        fs::write(target.join("base.txt"), "another target version\n").unwrap();
        git_ok(&target, &["add", "."]);
        git_ok(&target, &["commit", "-m", "second target conflict"]);
        git_ok(&target, &["push", "origin", "main"]);
        fs::write(source.join("base.txt"), "another source version\n").unwrap();
        git_ok(&source, &["add", "."]);
        git_ok(&source, &["commit", "-m", "second source conflict"]);
        let current = get_card(&connection, "local:target-merge")
            .unwrap()
            .unwrap();
        let environment_revision = current.environment.unwrap().revision;
        let prepared = prepare_target_merge(
            &mut connection,
            "local:target-merge",
            current.workflow_revision,
            environment_revision,
        )
        .unwrap();
        assert_eq!(prepared.state, "conflicted");
        let operation_id = prepared.operation_id.unwrap();
        let abort_start = load_target_merge_operation(&connection, "local:target-merge")
            .unwrap()
            .unwrap()
            .source_revision;
        abort_target_merge(&mut connection, "local:target-merge", &operation_id).unwrap();
        assert_eq!(
            git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap(),
            abort_start
        );
        assert!(!has_git_operation(source.to_str().unwrap()).unwrap());
        assert!(git_output(
            source.to_str().unwrap(),
            &["status", "--porcelain=v1", "--untracked-files=all"]
        )
        .unwrap()
        .is_empty());
        assert_ne!(starting_revision, abort_start);
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
    fn environment_health_ignores_finalized_parent_with_active_child() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        local_card(&mut connection);
        connection
            .execute(
                "UPDATE kanban_cards SET status='ready', hierarchy_finalized=1 WHERE id='local:test'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO kanban_cards
                 (id, external_provider, external_id, title, status, project_id, parent_id, created_at, updated_at)
                 VALUES ('local:child', 'local:project', '2', 'Child', 'agent_working', 'project', 'local:test', 1, 1)",
                [],
            )
            .unwrap();

        let parent = get_card(&connection, "local:test").unwrap().unwrap();
        assert_eq!(parent.status, "agent_working");
        assert!(health_codes(&connection, "local:test").is_empty());
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
    fn cleanup_phases_are_ordered_and_cover_every_resumable_boundary() {
        let mut visited = vec![CLEANUP_PHASES[0]];
        while let Some(next) = next_cleanup_phase(visited.last().unwrap()) {
            visited.push(next);
        }
        assert_eq!(visited, CLEANUP_PHASES);
        assert_eq!(next_cleanup_phase("record_completion"), None);
    }

    #[test]
    fn cleanup_operation_schema_retains_completed_audit_after_environment_deletion() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        test_project(&connection, "p", "local", "/tmp/repo");
        let now = unix_timestamp();
        connection.execute("INSERT INTO kanban_cards (id,external_provider,external_id,title,status,completion_outcome,workflow_revision,project_id,created_at,updated_at) VALUES ('local:cleanup','local:p','64','Cleanup','done','closed',3,'p',?1,?1)", [now]).unwrap();
        connection.execute("INSERT INTO card_environments (id,card_id,project_id,worktree_path,branch,revision,created_at,updated_at) VALUES ('cleanup-env','local:cleanup','p','/tmp/source','feature',2,?1,?1)", [now]).unwrap();
        connection.execute("INSERT INTO card_cleanup_operations (card_id,environment_id,workflow_revision,environment_revision,status,phase,completion_outcome,repository_id,source_path,target_path,source_branch,target_branch,source_revision,delete_local_branch,delete_remote_branch,started_at,updated_at) VALUES ('local:cleanup','cleanup-env',3,2,'pending','remove_metadata','closed','repo','/tmp/source','/tmp/repo','feature','main','abc',0,0,?1,?1)", [now]).unwrap();
        let immutable_error = connection.execute("UPDATE card_cleanup_operations SET source_revision='changed' WHERE card_id='local:cleanup'", []).unwrap_err();
        assert!(immutable_error
            .to_string()
            .contains("snapshot is immutable"));
        connection
            .execute("DELETE FROM card_environments WHERE id='cleanup-env'", [])
            .unwrap();
        connection.execute("UPDATE card_cleanup_operations SET status='completed',phase='record_completion',completed_at=?1 WHERE card_id='local:cleanup'", [now]).unwrap();
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM card_cleanup_operations WHERE card_id='local:cleanup' AND status='completed'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert!(get_card(&connection, "local:cleanup")
            .unwrap()
            .unwrap()
            .cleanup_operation
            .is_some());
    }

    #[test]
    fn cleanup_phase_advancement_is_compare_and_set_and_resumable_at_every_boundary() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        test_project(&connection, "p", "local", "/tmp/repo");
        let now = unix_timestamp();
        connection.execute("INSERT INTO kanban_cards (id,external_provider,external_id,title,status,completion_outcome,workflow_revision,project_id,created_at,updated_at) VALUES ('local:phases','local:p','64','Phases','done','closed',3,'p',?1,?1)", [now]).unwrap();
        connection.execute("INSERT INTO card_environments (id,card_id,project_id,worktree_path,branch,revision,created_at,updated_at) VALUES ('phase-env','local:phases','p','/tmp/source','feature',2,?1,?1)", [now]).unwrap();
        connection.execute("INSERT INTO card_cleanup_operations (card_id,environment_id,workflow_revision,environment_revision,status,phase,completion_outcome,repository_id,source_path,target_path,source_branch,target_branch,source_revision,delete_local_branch,delete_remote_branch,started_at,updated_at) VALUES ('local:phases','phase-env',3,2,'failed','runtime_sessions','closed','repo','/tmp/source','/tmp/repo','feature','main','abc',0,0,?1,?1)", [now]).unwrap();

        let stale = load_cleanup_snapshot(&connection, "local:phases").unwrap();
        advance_cleanup_phase_in_connection(&mut connection, &stale).unwrap();
        assert!(advance_cleanup_phase_in_connection(&mut connection, &stale)
            .unwrap_err()
            .contains("changed"));
        loop {
            let current = load_cleanup_snapshot(&connection, "local:phases").unwrap();
            if current.status == "completed" {
                break;
            }
            advance_cleanup_phase_in_connection(&mut connection, &current).unwrap();
        }
        let completed = load_cleanup_snapshot(&connection, "local:phases").unwrap();
        assert_eq!(completed.status, "completed");
        assert!(completed.registration_validated);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM card_events WHERE card_id='local:phases' AND event_type='cleanup' AND outcome='success'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    fn cleanup_snapshot(target: &Path, source: &Path, outcome: &str) -> CleanupSnapshot {
        CleanupSnapshot {
            card_id: "local:cleanup".into(),
            environment_id: "env".into(),
            workflow_revision: 1,
            environment_revision: 1,
            status: "pending".into(),
            phase: "validate_repository".into(),
            completion_outcome: outcome.into(),
            repository_id: repository_identity(target.to_str().unwrap()).unwrap(),
            source_path: source.to_str().unwrap().into(),
            target_path: target.to_str().unwrap().into(),
            source_branch: "feature".into(),
            target_branch: "main".into(),
            source_revision: git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap(),
            delete_local_branch: outcome == "merged",
            delete_remote_branch: false,
            merged_pr_head_revision: None,
            pane_ids: Vec::new(),
            registration_validated: false,
        }
    }

    #[test]
    fn cleanup_reconciles_worktree_and_local_branch_side_effects() {
        let (root, target, source) = merge_repository();
        git_ok(&target, &["merge", "--no-ff", "feature", "-m", "merge"]);
        let mut operation = cleanup_snapshot(&target, &source, "merged");
        validate_cleanup_repository(&operation).unwrap();
        operation.registration_validated = true;

        remove_cleanup_worktree(&operation).unwrap();
        assert!(!source.exists());
        remove_cleanup_worktree(&operation).unwrap();
        delete_cleanup_local_branch(&operation).unwrap();
        assert!(local_ref_tip(target.to_str().unwrap(), "feature")
            .unwrap()
            .is_none());
        delete_cleanup_local_branch(&operation).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_remote_deletion_uses_exact_tip_lease_and_reconciles_absence() {
        let (root, target, source) = merge_repository();
        git_ok(&target, &["merge", "--no-ff", "feature", "-m", "merge"]);
        let remote = root.join("remote.git");
        let output = Command::new("git")
            .args(["init", "--bare", remote.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(output.status.success());
        git_ok(
            &target,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git_ok(&target, &["push", "origin", "feature"]);
        let mut operation = cleanup_snapshot(&target, &source, "merged");
        operation.registration_validated = true;
        operation.delete_remote_branch = true;
        operation.merged_pr_head_revision = Some(operation.source_revision.clone());
        delete_cleanup_remote_branch(&operation).unwrap();
        delete_cleanup_remote_branch(&operation).unwrap();

        git_ok(&target, &["push", "origin", "main:feature"]);
        assert!(delete_cleanup_remote_branch(&operation)
            .unwrap_err()
            .contains("tip changed"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_rejects_absent_unvalidated_and_changed_source_evidence() {
        let (root, target, source) = merge_repository();
        let mut operation = cleanup_snapshot(&target, &source, "closed");
        fs::write(source.join("dirty.txt"), "unsafe\n").unwrap();
        assert!(validate_cleanup_repository(&operation)
            .unwrap_err()
            .contains("modified or untracked"));
        fs::remove_file(source.join("dirty.txt")).unwrap();
        git_ok(&target, &["worktree", "remove", source.to_str().unwrap()]);
        assert!(remove_cleanup_worktree(&operation)
            .unwrap_err()
            .contains("without persisted"));
        operation.registration_validated = true;
        remove_cleanup_worktree(&operation).unwrap();
        git_ok(&target, &["branch", "-f", "feature", "main"]);
        assert!(remove_cleanup_worktree(&operation)
            .unwrap_err()
            .contains("tip changed"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_ownership_parsing_is_exact_for_delimited_and_prefixed_card_ids() {
        assert_eq!(
            card_pi_owner("kanban-card:local:7:planning").as_deref(),
            Some("local:7")
        );
        assert_eq!(
            card_terminal_owner("kanban-card:local:7:terminal:shell").as_deref(),
            Some("local:7")
        );
        assert_ne!(
            card_pi_owner("kanban-card:local:72:planning").as_deref(),
            Some("local:7")
        );
        assert_ne!(
            card_terminal_owner("kanban-card:local:72:terminal:shell").as_deref(),
            Some("local:7")
        );
        assert!(card_pi_owner("kanban-card:local:7:terminal:shell").is_none());
    }

    #[test]
    fn close_validates_and_commits_pending_cleanup_before_teardown() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        let card = local_card(&mut connection);
        connection.execute("INSERT INTO card_environments (id,card_id,project_id,worktree_path,created_at,updated_at) VALUES ('env','local:test','project','/tmp/card',1,1)", []).unwrap();
        connection.execute("INSERT INTO card_panes (id,environment_id,role,kind,sort_order) VALUES ('kanban-card:local:test:terminal:custom','env','custom','terminal',0), ('kanban-card:local:test-more:terminal:foreign','env','foreign','terminal',1)", []).unwrap();

        assert!(commit_card_close(&mut connection, &card.id, card.workflow_revision + 1).is_err());
        let unchanged = get_card(&connection, &card.id).unwrap().unwrap();
        assert_eq!(unchanged.status, "needs_refinement");
        assert_eq!(unchanged.workflow_revision, card.workflow_revision);
        assert!(unchanged.runtime_cleanup_status.is_none());
        assert_eq!(unchanged.events.len(), 0);

        let targets = commit_card_close(&mut connection, &card.id, card.workflow_revision).unwrap();
        let committed = get_card(&connection, &card.id).unwrap().unwrap();
        assert_eq!(committed.status, "done");
        assert_eq!(committed.completion_outcome.as_deref(), Some("closed"));
        assert_eq!(committed.workflow_revision, card.workflow_revision + 1);
        assert_eq!(committed.runtime_cleanup_status.as_deref(), Some("pending"));
        assert_eq!(
            committed
                .events
                .iter()
                .filter(|event| event.event_type == "close" && event.outcome == "success")
                .count(),
            1
        );
        assert!(targets
            .pty
            .contains("kanban-card:local:test:terminal:custom"));
        assert!(!targets
            .pty
            .contains("kanban-card:local:test-more:terminal:foreign"));
        assert!(commit_card_close(&mut connection, &card.id, committed.workflow_revision).is_err());
    }

    #[test]
    fn runtime_cleanup_attempts_every_target_and_recovers_without_workflow_change() {
        use std::cell::RefCell;
        let mut targets = CardRuntimeTargets::default();
        targets.pi.extend([
            "kanban-card:local:test:planning".into(),
            "kanban-card:local:test:work".into(),
        ]);
        targets.pty.extend([
            "kanban-card:local:test:terminal:shell".into(),
            "kanban-card:local:test:terminal:server".into(),
        ]);
        let attempted = RefCell::new(Vec::new());
        let outcomes = execute_runtime_cleanup(
            targets,
            |id| {
                attempted.borrow_mut().push(format!("stop:{id}"));
                if id.ends_with(":planning") {
                    Err("stuck".into())
                } else {
                    Ok(())
                }
            },
            |id| {
                attempted.borrow_mut().push(format!("delete:{id}"));
                Ok(())
            },
            |id| {
                attempted.borrow_mut().push(format!("pty:{id}"));
                Ok(())
            },
        );
        assert_eq!(
            outcomes.iter().filter(|outcome| !outcome.success).count(),
            2
        );
        assert!(attempted
            .borrow()
            .iter()
            .any(|value| value.ends_with(":work")));
        assert!(attempted
            .borrow()
            .iter()
            .any(|value| value.ends_with(":terminal:server")));
        assert!(!attempted
            .borrow()
            .iter()
            .any(|value| value == "delete:kanban-card:local:test:planning"));

        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        let card = local_card(&mut connection);
        commit_card_close(&mut connection, &card.id, card.workflow_revision).unwrap();
        let revision = card.workflow_revision + 1;
        persist_runtime_cleanup_result(
            &connection,
            &card.id,
            &[RuntimeResourceOutcome {
                resource_type: "pty".into(),
                id: "shell".into(),
                success: false,
                error: Some("permission denied".into()),
            }],
        )
        .unwrap();
        let failed = get_card(&connection, &card.id).unwrap().unwrap();
        assert_eq!(failed.status, "done");
        assert_eq!(failed.workflow_revision, revision);
        assert_eq!(failed.runtime_cleanup_status.as_deref(), Some("failed"));
        assert!(failed
            .runtime_cleanup_error
            .as_deref()
            .unwrap()
            .contains("permission denied"));
        persist_runtime_cleanup_result(&connection, &card.id, &[]).unwrap();
        let recovered = get_card(&connection, &card.id).unwrap().unwrap();
        assert_eq!(recovered.workflow_revision, revision);
        assert_eq!(
            recovered.runtime_cleanup_status.as_deref(),
            Some("complete")
        );
        assert!(recovered.runtime_cleanup_error.is_none());
    }

    #[test]
    fn makes_card_ids_safe_for_directories() {
        assert_eq!(
            safe_card_key("superthread:42/../../oops"),
            "superthread_42_______oops"
        );
    }
}
