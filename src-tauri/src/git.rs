use serde::Serialize;
use std::{collections::HashSet, process::Command};

#[derive(Debug, Clone, Serialize)]
pub struct GitInfo {
    branch: String,
    created: u32,
    changed: u32,
    deleted: u32,
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
