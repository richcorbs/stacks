pub use stacks_core::pi_paths::PiPathSuggestion;

#[tauri::command]
pub async fn discover_pi_paths(
    root: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<PiPathSuggestion>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        stacks_core::pi_paths::discover_pi_paths(root, query, limit)
    })
    .await
    .map_err(|error| format!("Path discovery task failed: {error}"))?
}
