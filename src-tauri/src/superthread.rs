//! Tauri adapters for the shared `stacks-core` Superthread client.

use tauri::State;

pub use stacks_core::superthread::{
    resolve_api_token, token_from_login_shell, SuperthreadBoard, SuperthreadBoardsResponse,
    SuperthreadCard, SuperthreadConnectionResult, SuperthreadList, SuperthreadMappingDraft,
    SuperthreadMappingTestResult, SuperthreadService,
};

#[tauri::command]
pub async fn superthread_test_connection(
    service: State<'_, SuperthreadService>,
    api_token_env_var: String,
) -> Result<SuperthreadConnectionResult, String> {
    let service = service.inner().clone();
    run_blocking(move || service.test_connection(&api_token_env_var)).await
}

#[tauri::command]
pub async fn superthread_boards_for_space(
    service: State<'_, SuperthreadService>,
    space_id: String,
    api_token_env_var: String,
) -> Result<Vec<SuperthreadBoard>, String> {
    let service = service.inner().clone();
    run_blocking(move || service.boards_for_space(&space_id, &api_token_env_var)).await
}

#[tauri::command]
pub async fn superthread_boards(
    service: State<'_, SuperthreadService>,
    spaces: Vec<String>,
    refresh: bool,
    api_token_env_var: String,
) -> Result<SuperthreadBoardsResponse, String> {
    let service = service.inner().clone();
    run_blocking(move || {
        service.configure_token_env(&api_token_env_var)?;
        if refresh {
            service.invalidate_metadata();
        }
        service.boards(&spaces)
    })
    .await
}

#[tauri::command]
pub async fn superthread_board_lists(
    service: State<'_, SuperthreadService>,
    board_id: String,
    api_token_env_var: String,
) -> Result<Vec<SuperthreadList>, String> {
    let service = service.inner().clone();
    run_blocking(move || {
        service.configure_token_env(&api_token_env_var)?;
        service.board_lists(&board_id)
    })
    .await
}

#[tauri::command]
pub async fn superthread_board_cards(
    service: State<'_, SuperthreadService>,
    board_id: String,
    workspace_slug: Option<String>,
    api_token_env_var: String,
) -> Result<Vec<SuperthreadCard>, String> {
    let service = service.inner().clone();
    run_blocking(move || {
        service.configure_token_env(&api_token_env_var)?;
        service.board_cards(&board_id, workspace_slug.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn superthread_card(
    service: State<'_, SuperthreadService>,
    card_id: String,
    workspace_slug: Option<String>,
    api_token_env_var: String,
) -> Result<SuperthreadCard, String> {
    let service = service.inner().clone();
    run_blocking(move || {
        service.configure_token_env(&api_token_env_var)?;
        service.card(&card_id, workspace_slug.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn superthread_test_mapping(
    service: State<'_, SuperthreadService>,
    configuration: SuperthreadMappingDraft,
) -> Result<SuperthreadMappingTestResult, String> {
    let service = service.inner().clone();
    run_blocking(move || service.test_mapping(&configuration)).await
}

#[tauri::command]
pub async fn superthread_create_card(
    service: State<'_, SuperthreadService>,
    board_id: String,
    list_id: String,
    title: String,
    content: String,
    workspace_slug: Option<String>,
    api_token_env_var: String,
) -> Result<SuperthreadCard, String> {
    let service = service.inner().clone();
    run_blocking(move || {
        service.configure_token_env(&api_token_env_var)?;
        service.create_card(
            &board_id,
            &list_id,
            &title,
            &content,
            workspace_slug.as_deref(),
        )
    })
    .await
}

async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("Superthread worker failed: {error}"))?
}
