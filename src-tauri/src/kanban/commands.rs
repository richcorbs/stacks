use super::*;
use super::{cards::*, cleanup::*, environment::*, github_delivery::*, local_delivery::*, sync::*};

#[tauri::command]
pub fn kanban_cards() -> Result<BoardSnapshot, String> {
    kanban_cards_operation()
}
#[tauri::command]
pub fn kanban_card_snapshot(id: String) -> Result<CardSnapshot, String> {
    kanban_card_snapshot_operation(id)
}
#[tauri::command]
pub async fn kanban_environment_health(
    card_ids: Vec<String>,
) -> Result<Vec<CardEnvironmentHealth>, String> {
    kanban_environment_health_operation(card_ids).await
}
#[tauri::command]
pub fn kanban_create_local_card(
    project_id: String,
    title: String,
    content: String,
    parent_id: Option<String>,
) -> Result<CardSnapshot, String> {
    kanban_create_local_card_operation(project_id, title, content, parent_id)
}
#[tauri::command]
pub fn kanban_update_local_card(
    id: String,
    title: Option<String>,
    content: Option<String>,
    parent_id: Option<String>,
    parent_specified: Option<bool>,
) -> Result<CardSnapshot, String> {
    kanban_update_local_card_operation(id, title, content, parent_id, parent_specified)
}
#[tauri::command]
pub fn kanban_finish_local_refinement(
    id: String,
    title: Option<String>,
    content: String,
    children: Option<Vec<ApprovedChildSpec>>,
) -> Result<KanbanCard, String> {
    kanban_finish_local_refinement_operation(id, title, content, children)
}
#[tauri::command]
pub fn kanban_open_card(id: String) -> Result<String, String> {
    kanban_open_card_operation(id)
}
#[tauri::command]
pub fn kanban_sync_superthread_cards(
    cards: Vec<KanbanCardSnapshot>,
) -> Result<BoardSnapshot, String> {
    kanban_sync_superthread_cards_operation(cards)
}
#[tauri::command]
pub fn kanban_validate_project_deletion(project_id: String) -> Result<(), String> {
    kanban_validate_project_deletion_operation(project_id)
}
#[tauri::command]
pub fn kanban_delete_project_records(project_id: String) -> Result<(), String> {
    kanban_delete_project_records_operation(project_id)
}
#[tauri::command]
pub fn kanban_delete_card(id: String) -> Result<BoardChange, String> {
    kanban_delete_card_operation(id)
}
#[tauri::command]
pub fn kanban_set_status(
    id: String,
    status: String,
    expected_revision: i64,
    actor: String,
) -> Result<CardSnapshot, String> {
    kanban_set_status_operation(id, status, expected_revision, actor)
}
#[tauri::command]
pub fn kanban_close_card(id: String, expected_revision: i64) -> Result<CardSnapshot, String> {
    kanban_close_card_operation(id, expected_revision)
}
#[tauri::command]
pub fn kanban_reorder_cards(
    status: String,
    expected_card_ids: Vec<String>,
    card_ids: Vec<String>,
) -> Result<BoardChange, String> {
    kanban_reorder_cards_operation(status, expected_card_ids, card_ids)
}
#[tauri::command]
pub fn kanban_set_project(id: String, project_id: String) -> Result<CardSnapshot, String> {
    kanban_set_project_operation(id, project_id)
}
#[tauri::command]
pub fn kanban_environment_start_preflight(
    id: String,
    expected_workflow_revision: i64,
) -> Result<EnvironmentStartPreflight, String> {
    kanban_environment_start_preflight_operation(id, expected_workflow_revision)
}
#[tauri::command]
pub fn kanban_create_environment(
    id: String,
    worktree_path: String,
    repository_id: String,
    target_checkout_path: String,
    target_branch: String,
    target_revision: String,
    expected_workflow_revision: i64,
) -> Result<KanbanCard, String> {
    kanban_create_environment_operation(
        id,
        worktree_path,
        repository_id,
        target_checkout_path,
        target_branch,
        target_revision,
        expected_workflow_revision,
    )
}
#[tauri::command]
pub fn kanban_save_environment_layout(
    id: String,
    split_layout: serde_json::Value,
    focused_pane_id: Option<String>,
    panes: Vec<CardPane>,
    expected_layout_revision: i64,
) -> Result<KanbanCard, String> {
    kanban_save_environment_layout_operation(
        id,
        split_layout,
        focused_pane_id,
        panes,
        expected_layout_revision,
    )
}
#[tauri::command]
pub fn kanban_set_merge_target(
    id: String,
    target_checkout_path: String,
    expected_environment_revision: i64,
) -> Result<KanbanCard, String> {
    kanban_set_merge_target_operation(id, target_checkout_path, expected_environment_revision)
}
#[tauri::command]
pub async fn kanban_approve_and_commit(
    id: String,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
    feature_environment: Option<bool>,
) -> Result<WorkflowOperationResult, String> {
    kanban_approve_and_commit_operation(
        id,
        expected_workflow_revision,
        expected_environment_revision,
        feature_environment,
    )
    .await
}
#[tauri::command]
pub async fn kanban_merge_card(
    id: String,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
) -> Result<WorkflowOperationResult, String> {
    kanban_merge_card_operation(
        id,
        expected_workflow_revision,
        expected_environment_revision,
    )
    .await
}
#[tauri::command]
pub async fn kanban_cleanup_environment(
    app: AppHandle,
    id: String,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
) -> Result<KanbanCard, String> {
    kanban_cleanup_environment_operation(
        app,
        id,
        expected_workflow_revision,
        expected_environment_revision,
    )
    .await
}
#[tauri::command]
pub async fn kanban_refresh_pull_request(
    id: String,
) -> Result<KanbanPullRequestRefreshResult, String> {
    kanban_refresh_pull_request_operation(id).await
}
#[tauri::command]
pub async fn kanban_create_pull_request(
    id: String,
    expected_workflow_revision: i64,
) -> Result<KanbanCard, String> {
    kanban_create_pull_request_operation(id, expected_workflow_revision).await
}
#[tauri::command]
pub async fn kanban_merge_pull_request(
    id: String,
    expected_workflow_revision: i64,
) -> Result<KanbanCard, String> {
    kanban_merge_pull_request_operation(id, expected_workflow_revision).await
}
