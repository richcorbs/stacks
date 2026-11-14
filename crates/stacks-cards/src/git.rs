//! Read-only working-tree status for a card environment.
//!
//! This mirrors the small porcelain parser used by the shipped Tauri command
//! (`src-tauri/src/git.rs`). It is intentionally narrow: counts only, no diffs
//! or branch ownership. A later extraction can make this the single shared
//! implementation for both hosts.

use std::{collections::HashSet, path::Path, process::Command};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitChangeCounts {
    pub created: u32,
    pub changed: u32,
    pub deleted: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum GitStatus {
    Ok(GitChangeCounts),
    Error { message: String },
}

/// Read the working-tree status for a card worktree. Returns `None` when the
/// path is not a readable Git worktree, so the list can omit the badge instead
/// of showing a noisy error for cards without one.
pub fn read_git_status(path: &Path) -> Option<GitStatus> {
    let branch = Command::new("git")
        .args(["-C", &path.to_string_lossy(), "branch", "--show-current"])
        .output()
        .ok()?;
    if !branch.status.success() {
        return None;
    }

    let output = Command::new("git")
        .args([
            "-C",
            &path.to_string_lossy(),
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return Some(GitStatus::Error {
            message: "Git status could not be read. Check the worktree and retry refresh.".into(),
        });
    }
    let (created, changed, deleted) = parse_git_status(&String::from_utf8_lossy(&output.stdout));
    Some(GitStatus::Ok(GitChangeCounts {
        created,
        changed,
        deleted,
    }))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarizes_staged_unstaged_untracked_and_deleted_files() {
        let status = "\
M  staged.rs
 M unstaged.rs
MM both.rs
A  added.rs
 D deleted.rs
R  old.rs -> renamed.rs
?? new.rs
";
        assert_eq!(parse_git_status(status), (2, 4, 1));
    }

    #[test]
    fn ignores_short_or_non_status_lines() {
        assert_eq!(parse_git_status("x\n\n?? ok.rs\n"), (1, 0, 0));
    }
}
