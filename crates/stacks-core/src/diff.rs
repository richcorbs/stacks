//! Working-tree diff reads for a card environment.
//!
//! The GUI's `src-tauri/src/git.rs` owns the rich diff contract; this module is
//! the native-client subset the DIFF tab needs: changed file list, one unified
//! diff, and line classification. No commits, merges or worktree mutation.

use std::{path::Path, process::Command};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffFile {
    pub path: String,
    pub status: DiffFileStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiffFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
}

impl DiffFileStatus {
    pub fn glyph(self) -> char {
        match self {
            Self::Added => 'A',
            Self::Modified => 'M',
            Self::Deleted => 'D',
            Self::Renamed => 'R',
            Self::Untracked => '?',
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffLineKind {
    Context,
    Added,
    Removed,
    Hunk,
    Header,
    Meta,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDiff {
    pub lines: Vec<DiffLine>,
    /// Indexes into `lines` that begin hunks.
    pub hunk_starts: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitReviewContext {
    pub branch: String,
    pub target: String,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: bool,
    pub conflicts: bool,
    pub head: Option<String>,
}

/// LazyGit-style review context: branch, ahead/behind, dirty/conflict state and
/// the current HEAD subject. Errors are tolerated (detached/empty repos) so the
/// DIFF tab still renders files.
pub fn review_context(worktree: &str, comparison_target: &str) -> GitReviewContext {
    let target = comparison_target.trim();
    let target = if target.is_empty() { "HEAD" } else { target };
    let branch = git(worktree, &["branch", "--show-current"])
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "detached".to_string());
    let (ahead, behind) = git(
        worktree,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{target}...HEAD"),
        ],
    )
    .ok()
    .and_then(|value| {
        let mut parts = value.split_whitespace();
        Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
    })
    .map(|(behind, ahead): (u32, u32)| (ahead, behind))
    .unwrap_or((0, 0));
    let status = git(
        worktree,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )
    .unwrap_or_default();
    let dirty = !status.trim().is_empty();
    let conflicts = status.lines().any(|line| {
        let mut chars = line.chars();
        matches!(
            (chars.next(), chars.next()),
            (Some('U'), Some(_))
                | (Some(_), Some('U'))
                | (Some('A'), Some('A'))
                | (Some('D'), Some('D'))
        )
    });
    let head = git(worktree, &["log", "-1", "--format=%h %s"])
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    GitReviewContext {
        branch,
        target: target.to_string(),
        ahead,
        behind,
        dirty,
        conflicts,
        head,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeStatus {
    pub branch: String,
    pub created: u32,
    pub changed: u32,
    pub deleted: u32,
    pub dirty: bool,
    pub conflicts: bool,
    pub ahead: u32,
    pub behind: u32,
    pub error: Option<String>,
}

/// Compact card-list status: branch + change counts + divergence/conflicts.
pub fn worktree_status(worktree: &str, comparison_target: &str) -> WorktreeStatus {
    let context = review_context(worktree, comparison_target);
    // Match the GUI's green/red badge: compare committed + staged + unstaged
    // state against the target's merge base, not just `git status`.
    let (created, changed, deleted, error) = match crate::git_repository::git_change_summary(
        worktree.to_string(),
        comparison_target.to_string(),
    ) {
        Ok(summary) => (summary.added, summary.modified, summary.deleted, None),
        Err(error) => (0, 0, 0, Some(error)),
    };
    WorktreeStatus {
        branch: context.branch,
        created,
        changed,
        deleted,
        dirty: context.dirty,
        conflicts: context.conflicts,
        ahead: context.ahead,
        behind: context.behind,
        error,
    }
}

pub fn changed_files(worktree: &str, comparison_target: &str) -> Result<Vec<DiffFile>, String> {
    let target = comparison_target.trim();
    let target = if target.is_empty() { "HEAD" } else { target };
    let range = format!("{target}...HEAD");
    let output = git(
        worktree,
        &["diff", "--name-status", "--find-renames", &range],
    )?;
    let mut files: Vec<DiffFile> = output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let status = parts.next()?;
            let path = parts.next()?;
            let status = match status.chars().next()? {
                'A' => DiffFileStatus::Added,
                'D' => DiffFileStatus::Deleted,
                'R' => DiffFileStatus::Renamed,
                _ => DiffFileStatus::Modified,
            };
            Some(DiffFile {
                path: path.to_string(),
                status,
            })
        })
        .collect();

    // Include uncommitted work in the card worktree. `git diff <range>` only
    // compares commits, so merge the working-tree status in and sort by path.
    if let Ok(status) = git(
        worktree,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    ) {
        for line in status.lines() {
            if line.len() < 4 {
                continue;
            }
            let marker = &line[..2];
            let path = line[3..]
                .rsplit_once(" -> ")
                .map(|(_, to)| to)
                .unwrap_or(&line[3..]);
            let entry = if marker == "??" {
                DiffFileStatus::Untracked
            } else if marker.contains('D') {
                DiffFileStatus::Deleted
            } else if marker.contains('A') {
                DiffFileStatus::Added
            } else {
                DiffFileStatus::Modified
            };
            if let Some(existing) = files.iter_mut().find(|file| file.path == path) {
                if entry == DiffFileStatus::Untracked {
                    existing.status = entry;
                }
            } else {
                files.push(DiffFile {
                    path: path.to_string(),
                    status: entry,
                });
            }
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    files.dedup_by(|left, right| left.path == right.path);
    Ok(files)
}

pub fn file_diff(worktree: &str, comparison_target: &str, path: &str) -> Result<String, String> {
    let target = comparison_target.trim();
    let target = if target.is_empty() { "HEAD" } else { target };
    let range = format!("{target}...HEAD");
    let tracked = git(
        worktree,
        &["diff", "--no-color", "--find-renames", &range, "--", path],
    )?;
    if !tracked.trim().is_empty() {
        return Ok(tracked);
    }
    let uncommitted = git(
        worktree,
        &["diff", "--no-color", "--find-renames", "HEAD", "--", path],
    )?;
    if !uncommitted.trim().is_empty() {
        return Ok(uncommitted);
    }
    // Untracked file: present its contents as an all-added diff.
    let full = Path::new(worktree).join(path);
    let contents = std::fs::read_to_string(&full)
        .map_err(|error| format!("Could not read {path}: {error}"))?;
    let mut diff = format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n"
    );
    diff.push_str(&format!(
        "@@ -0,0 +1,{} @@\n",
        contents.lines().count().max(1)
    ));
    for line in contents.lines() {
        diff.push('+');
        diff.push_str(line);
        diff.push('\n');
    }
    Ok(diff)
}

pub fn parse_unified(diff: &str) -> ParsedDiff {
    let mut lines = Vec::new();
    let mut hunk_starts = Vec::new();
    let mut old_line = 0u32;
    let mut new_line = 0u32;
    for raw in diff.lines() {
        let kind = if raw.starts_with("@@") {
            let (old_start, new_start) = parse_hunk_header(raw);
            old_line = old_start;
            new_line = new_start;
            hunk_starts.push(lines.len());
            DiffLineKind::Hunk
        } else if raw.starts_with("+++")
            || raw.starts_with("---")
            || raw.starts_with("diff --git")
            || raw.starts_with("index ")
            || raw.starts_with("new file ")
            || raw.starts_with("deleted file ")
            || raw.starts_with("similarity ")
            || raw.starts_with("rename ")
        {
            DiffLineKind::Header
        } else if raw.starts_with('\\') {
            DiffLineKind::Meta
        } else if raw.starts_with('+') {
            DiffLineKind::Added
        } else if raw.starts_with('-') {
            DiffLineKind::Removed
        } else {
            DiffLineKind::Context
        };
        let (old_number, new_number) = match kind {
            DiffLineKind::Added => {
                let number = Some(new_line);
                new_line += 1;
                (None, number)
            }
            DiffLineKind::Removed => {
                let number = Some(old_line);
                old_line += 1;
                (number, None)
            }
            DiffLineKind::Context => {
                let numbers = (Some(old_line), Some(new_line));
                old_line += 1;
                new_line += 1;
                numbers
            }
            _ => (None, None),
        };
        lines.push(DiffLine {
            kind,
            old_line: old_number,
            new_line: new_number,
            text: raw.to_string(),
        });
    }
    ParsedDiff { lines, hunk_starts }
}

fn parse_hunk_header(header: &str) -> (u32, u32) {
    let mut parts = header
        .trim_start_matches('@')
        .split(' ')
        .filter(|part| !part.is_empty());
    let old = parts
        .next()
        .and_then(|part| part.trim_start_matches('-').split(',').next())
        .and_then(|value| value.parse().ok())
        .unwrap_or(1);
    let new = parts
        .next()
        .and_then(|part| part.trim_start_matches('+').split(',').next())
        .and_then(|value| value.parse().ok())
        .unwrap_or(1);
    (old, new)
}

fn git(worktree: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args(args)
        .output()
        .map_err(|error| format!("Could not run git: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hunks_and_line_numbers() {
        let diff = "\
diff --git a/a.rs b/a.rs
index 1..2 100644
--- a/a.rs
+++ b/a.rs
@@ -2,3 +2,4 @@
 context
-removed
+added
+second
 tail
";
        let parsed = parse_unified(diff);
        assert_eq!(parsed.hunk_starts, vec![4]);
        let removed = parsed
            .lines
            .iter()
            .find(|line| line.kind == DiffLineKind::Removed)
            .unwrap();
        assert_eq!(removed.old_line, Some(3));
        assert_eq!(removed.new_line, None);
        let added = parsed
            .lines
            .iter()
            .filter(|line| line.kind == DiffLineKind::Added)
            .collect::<Vec<_>>();
        assert_eq!(added[0].new_line, Some(3));
        assert_eq!(added[1].new_line, Some(4));
    }

    #[test]
    fn review_context_reports_branch_and_divergence() {
        let dir = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| {
            Command::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(args)
                .output()
                .unwrap();
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        std::fs::write(dir.path().join("a"), "a").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "initial"]);
        run(&["branch", "main"]);
        std::fs::write(dir.path().join("a"), "changed").unwrap();
        std::fs::write(dir.path().join("new"), "new").unwrap();
        let context = review_context(dir.path().to_str().unwrap(), "main");
        assert!(context.dirty);
        assert_eq!(context.target, "main");
        assert!(
            context
                .head
                .as_deref()
                .unwrap_or_default()
                .contains("initial")
        );
    }

    #[test]
    fn untracked_files_render_as_additions() {
        let dir = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| {
            Command::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(args)
                .output()
                .unwrap();
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        std::fs::write(dir.path().join(".keep"), "").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "initial"]);
        std::fs::write(dir.path().join("new.txt"), "alpha\nbeta\n").unwrap();
        let files = changed_files(dir.path().to_str().unwrap(), "HEAD").unwrap();
        assert_eq!(files[0].status, DiffFileStatus::Untracked);
        let diff = file_diff(dir.path().to_str().unwrap(), "HEAD", "new.txt").unwrap();
        let parsed = parse_unified(&diff);
        assert_eq!(
            parsed
                .lines
                .iter()
                .filter(|line| line.kind == DiffLineKind::Added)
                .count(),
            2
        );
    }
}
