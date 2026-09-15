use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
    process::Command,
};

const MAX_DIFF_SOURCE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
const MAX_DIFF_LINES: usize = 20_000;

#[derive(Debug, Clone, Serialize)]
pub struct GitInfo {
    branch: String,
    created: u32,
    changed: u32,
    deleted: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitChangeSummary {
    added: u32,
    modified: u32,
    deleted: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffFile {
    path: String,
    status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffFilesResponse {
    files: Vec<GitDiffFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    path: String,
    patch: String,
}

fn parse_git_status(text: &str) -> (u32, u32, u32) {
    let mut created_files = HashSet::new();
    let mut changed_files = HashSet::new();
    let mut deleted_files = HashSet::new();

    for line in text.lines() {
        if line.len() < 4 {
            continue;
        }

        let status = &line[..2];
        let path = line[3..]
            .rsplit_once(" -> ")
            .map(|(_, to)| to)
            .unwrap_or(&line[3..]);
        let index = status.as_bytes()[0] as char;
        let worktree = status.as_bytes()[1] as char;

        if status == "??" || index == 'A' || worktree == 'A' {
            created_files.insert(path.to_string());
        } else if index == 'D' || worktree == 'D' {
            deleted_files.insert(path.to_string());
        } else if [index, worktree]
            .iter()
            .any(|c| matches!(c, 'M' | 'R' | 'C' | 'T' | 'U'))
        {
            changed_files.insert(path.to_string());
        }
    }

    (
        created_files.len() as u32,
        changed_files.len() as u32,
        deleted_files.len() as u32,
    )
}

#[tauri::command]
pub fn git_info(path: String) -> Result<Option<GitInfo>, String> {
    let output = Command::new("git")
        .args(["-C", &path, "branch", "--show-current"])
        .output()
        .map_err(|err| err.to_string())?;

    if !output.status.success() {
        return Ok(None);
    }

    let mut branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() {
        let output = Command::new("git")
            .args(["-C", &path, "rev-parse", "--short", "HEAD"])
            .output()
            .map_err(|err| err.to_string())?;
        if !output.status.success() {
            return Ok(None);
        }
        branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    }

    if branch.is_empty() {
        return Ok(None);
    }

    let (created, changed, deleted) = if let Ok(output) = Command::new("git")
        .args([
            "-C",
            &path,
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
        ])
        .output()
    {
        if output.status.success() {
            parse_git_status(&String::from_utf8_lossy(&output.stdout))
        } else {
            (0, 0, 0)
        }
    } else {
        (0, 0, 0)
    };

    Ok(Some(GitInfo {
        branch,
        created,
        changed,
        deleted,
    }))
}

fn command_error(output: &std::process::Output, fallback: &str) -> String {
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if detail.is_empty() {
        fallback.to_string()
    } else {
        detail
    }
}

fn parse_snapshot_diff(output: &[u8]) -> Result<HashMap<Vec<u8>, char>, String> {
    let entries = output
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>();
    let mut files = HashMap::new();
    let mut index = 0;
    while index < entries.len() {
        let status = entries[index];
        let Some(kind) = status.first().copied().map(char::from) else {
            return Err("Git returned an empty file status".to_string());
        };
        let renamed_or_copied = matches!(kind, 'R' | 'C');
        let path_index = index + if renamed_or_copied { 2 } else { 1 };
        let Some(path) = entries.get(path_index) else {
            return Err("Git returned an incomplete file status record".to_string());
        };
        files.insert(path.to_vec(), kind);
        index += if renamed_or_copied { 3 } else { 2 };
    }
    Ok(files)
}

fn load_git_change_summary(path: &str, target_branch: &str) -> Result<GitChangeSummary, String> {
    let target_branch = target_branch.trim();
    if target_branch.is_empty() {
        return Err("The target branch is required".to_string());
    }
    let target_ref = format!("refs/heads/{target_branch}");
    let valid_ref = Command::new("git")
        .args(["check-ref-format", &target_ref])
        .status()
        .map_err(|error| error.to_string())?;
    if !valid_ref.success() {
        return Err("The target branch name is invalid".to_string());
    }

    let merge_base = Command::new("git")
        .args(["-C", path, "merge-base", "HEAD", &target_ref])
        .output()
        .map_err(|error| error.to_string())?;
    if !merge_base.status.success() {
        return Err(command_error(
            &merge_base,
            "Could not resolve the target branch merge base",
        ));
    }
    let merge_base = String::from_utf8_lossy(&merge_base.stdout)
        .trim()
        .to_string();
    if merge_base.is_empty() {
        return Err("Could not resolve the target branch merge base".to_string());
    }

    // Comparing a tree-ish directly to the working tree combines committed, indexed,
    // and unstaged tracked changes into each file's final state relative to the base.
    let diff = Command::new("git")
        .args([
            "-C",
            path,
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            "--find-copies-harder",
            &merge_base,
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !diff.status.success() {
        return Err(command_error(&diff, "Could not compare the card worktree"));
    }
    let mut files = parse_snapshot_diff(&diff.stdout)?;

    let untracked = Command::new("git")
        .args([
            "-C",
            path,
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !untracked.status.success() {
        return Err(command_error(&untracked, "Could not list untracked files"));
    }
    for path in untracked
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        files.entry(path.to_vec()).or_insert('A');
    }

    Ok(GitChangeSummary {
        added: files.values().filter(|status| **status == 'A').count() as u32,
        modified: files
            .values()
            .filter(|status| !matches!(**status, 'A' | 'D'))
            .count() as u32,
        deleted: files.values().filter(|status| **status == 'D').count() as u32,
    })
}

#[tauri::command]
pub async fn git_change_summary(
    path: String,
    target_branch: String,
) -> Result<GitChangeSummary, String> {
    tauri::async_runtime::spawn_blocking(move || load_git_change_summary(&path, &target_branch))
        .await
        .map_err(|error| format!("Git summary worker failed: {error}"))?
}

fn repository_root(path: &str) -> Result<String, String> {
    let output = Command::new("git")
        .args(["-C", path, "rev-parse", "--show-toplevel"])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("The selected workspace is not in a Git repository".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn listed_worktrees(repository_path: &str) -> Result<Vec<PathBuf>, String> {
    let output = Command::new("git")
        .args([
            "-C",
            repository_path,
            "worktree",
            "list",
            "--porcelain",
            "-z",
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter_map(|entry| entry.strip_prefix(b"worktree "))
        .map(|path| PathBuf::from(String::from_utf8_lossy(path).into_owned()))
        .collect())
}

fn same_existing_path(left: &Path, right: &Path) -> bool {
    left == right
        || match (left.canonicalize(), right.canonicalize()) {
            (Ok(left), Ok(right)) => left == right,
            _ => false,
        }
}

fn remove_registered_worktree(repository_path: &str, worktree_path: &str) -> Result<(), String> {
    let repository = Path::new(repository_path);
    let worktree = Path::new(worktree_path);
    if same_existing_path(repository, worktree) {
        return Err("Refusing to remove the project's primary working tree".to_string());
    }

    let registered = listed_worktrees(repository_path)?;
    let Some(registered_path) = registered
        .iter()
        .find(|path| same_existing_path(path, worktree))
    else {
        if !worktree.exists() {
            return Ok(());
        }
        return Err("The workspace directory is not a registered Git worktree".to_string());
    };

    let output = Command::new("git")
        .args(["-C", repository_path, "worktree", "remove"])
        .arg(registered_path)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "Git could not remove the workspace worktree".to_string()
        } else {
            detail
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_git_worktree(
    repository_path: String,
    worktree_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        remove_registered_worktree(&repository_path, &worktree_path)
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
        let branch = branch.trim();
        if worktree_path.trim().is_empty() || repository_path.trim().is_empty() {
            return Err("Repository and worktree paths are required".to_string());
        }
        if Path::new(&worktree_path).exists() {
            let actual_branch = Command::new("git")
                .args(["-C", &worktree_path, "branch", "--show-current"])
                .output()
                .map_err(|error| error.to_string())?;
            if !actual_branch.status.success() {
                return Err("Could not determine the worktree branch".to_string());
            }
            let actual_branch = String::from_utf8_lossy(&actual_branch.stdout)
                .trim()
                .to_string();
            if !branch.is_empty() && !actual_branch.is_empty() && actual_branch != branch {
                return Err("The worktree branch changed before cleanup".to_string());
            }
        }
        remove_registered_worktree(&repository_path, &worktree_path)?;
        if branch.is_empty() {
            return Ok(());
        }
        let exists = Command::new("git")
            .args([
                "-C",
                &repository_path,
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ])
            .status()
            .map_err(|error| error.to_string())?;
        if !exists.success() {
            return Ok(());
        }
        let deleted = Command::new("git")
            .args(["-C", &repository_path, "branch", "-d", "--", branch])
            .output()
            .map_err(|error| error.to_string())?;
        if !deleted.status.success() {
            let detail = String::from_utf8_lossy(&deleted.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                "Git could not delete the card branch".to_string()
            } else {
                detail
            });
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("Git cleanup worker failed: {error}"))?
}

fn safe_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Invalid diff file path".to_string());
    }
    Ok(())
}

fn ensure_diff_sources_bounded(root: &str, base: &str, file: &str) -> Result<(), String> {
    if let Ok(metadata) = std::fs::symlink_metadata(Path::new(root).join(file)) {
        if metadata.len() > MAX_DIFF_SOURCE_BYTES {
            return Err("The selected file is too large to display".to_string());
        }
    }
    ensure_git_blob_bounded(root, base, file)?;

    // A renamed file's base blob is stored under its old path, so checking only the
    // final path would allow a large source blob through before patch generation.
    let names = Command::new("git")
        .args([
            "-C",
            root,
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            "--find-copies-harder",
            base,
            "--",
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !names.status.success() {
        return Err(command_error(
            &names,
            "Could not inspect the selected diff sources",
        ));
    }
    let entries = names
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>();
    let mut index = 0;
    while index < entries.len() {
        let renamed_or_copied = entries[index]
            .first()
            .is_some_and(|status| matches!(*status, b'R' | b'C'));
        if renamed_or_copied
            && entries
                .get(index + 2)
                .is_some_and(|path| *path == file.as_bytes())
        {
            if let Some(old_path) = entries.get(index + 1) {
                ensure_git_blob_bounded(root, base, &String::from_utf8_lossy(old_path))?;
            }
        }
        index += if renamed_or_copied { 3 } else { 2 };
    }
    Ok(())
}

fn ensure_git_blob_bounded(root: &str, tree: &str, file: &str) -> Result<(), String> {
    if let Ok(output) = Command::new("git")
        .args(["-C", root, "cat-file", "-s", &format!("{tree}:{file}")])
        .output()
    {
        if output.status.success()
            && String::from_utf8_lossy(&output.stdout)
                .trim()
                .parse::<u64>()
                .unwrap_or(0)
                > MAX_DIFF_SOURCE_BYTES
        {
            return Err("The selected file is too large to display".to_string());
        }
    }
    Ok(())
}

fn ensure_patch_bounded(patch: &str) -> Result<(), String> {
    if patch.len() > MAX_DIFF_BYTES || patch.lines().count() > MAX_DIFF_LINES {
        return Err("The selected diff is too large to display".to_string());
    }
    Ok(())
}

fn display_status(status: &str) -> String {
    (if status == "??" || status.contains('A') {
        "A"
    } else if status.contains('D') {
        "D"
    } else if status.contains('R') {
        "R"
    } else if status.contains('U') {
        "U"
    } else {
        "M"
    })
    .to_string()
}

fn resolve_comparison_base(root: &str, comparison_target: &str) -> Result<String, String> {
    let comparison_target = comparison_target.trim();
    if !comparison_target.starts_with("refs/") {
        return Err(
            "The comparison target must be a full Git ref, such as refs/heads/main".to_string(),
        );
    }
    let valid = Command::new("git")
        .args(["check-ref-format", comparison_target])
        .output()
        .map_err(|error| error.to_string())?;
    if !valid.status.success() {
        return Err(format!(
            "The comparison target ref is invalid: {comparison_target}"
        ));
    }
    let available = Command::new("git")
        .args([
            "-C",
            root,
            "show-ref",
            "--verify",
            "--quiet",
            comparison_target,
        ])
        .status()
        .map_err(|error| error.to_string())?;
    if !available.success() {
        return Err(format!("The comparison target ref is unavailable locally: {comparison_target}. Create or fetch it outside Stacks, then refresh Diff."));
    }
    let commit_target = format!("{comparison_target}^{{commit}}");
    let resolves_to_commit = Command::new("git")
        .args([
            "-C",
            root,
            "rev-parse",
            "--verify",
            "--quiet",
            &commit_target,
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !resolves_to_commit.status.success() {
        return Err(format!(
            "The comparison target does not resolve to a commit: {comparison_target}"
        ));
    }
    let merge_base = Command::new("git")
        .args(["-C", root, "merge-base", "HEAD", comparison_target])
        .output()
        .map_err(|error| error.to_string())?;
    if !merge_base.status.success() {
        return Err(command_error(
            &merge_base,
            &format!("Could not find a merge base between HEAD and {comparison_target}"),
        ));
    }
    let merge_base = String::from_utf8_lossy(&merge_base.stdout)
        .trim()
        .to_string();
    if merge_base.is_empty() {
        return Err(format!(
            "Could not find a merge base between HEAD and {comparison_target}"
        ));
    }
    Ok(merge_base)
}

fn snapshot_diff_files(root: &str, base: &str) -> Result<Vec<GitDiffFile>, String> {
    let output = Command::new("git")
        .args([
            "-C",
            root,
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            "--find-copies-harder",
            base,
            "--",
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(command_error(
            &output,
            "Could not compare the repository working tree",
        ));
    }
    let mut snapshot = parse_snapshot_diff(&output.stdout)?;

    let untracked = Command::new("git")
        .args([
            "-C",
            root,
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !untracked.status.success() {
        return Err(command_error(&untracked, "Could not list untracked files"));
    }
    for path in untracked
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        snapshot.entry(path.to_vec()).or_insert('A');
    }

    let mut files = snapshot
        .into_iter()
        .map(|(path, status)| GitDiffFile {
            path: String::from_utf8_lossy(&path).to_string(),
            status: display_status(&status.to_string()),
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

#[tauri::command]
pub async fn git_diff_files(
    path: String,
    comparison_target: String,
) -> Result<GitDiffFilesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || load_git_diff_files(&path, &comparison_target))
        .await
        .map_err(|error| format!("Git diff worker failed: {error}"))?
}

fn load_git_diff_files(
    path: &str,
    comparison_target: &str,
) -> Result<GitDiffFilesResponse, String> {
    let root = repository_root(path)?;
    let base = resolve_comparison_base(&root, comparison_target)?;
    Ok(GitDiffFilesResponse {
        files: snapshot_diff_files(&root, &base)?,
    })
}

#[tauri::command]
pub async fn git_file_diff(
    path: String,
    file: String,
    comparison_target: String,
) -> Result<GitFileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        load_git_file_diff(&path, &file, &comparison_target)
    })
    .await
    .map_err(|error| format!("Git diff worker failed: {error}"))?
}

fn load_git_file_diff(
    path: &str,
    file: &str,
    comparison_target: &str,
) -> Result<GitFileDiff, String> {
    safe_relative_path(file)?;
    let root = repository_root(path)?;
    let base = resolve_comparison_base(&root, comparison_target)?;
    ensure_diff_sources_bounded(&root, &base, file)?;
    let output = Command::new("git")
        .args([
            "-C",
            &root,
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--unified=10",
            &base,
            "--",
            file,
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(command_error(
            &output,
            "Could not generate the selected file diff",
        ));
    }
    let mut patch = String::from_utf8_lossy(&output.stdout).to_string();
    if patch.is_empty() {
        let tracked = Command::new("git")
            .args(["-C", &root, "ls-files", "--error-unmatch", "--", file])
            .output()
            .map_err(|error| error.to_string())?
            .status
            .success();
        if tracked {
            return Err("This file no longer has changes; refresh the diff file tree".to_string());
        }
        let file_path = Path::new(&root).join(file);
        let is_symlink = std::fs::symlink_metadata(&file_path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false);
        let text = if is_symlink {
            std::fs::read_link(&file_path)
                .map_err(|error| format!("Could not read {file}: {error}"))?
                .to_string_lossy()
                .to_string()
        } else {
            String::from_utf8(
                std::fs::read(&file_path)
                    .map_err(|error| format!("Could not read {file}: {error}"))?,
            )
            .map_err(|_| "Binary files cannot be displayed".to_string())?
        };
        let mode = if is_symlink { "120000" } else { "100644" };
        patch = format!("diff --git a/{file} b/{file}\nnew file mode {mode}\n--- /dev/null\n+++ b/{file}\n@@ -0,0 +1,{} @@\n{}", text.lines().count(), text.lines().map(|line| format!("+{line}\n")).collect::<String>());
    }
    ensure_patch_bounded(&patch)?;
    Ok(GitFileDiff {
        path: file.to_string(),
        patch,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn test_repository(name: &str) -> (PathBuf, PathBuf) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("stacks-{name}-{}-{nonce}", std::process::id()));
        let repository = root.join("repository");
        let worktree = root.join("worktree");
        fs::create_dir_all(&repository).unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("git").args(args).output().unwrap();
            assert!(
                output.status.success(),
                "git failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["-C", repository.to_str().unwrap(), "init", "-b", "main"]);
        git(&[
            "-C",
            repository.to_str().unwrap(),
            "config",
            "user.email",
            "stacks@example.com",
        ]);
        git(&[
            "-C",
            repository.to_str().unwrap(),
            "config",
            "user.name",
            "Stacks Tests",
        ]);
        fs::write(repository.join("README.md"), "test\n").unwrap();
        fs::write(repository.join("base-delete.txt"), "delete me\n").unwrap();
        git(&[
            "-C",
            repository.to_str().unwrap(),
            "add",
            "README.md",
            "base-delete.txt",
        ]);
        git(&[
            "-C",
            repository.to_str().unwrap(),
            "commit",
            "-m",
            "Initial",
        ]);
        git(&[
            "-C",
            repository.to_str().unwrap(),
            "worktree",
            "add",
            "-b",
            "feature",
            worktree.to_str().unwrap(),
        ]);
        (repository, worktree)
    }

    fn git(path: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn commit_all(path: &Path, message: &str) {
        git(path, &["add", "-A"]);
        git(path, &["commit", "-m", message]);
    }

    fn summary(worktree: &Path) -> GitChangeSummary {
        load_git_change_summary(worktree.to_str().unwrap(), "main").unwrap()
    }

    fn diff_files(worktree: &Path) -> Vec<GitDiffFile> {
        load_git_diff_files(worktree.to_str().unwrap(), "refs/heads/main")
            .unwrap()
            .files
    }

    fn clean_up(repository: &Path) {
        fs::remove_dir_all(repository.parent().unwrap()).unwrap();
    }

    #[test]
    fn summarizes_committed_additions_modifications_and_deletions() {
        let (repository, worktree) = test_repository("summary-committed");
        fs::write(worktree.join("README.md"), "changed\n").unwrap();
        fs::write(worktree.join("added.txt"), "added\n").unwrap();
        fs::remove_file(worktree.join("base-delete.txt")).unwrap();
        commit_all(&worktree, "final committed state");
        assert_eq!(
            summary(&worktree),
            GitChangeSummary {
                added: 1,
                modified: 1,
                deleted: 1
            }
        );

        fs::write(repository.join("from-base.txt"), "base\n").unwrap();
        commit_all(&repository, "advance target");
        // The target-only file is after the merge base and must not appear as a source deletion.
        assert_eq!(
            summary(&worktree),
            GitChangeSummary {
                added: 1,
                modified: 1,
                deleted: 1
            }
        );
        clean_up(&repository);
    }

    #[test]
    fn summarizes_staged_unstaged_untracked_and_deleted_files() {
        let (repository, worktree) = test_repository("summary-working-tree");
        fs::write(worktree.join("staged.txt"), "staged\n").unwrap();
        git(&worktree, &["add", "staged.txt"]);
        fs::write(worktree.join("README.md"), "unstaged\n").unwrap();
        fs::write(worktree.join("untracked name.txt"), "untracked\n").unwrap();
        fs::remove_file(worktree.join("base-delete.txt")).unwrap();
        assert_eq!(
            summary(&worktree),
            GitChangeSummary {
                added: 2,
                modified: 1,
                deleted: 1
            }
        );
        clean_up(&repository);
    }

    #[test]
    fn combines_committed_and_uncommitted_changes_without_double_counting() {
        let (repository, worktree) = test_repository("summary-combined");
        fs::write(worktree.join("README.md"), "committed change\n").unwrap();
        commit_all(&worktree, "change readme");
        fs::write(worktree.join("README.md"), "working change\n").unwrap();
        assert_eq!(
            summary(&worktree),
            GitChangeSummary {
                added: 0,
                modified: 1,
                deleted: 0
            }
        );
        clean_up(&repository);
    }

    #[test]
    fn uses_final_worktree_state_relative_to_the_merge_base() {
        let (repository, worktree) = test_repository("summary-final-state");
        fs::write(worktree.join("temporary.txt"), "temporary\n").unwrap();
        fs::write(worktree.join("README.md"), "committed change\n").unwrap();
        commit_all(&worktree, "temporary branch changes");
        fs::remove_file(worktree.join("temporary.txt")).unwrap();
        fs::write(worktree.join("README.md"), "test\n").unwrap();
        assert_eq!(
            summary(&worktree),
            GitChangeSummary {
                added: 0,
                modified: 0,
                deleted: 0
            }
        );
        clean_up(&repository);
    }

    #[test]
    fn classifies_renames_and_copies_as_modified_with_unusual_names() {
        let (repository, worktree) = test_repository("summary-renames");
        fs::copy(
            worktree.join("README.md"),
            worktree.join("copy with spaces.txt"),
        )
        .unwrap();
        git(&worktree, &["add", "copy with spaces.txt"]);
        git(&worktree, &["mv", "README.md", "renamed\nfile.md"]);
        assert_eq!(
            summary(&worktree),
            GitChangeSummary {
                added: 0,
                modified: 2,
                deleted: 0
            }
        );
        clean_up(&repository);
    }

    #[test]
    fn uses_the_head_target_merge_base_for_divergent_history() {
        let (repository, worktree) = test_repository("summary-divergent");
        fs::write(repository.join("target-only.txt"), "target\n").unwrap();
        commit_all(&repository, "target change");
        fs::write(worktree.join("source-only.txt"), "source\n").unwrap();
        commit_all(&worktree, "source change");
        assert_eq!(
            summary(&worktree),
            GitChangeSummary {
                added: 1,
                modified: 0,
                deleted: 0
            }
        );
        clean_up(&repository);
    }

    #[test]
    fn returns_clean_counts_and_rejects_a_missing_local_target() {
        let (repository, worktree) = test_repository("summary-clean");
        assert_eq!(
            summary(&worktree),
            GitChangeSummary {
                added: 0,
                modified: 0,
                deleted: 0
            }
        );
        assert!(load_git_change_summary(worktree.to_str().unwrap(), "missing").is_err());
        clean_up(&repository);
    }

    #[test]
    fn lists_committed_staged_unstaged_untracked_and_deleted_final_changes() {
        let (repository, worktree) = test_repository("diff-combined");
        fs::write(worktree.join("README.md"), "committed\n").unwrap();
        commit_all(&worktree, "committed branch change");
        fs::write(worktree.join("README.md"), "final working state\n").unwrap();
        fs::write(worktree.join("staged.txt"), "staged\n").unwrap();
        git(&worktree, &["add", "staged.txt"]);
        fs::write(worktree.join("untracked name.txt"), "untracked\n").unwrap();
        fs::remove_file(worktree.join("base-delete.txt")).unwrap();

        let files = diff_files(&worktree);
        assert_eq!(
            files
                .iter()
                .map(|file| (file.path.as_str(), file.status.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("README.md", "M"),
                ("base-delete.txt", "D"),
                ("staged.txt", "A"),
                ("untracked name.txt", "A"),
            ]
        );
        let patch = load_git_file_diff(worktree.to_str().unwrap(), "README.md", "refs/heads/main")
            .unwrap()
            .patch;
        assert!(patch.contains("-test"));
        assert!(patch.contains("+final working state"));
        let untracked_patch = load_git_file_diff(
            worktree.to_str().unwrap(),
            "untracked name.txt",
            "refs/heads/main",
        )
        .unwrap()
        .patch;
        assert!(untracked_patch.contains("+untracked"));
        for file in &files {
            let selected =
                load_git_file_diff(worktree.to_str().unwrap(), &file.path, "refs/heads/main")
                    .unwrap();
            assert_eq!(selected.path, file.path);
            assert!(!selected.patch.is_empty());
        }
        clean_up(&repository);
    }

    #[test]
    fn omits_committed_changes_reverted_in_the_worktree() {
        let (repository, worktree) = test_repository("diff-reverted");
        fs::write(worktree.join("README.md"), "committed\n").unwrap();
        commit_all(&worktree, "temporary change");
        fs::write(worktree.join("README.md"), "test\n").unwrap();
        assert!(diff_files(&worktree).is_empty());
        clean_up(&repository);
    }

    #[test]
    fn compares_direct_target_work_to_the_local_remote_tracking_ref() {
        let (repository, _worktree) = test_repository("diff-remote-target");
        git(
            &repository,
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        fs::write(repository.join("README.md"), "unpushed target commit\n").unwrap();
        commit_all(&repository, "unpushed main work");
        let files = load_git_diff_files(repository.to_str().unwrap(), "refs/remotes/origin/main")
            .unwrap()
            .files;
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "README.md");
        assert_eq!(files[0].status, "M");
        clean_up(&repository);
    }

    #[test]
    fn uses_merge_base_and_handles_renames_unusual_names_binary_and_symlinks() {
        let (repository, worktree) = test_repository("diff-edge-cases");
        fs::write(repository.join("target-only.txt"), "target\n").unwrap();
        commit_all(&repository, "advance target only");
        git(&worktree, &["mv", "README.md", "renamed\nfile.md"]);
        fs::write(worktree.join("binary.dat"), [0, 159, 146, 150]).unwrap();
        git(&worktree, &["add", "binary.dat"]);
        #[cfg(unix)]
        std::os::unix::fs::symlink("renamed\nfile.md", worktree.join("link")).unwrap();

        let files = diff_files(&worktree);
        assert!(files
            .iter()
            .any(|file| file.path == "renamed\nfile.md" && file.status == "R"));
        assert!(files
            .iter()
            .any(|file| file.path == "binary.dat" && file.status == "A"));
        assert!(!files.iter().any(|file| file.path == "target-only.txt"));
        #[cfg(unix)]
        {
            assert!(files
                .iter()
                .any(|file| file.path == "link" && file.status == "A"));
            let patch = load_git_file_diff(worktree.to_str().unwrap(), "link", "refs/heads/main")
                .unwrap()
                .patch;
            assert!(patch.contains("new file mode 120000"));
        }
        let binary_patch =
            load_git_file_diff(worktree.to_str().unwrap(), "binary.dat", "refs/heads/main")
                .unwrap()
                .patch;
        assert!(binary_patch.contains("Binary files"));
        clean_up(&repository);
    }

    #[test]
    fn rejects_missing_invalid_and_non_full_comparison_refs() {
        let (repository, worktree) = test_repository("diff-invalid-ref");
        let missing =
            load_git_diff_files(worktree.to_str().unwrap(), "refs/heads/missing").unwrap_err();
        assert!(missing.contains("unavailable locally"));
        let invalid =
            load_git_diff_files(worktree.to_str().unwrap(), "refs/heads/bad..ref").unwrap_err();
        assert!(invalid.contains("invalid"));
        let short = load_git_diff_files(worktree.to_str().unwrap(), "main").unwrap_err();
        assert!(short.contains("full Git ref"));
        clean_up(&repository);
    }

    #[test]
    fn bounds_the_comparison_base_blob_before_generating_a_deletion_patch() {
        let (repository, _worktree) = test_repository("diff-large-base");
        fs::write(
            repository.join("large.txt"),
            vec![b'x'; MAX_DIFF_SOURCE_BYTES as usize + 1],
        )
        .unwrap();
        commit_all(&repository, "large base file");
        fs::remove_file(repository.join("large.txt")).unwrap();
        let error =
            load_git_file_diff(repository.to_str().unwrap(), "large.txt", "refs/heads/main")
                .unwrap_err();
        assert!(error.contains("too large"));
        git(&repository, &["restore", "large.txt"]);
        git(&repository, &["mv", "large.txt", "renamed-large.txt"]);
        let rename_error = load_git_file_diff(
            repository.to_str().unwrap(),
            "renamed-large.txt",
            "refs/heads/main",
        )
        .unwrap_err();
        assert!(rename_error.contains("too large"));
        clean_up(&repository);
    }

    #[test]
    fn removes_only_a_registered_clean_worktree() {
        let (repository, worktree) = test_repository("remove-worktree");
        remove_registered_worktree(repository.to_str().unwrap(), worktree.to_str().unwrap())
            .unwrap();
        assert!(!worktree.exists());
        let remaining = listed_worktrees(repository.to_str().unwrap()).unwrap();
        assert_eq!(remaining.len(), 1);
        assert!(same_existing_path(&remaining[0], &repository));
        fs::remove_dir_all(repository.parent().unwrap()).unwrap();
    }

    #[test]
    fn refuses_to_remove_a_dirty_or_primary_worktree() {
        let (repository, worktree) = test_repository("protect-worktree");
        fs::write(worktree.join("uncommitted.txt"), "keep me\n").unwrap();
        let error =
            remove_registered_worktree(repository.to_str().unwrap(), worktree.to_str().unwrap())
                .unwrap_err();
        assert!(
            error.contains("modified or untracked files"),
            "unexpected error: {error}"
        );
        assert!(worktree.exists());
        assert!(remove_registered_worktree(
            repository.to_str().unwrap(),
            repository.to_str().unwrap()
        )
        .unwrap_err()
        .contains("primary working tree"));
        fs::remove_dir_all(repository.parent().unwrap()).unwrap();
    }
}
