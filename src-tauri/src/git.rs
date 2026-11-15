pub use stacks_core::git_repository::{
    GitChangeSummary, GitDiffFilesResponse, GitFileDiff, GitInfo,
};

#[tauri::command]
pub async fn git_info(path: String) -> Result<Option<GitInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || stacks_core::git_repository::git_info(path))
        .await
        .map_err(|_| "Git information could not be read. Retry refresh.".to_string())?
}

#[tauri::command]
pub async fn git_change_summary(
    path: String,
    target_branch: String,
) -> Result<GitChangeSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        stacks_core::git_repository::git_change_summary(path, target_branch)
    })
    .await
    .map_err(|error| format!("Git summary worker failed: {error}"))?
}

#[tauri::command]
pub async fn remove_git_worktree(
    repository_path: String,
    worktree_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        stacks_core::git_repository::remove_git_worktree(repository_path, worktree_path)
    })
    .await
    .map_err(|error| format!("Git worktree worker failed: {error}"))?
}

#[tauri::command]
pub async fn cleanup_git_worktree(
    repository_path: String,
    worktree_path: String,
    branch: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        stacks_core::git_repository::cleanup_git_worktree(repository_path, worktree_path, branch)
    })
    .await
    .map_err(|error| format!("Git cleanup worker failed: {error}"))?
}

#[tauri::command]
pub async fn git_diff_files(
    path: String,
    comparison_target: String,
) -> Result<GitDiffFilesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        stacks_core::git_repository::git_diff_files(path, comparison_target)
    })
    .await
    .map_err(|error| format!("Git diff worker failed: {error}"))?
}

#[tauri::command]
pub async fn git_file_diff(
    path: String,
    file: String,
    comparison_target: String,
) -> Result<GitFileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        stacks_core::git_repository::git_file_diff(path, file, comparison_target)
    })
    .await
    .map_err(|error| format!("Git diff worker failed: {error}"))?
}
