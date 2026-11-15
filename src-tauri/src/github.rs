pub use stacks_core::github::{
    repository_name, run_gh, GithubActionRunsResponse, GithubCurrentPullRequest,
    GithubPullRequestsResponse,
};

#[tauri::command]
pub async fn github_pull_requests(path: String) -> Result<GithubPullRequestsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        stacks_core::github::github_pull_requests(path)
    })
    .await
    .map_err(|error| format!("GitHub worker failed: {error}"))?
}

#[tauri::command]
pub async fn github_current_pull_request(
    path: String,
) -> Result<Option<GithubCurrentPullRequest>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        stacks_core::github::github_current_pull_request(path)
    })
    .await
    .map_err(|error| format!("GitHub worker failed: {error}"))?
}

#[tauri::command]
pub async fn github_action_runs(path: String) -> Result<GithubActionRunsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        stacks_core::github::github_action_runs(path)
    })
    .await
    .map_err(|error| format!("GitHub worker failed: {error}"))?
}

#[tauri::command]
pub async fn github_merge_pull_request(
    repository: String,
    number: u64,
    strategy: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        stacks_core::github::github_merge_pull_request(repository, number, strategy)
    })
    .await
    .map_err(|error| format!("GitHub worker failed: {error}"))?
}
