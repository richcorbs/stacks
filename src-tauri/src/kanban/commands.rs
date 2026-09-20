use super::repository::{fresh_card_snapshot, load_event_page};
use super::*;
#[allow(unused_imports)]
use super::{
    cards::*, cleanup::*, environment::*, github_delivery::*, local_delivery::*,
    scripted_delivery::*, sync::*,
};
use crate::superthread::SuperthreadService;

#[tauri::command]
pub fn kanban_cards() -> Result<BoardSnapshot, String> {
    kanban_cards_operation()
}

#[tauri::command]
pub fn kanban_card_snapshot(id: String) -> Result<CardSnapshot, String> {
    kanban_card_snapshot_operation(id)
}

#[tauri::command]
pub fn kanban_card_events(id: String, cursor: Option<CardEventCursor>, limit: Option<usize>) -> Result<CardEventPage, String> {
    with_read_connection(|connection| load_event_page(connection, &id, cursor, limit.unwrap_or(25)))
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
pub fn kanban_apply_workflow_action(
    id: String,
    action: WorkflowAction,
    expected_revision: i64,
) -> Result<CardSnapshot, String> {
    kanban_apply_workflow_action_operation(id, action, expected_revision)
}

#[tauri::command]
pub fn kanban_apply_pi_lifecycle_intent(
    id: String,
    thread: PiThread,
    intent: PiLifecycleIntent,
    generation: String,
    event_id: String,
    event_order: Option<i64>,
    failure_detail: Option<String>,
) -> Result<CardSnapshot, String> {
    kanban_apply_pi_lifecycle_intent_operation(
        id,
        thread,
        intent,
        generation,
        event_id,
        event_order,
        failure_detail,
    )
}

#[tauri::command]
pub fn kanban_record_agent_launch_failure(
    id: String,
    expected_workflow_revision: i64,
    expected_project_id: String,
    error_detail: String,
) -> Result<CardSnapshot, String> {
    kanban_record_agent_launch_failure_operation(
        id,
        expected_workflow_revision,
        expected_project_id,
        error_detail,
    )
}

#[tauri::command]
pub fn kanban_status_metadata() -> Vec<workflow::StatusMetadata> {
    kanban_status_metadata_operation()
}

#[tauri::command]
pub fn kanban_close_card(
    id: String,
    expected_revision: i64,
    pi_registry: State<'_, Mutex<PiRpcRegistry>>,
    pty_registry: State<'_, Mutex<PtyRegistry>>,
    service: State<'_, SuperthreadService>,
) -> Result<CardRuntimeCleanupResult, String> {
    let result =
        kanban_close_card_operation(id.clone(), expected_revision, pi_registry, pty_registry);
    let service = service.inner().clone();
    std::thread::spawn(move || {
        let _ = run_pending_once(service, Some(&id));
    });
    result
}

#[tauri::command]
pub fn kanban_retry_runtime_cleanup(
    id: String,
    pi_registry: State<'_, Mutex<PiRpcRegistry>>,
    pty_registry: State<'_, Mutex<PtyRegistry>>,
) -> Result<CardRuntimeCleanupResult, String> {
    kanban_retry_runtime_cleanup_operation(id, pi_registry, pty_registry)
}

#[tauri::command]
pub fn kanban_reorder_cards(
    status: CardStatus,
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
pub async fn kanban_start_environment(
    state: State<'_, WorkspaceSetupState>,
    service: State<'_, SuperthreadService>,
    id: String,
    expected_workflow_revision: i64,
    setup_command: String,
    custom_command: bool,
    explicit_retry: Option<bool>,
) -> Result<KanbanCard, String> {
    let card_id = id.clone();
    let result = kanban_start_environment_operation(
        state,
        id,
        expected_workflow_revision,
        setup_command,
        custom_command,
        explicit_retry,
    )
    .await;
    if result.is_ok() {
        let service = service.inner().clone();
        let _ =
            tauri::async_runtime::spawn_blocking(move || run_pending_once(service, Some(&card_id)))
                .await;
    }
    result
}

#[tauri::command]
pub async fn kanban_cleanup_environment_creation(id: String) -> Result<KanbanCard, String> {
    kanban_cleanup_environment_creation_operation(id).await
}

#[tauri::command]
pub fn kanban_environment_start_preflight(
    id: String,
    expected_workflow_revision: i64,
) -> Result<EnvironmentStartPreflight, String> {
    kanban_environment_start_preflight_operation(id, expected_workflow_revision)
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
) -> Result<WorkflowOperationResult, String> {
    kanban_approve_and_commit_operation(
        id,
        expected_workflow_revision,
        expected_environment_revision,
    )
    .await
}

#[tauri::command]
pub async fn kanban_scripted_push(id: String) -> Result<ScriptedDeliveryResult, String> {
    scripted_delivery::push(id).await
}

#[tauri::command]
pub async fn kanban_scripted_deploy(
    id: String,
    rerun_uncertain: Option<bool>,
) -> Result<ScriptedDeliveryResult, String> {
    scripted_delivery::deploy(id, rerun_uncertain.unwrap_or(false)).await
}

#[tauri::command]
pub fn kanban_cancel_scripted_deployment(id: String) -> Result<(), String> {
    scripted_delivery::cancel(id)
}

#[tauri::command]
pub fn kanban_confirm_scripted_deployed(id: String) -> Result<ScriptedDeliveryResult, String> {
    scripted_delivery::confirm(id)
}

#[tauri::command]
pub async fn kanban_merge_card(
    service: State<'_, SuperthreadService>,
    id: String,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
) -> Result<WorkflowOperationResult, String> {
    let card_id = id.clone();
    let result = kanban_merge_card_operation(
        id,
        expected_workflow_revision,
        expected_environment_revision,
    )
    .await;
    if result.is_ok() {
        let service = service.inner().clone();
        let _ =
            tauri::async_runtime::spawn_blocking(move || run_pending_once(service, Some(&card_id)))
                .await;
    }
    result
}

#[tauri::command]
pub async fn kanban_prepare_target_merge(
    id: String,
    expected_workflow_revision: i64,
    expected_environment_revision: i64,
) -> Result<TargetMergePrepareResult, String> {
    kanban_prepare_target_merge_operation(
        id,
        expected_workflow_revision,
        expected_environment_revision,
    )
    .await
}

#[tauri::command]
pub async fn kanban_finalize_target_merge(
    id: String,
    operation_id: String,
) -> Result<WorkflowOperationResult, String> {
    kanban_finalize_target_merge_operation(id, operation_id).await
}

#[tauri::command]
pub async fn kanban_abort_target_merge(
    id: String,
    operation_id: String,
) -> Result<KanbanCard, String> {
    kanban_abort_target_merge_operation(id, operation_id).await
}

#[tauri::command]
pub async fn kanban_cleanup_preflight(app: AppHandle, id: String) -> Result<CleanupPreflight, String> {
    kanban_cleanup_preflight_operation(app, id).await
}

#[tauri::command]
pub async fn kanban_cleanup_inventory(app: AppHandle, project_id: Option<String>) -> Result<CleanupInventory, String> {
    kanban_cleanup_inventory_operation(app, project_id).await
}

#[tauri::command]
pub async fn kanban_cleanup_environment(
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
    kanban_cleanup_environment_operation(
        app,
        id,
        expected_workflow_revision,
        expected_environment_revision,
        expected_source_revision,
        expected_target_revision,
        expected_repository_id,
        expected_primary_checkout,
        expected_target_branch,
        cleanup_anyway,
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
    feature_environment: bool,
) -> Result<KanbanCard, String> {
    kanban_create_pull_request_operation(id, expected_workflow_revision, feature_environment).await
}

#[tauri::command]
pub async fn kanban_merge_pull_request(
    service: State<'_, SuperthreadService>,
    id: String,
    expected_workflow_revision: i64,
) -> Result<KanbanCard, String> {
    let card_id = id.clone();
    let result = kanban_merge_pull_request_operation(id, expected_workflow_revision).await;
    if result.is_ok() {
        let service = service.inner().clone();
        let _ =
            tauri::async_runtime::spawn_blocking(move || run_pending_once(service, Some(&card_id)))
                .await;
    }
    result
}

#[tauri::command]
pub async fn kanban_sync_superthread_cards(
    service: State<'_, SuperthreadService>,
    owner_project_id: String,
    snapshot: SuperthreadSyncSnapshot,
) -> Result<BoardChange, String> {
    let result = kanban_sync_superthread_cards_operation(owner_project_id, snapshot)?;
    let provider = service.inner().clone();
    let _ = tauri::async_runtime::spawn_blocking(move || run_pending_once(provider, None)).await;
    Ok(result)
}

#[tauri::command]
pub async fn kanban_retry_provider_sync(
    service: State<'_, SuperthreadService>,
    id: String,
) -> Result<CardSnapshot, String> {
    let provider = service.inner().clone();
    let card_id = id.clone();
    tauri::async_runtime::spawn_blocking(move || run_pending_once(provider, Some(&card_id)))
        .await
        .map_err(|error| format!("Provider synchronization worker failed: {error}"))??;
    fresh_card_snapshot(&id)
}
