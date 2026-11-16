pub use stacks_core::release::{
    ReleaseAction, ReleaseSetup, ReleaseState,
};

#[tauri::command]
pub fn release_setup(project_id: String) -> Result<ReleaseSetup, String> {
    let store = crate::profile_store()?;
    stacks_core::release::release_setup(&store, project_id)
}

#[tauri::command]
pub fn release_command(
    project_id: String,
    version: String,
    expected_cwd: String,
    expected_terminal_id: String,
    action: Option<ReleaseAction>,
) -> Result<String, String> {
    let store = crate::profile_store()?;
    stacks_core::release::release_command(
        &store,
        project_id,
        version,
        expected_cwd,
        expected_terminal_id,
        action,
    )
}

#[tauri::command]
pub async fn release_state(
    project_id: String,
    version: String,
) -> Result<Option<ReleaseState>, String> {
    let store = crate::profile_store()?;
    tauri::async_runtime::spawn_blocking(move || {
        stacks_core::release::release_state(&store, project_id, version)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn release_latest(project_id: String) -> Result<String, String> {
    let store = crate::profile_store()?;
    tauri::async_runtime::spawn_blocking(move || {
        stacks_core::release::release_latest(&store, project_id)
    })
    .await
    .map_err(|error| error.to_string())?
}
