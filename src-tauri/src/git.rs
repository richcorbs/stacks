use serde::Serialize;
use std::{collections::HashSet, path::{Component, Path}, process::Command};

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffFile {
    path: String,
    status: String,
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
        let path = line[3..].rsplit_once(" -> ").map(|(_, to)| to).unwrap_or(&line[3..]);
        let index = status.as_bytes()[0] as char;
        let worktree = status.as_bytes()[1] as char;

        if status == "??" || index == 'A' || worktree == 'A' {
            created_files.insert(path.to_string());
        } else if index == 'D' || worktree == 'D' {
            deleted_files.insert(path.to_string());
        } else if [index, worktree].iter().any(|c| matches!(c, 'M' | 'R' | 'C' | 'T' | 'U')) {
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
        .args(["-C", &path, "status", "--porcelain=v1", "--untracked-files=all"])
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

    Ok(Some(GitInfo { branch, created, changed, deleted }))
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

fn safe_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty() || Path::new(path).is_absolute() || Path::new(path).components().any(|component| matches!(component, Component::ParentDir)) {
        return Err("Invalid diff file path".to_string());
    }
    Ok(())
}

fn ensure_diff_sources_bounded(root: &str, file: &str) -> Result<(), String> {
    if let Ok(metadata) = std::fs::symlink_metadata(Path::new(root).join(file)) {
        if metadata.len() > MAX_DIFF_SOURCE_BYTES {
            return Err("The selected file is too large to display".to_string());
        }
    }
    if let Ok(output) = Command::new("git").args(["-C", root, "cat-file", "-s", &format!("HEAD:{file}")]).output() {
        if output.status.success() && String::from_utf8_lossy(&output.stdout).trim().parse::<u64>().unwrap_or(0) > MAX_DIFF_SOURCE_BYTES {
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
    (if status == "??" || status.contains('A') { "A" }
    else if status.contains('D') { "D" }
    else if status.contains('R') { "R" }
    else if status.contains('U') { "U" }
    else { "M" }).to_string()
}

#[tauri::command]
pub fn git_diff_files(path: String) -> Result<Vec<GitDiffFile>, String> {
    let root = repository_root(&path)?;
    let output = Command::new("git")
        .args(["-C", &root, "status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let entries = output.stdout.split(|byte| *byte == 0).filter(|entry| !entry.is_empty()).collect::<Vec<_>>();
    let mut files = Vec::new();
    let mut index = 0;
    while index < entries.len() {
        let entry = entries[index];
        if entry.len() >= 4 {
            let status = String::from_utf8_lossy(&entry[..2]);
            files.push(GitDiffFile {
                path: String::from_utf8_lossy(&entry[3..]).to_string(),
                status: display_status(&status),
            });
            if status.contains('R') || status.contains('C') {
                index += 1;
            }
        }
        index += 1;
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

#[tauri::command]
pub fn git_file_diff(path: String, file: String) -> Result<GitFileDiff, String> {
    safe_relative_path(&file)?;
    let root = repository_root(&path)?;
    ensure_diff_sources_bounded(&root, &file)?;
    let output = Command::new("git")
        .args(["-C", &root, "diff", "--no-ext-diff", "--no-color", "--unified=10", "HEAD", "--", &file])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let mut patch = String::from_utf8_lossy(&output.stdout).to_string();
    if patch.is_empty() {
        let tracked = Command::new("git")
            .args(["-C", &root, "ls-files", "--error-unmatch", "--", &file])
            .output()
            .map_err(|error| error.to_string())?
            .status
            .success();
        if tracked {
            return Err("This file no longer has changes; refresh the diff file tree".to_string());
        }
        let file_path = Path::new(&root).join(&file);
        let text = if std::fs::symlink_metadata(&file_path).map(|metadata| metadata.file_type().is_symlink()).unwrap_or(false) {
            std::fs::read_link(&file_path).map_err(|error| format!("Could not read {file}: {error}"))?.to_string_lossy().to_string()
        } else {
            String::from_utf8(std::fs::read(&file_path).map_err(|error| format!("Could not read {file}: {error}"))?)
                .map_err(|_| "Binary files cannot be displayed".to_string())?
        };
        patch = format!("diff --git a/{file} b/{file}\nnew file mode 100644\n--- /dev/null\n+++ b/{file}\n@@ -0,0 +1,{} @@\n{}", text.lines().count(), text.lines().map(|line| format!("+{line}\n")).collect::<String>());
    }
    ensure_patch_bounded(&patch)?;
    Ok(GitFileDiff { path: file, patch })
}
