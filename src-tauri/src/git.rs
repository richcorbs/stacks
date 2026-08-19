use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    env,
    path::{Path, PathBuf},
    process::Command,
};

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

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GitCleanupCandidate {
    path: String,
    branch: String,
    merged_via: String,
    missing: bool,
}

#[derive(Debug, Serialize)]
pub struct GitCleanupPlan {
    default_branch: String,
    candidates: Vec<GitCleanupCandidate>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct GitCleanupResult {
    removed_paths: Vec<String>,
    deleted_branches: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Debug)]
struct Worktree {
    path: String,
    branch: Option<String>,
}

#[tauri::command]
pub async fn git_cleanup_plan(path: String) -> Result<GitCleanupPlan, String> {
    tauri::async_runtime::spawn_blocking(move || build_cleanup_plan(&path))
        .await
        .map_err(|error| format!("Git cleanup worker failed: {error}"))?
}

#[tauri::command]
pub async fn git_cleanup_execute(
    path: String,
    candidates: Vec<GitCleanupCandidate>,
) -> Result<GitCleanupResult, String> {
    tauri::async_runtime::spawn_blocking(move || execute_cleanup(&path, &candidates))
        .await
        .map_err(|error| format!("Git cleanup worker failed: {error}"))?
}

fn build_cleanup_plan(path: &str) -> Result<GitCleanupPlan, String> {
    let repository = repository_root(path)?;
    let mut warnings = Vec::new();
    if let Err(error) = run_git(&repository, &["fetch", "origin", "--prune"]) {
        warnings.push(format!("Could not refresh origin: {error}"));
    }
    let default_branch = default_branch(&repository)?;
    let worktrees = worktrees(&repository)?;
    let mut candidates = Vec::new();
    let mut gh_warning_added = false;

    for (index, worktree) in worktrees.into_iter().enumerate() {
        let Some(branch) = worktree.branch else {
            continue;
        };
        if index == 0 || branch == default_branch {
            continue;
        }
        let missing = !Path::new(&worktree.path).exists();
        if !missing && !worktree_is_clean(&worktree.path)? {
            continue;
        }

        let merged_via = if branch_is_ancestor(&repository, &branch, &default_branch) {
            Some("git".to_string())
        } else {
            match branch_has_merged_pr(&repository, &branch) {
                Ok(true) => Some("GitHub PR".to_string()),
                Ok(false) => None,
                Err(error) => {
                    if !gh_warning_added {
                        warnings.push(format!("GitHub merge checks were unavailable: {error}"));
                        gh_warning_added = true;
                    }
                    None
                }
            }
        };
        if let Some(merged_via) = merged_via {
            candidates.push(GitCleanupCandidate {
                path: worktree.path,
                branch,
                merged_via,
                missing,
            });
        }
    }

    Ok(GitCleanupPlan {
        default_branch,
        candidates,
        warnings,
    })
}

fn execute_cleanup(
    path: &str,
    requested: &[GitCleanupCandidate],
) -> Result<GitCleanupResult, String> {
    let repository = repository_root(path)?;
    let plan = build_cleanup_plan(&repository)?;
    let available = plan
        .candidates
        .into_iter()
        .map(|candidate| {
            (
                (candidate.path.clone(), candidate.branch.clone()),
                candidate,
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    let mut removed_paths = Vec::new();
    let mut branches_to_delete = Vec::new();
    let mut warnings = plan.warnings;

    for requested_candidate in requested {
        let key = (
            requested_candidate.path.clone(),
            requested_candidate.branch.clone(),
        );
        let Some(candidate) = available.get(&key) else {
            warnings.push(format!(
                "Skipped {} because it is no longer safe to clean",
                requested_candidate.branch
            ));
            continue;
        };
        if Path::new(&candidate.path).exists() {
            if let Err(error) = run_git(&repository, &["worktree", "remove", "--", &candidate.path]) {
                warnings.push(format!("Could not remove {}: {error}", candidate.path));
                continue;
            }
        }
        removed_paths.push(candidate.path.clone());
        branches_to_delete.push(candidate.branch.clone());
    }

    if let Err(error) = run_git(&repository, &["worktree", "prune"]) {
        warnings.push(format!("Could not prune worktree metadata: {error}"));
    }

    let mut deleted_branches = Vec::new();
    for branch in branches_to_delete {
        match run_git(&repository, &["branch", "-D", "--", &branch]) {
            Ok(_) => deleted_branches.push(branch),
            Err(error) => warnings.push(format!(
                "Removed the worktree but could not delete branch {branch}: {error}"
            )),
        }
    }

    Ok(GitCleanupResult {
        removed_paths,
        deleted_branches,
        warnings,
    })
}

fn repository_root(path: &str) -> Result<String, String> {
    let output = run_git(path, &["rev-parse", "--show-toplevel"])?;
    let root = output.trim();
    if root.is_empty() {
        Err("Could not determine the Git repository root".to_string())
    } else {
        Ok(root.to_string())
    }
}

fn default_branch(repository: &str) -> Result<String, String> {
    if let Ok(value) = run_git(
        repository,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    ) {
        if let Some(branch) = value.trim().strip_prefix("origin/") {
            if !branch.is_empty() {
                return Ok(branch.to_string());
            }
        }
    }
    if let Ok(mut command) = gh_command(repository) {
        if let Ok(output) = command
            .args([
                "repo",
                "view",
                "--json",
                "defaultBranchRef",
                "--jq",
                ".defaultBranchRef.name",
            ])
            .output()
        {
            if output.status.success() {
                let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !branch.is_empty() {
                    return Ok(branch);
                }
            }
        }
    }
    for branch in ["main", "master"] {
        if run_git(
            repository,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .is_ok()
        {
            return Ok(branch.to_string());
        }
    }
    Err("Could not determine the repository's default branch".to_string())
}

fn worktrees(repository: &str) -> Result<Vec<Worktree>, String> {
    let output = run_git(repository, &["worktree", "list", "--porcelain"])?;
    let mut result = Vec::new();
    let mut path: Option<String> = None;
    let mut branch: Option<String> = None;
    for line in output.lines().chain(std::iter::once("")) {
        if let Some(value) = line.strip_prefix("worktree ") {
            path = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("branch refs/heads/") {
            branch = Some(value.to_string());
        } else if line.is_empty() {
            if let Some(path) = path.take() {
                result.push(Worktree {
                    path,
                    branch: branch.take(),
                });
            }
        }
    }
    Ok(result)
}

fn worktree_is_clean(path: &str) -> Result<bool, String> {
    Ok(
        run_git(path, &["status", "--porcelain", "--untracked-files=all"])?
            .trim()
            .is_empty(),
    )
}

fn branch_is_ancestor(repository: &str, branch: &str, default_branch: &str) -> bool {
    let target = format!("origin/{default_branch}");
    Command::new("git")
        .current_dir(repository)
        .args(["merge-base", "--is-ancestor", branch, &target])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn branch_has_merged_pr(repository: &str, branch: &str) -> Result<bool, String> {
    let output = gh_command(repository)?
        .args([
            "pr", "list", "--head", branch, "--state", "merged", "--limit", "1", "--json", "number",
        ])
        .output()
        .map_err(|error| format!("could not run gh: {error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            "gh could not query pull requests".to_string()
        } else {
            message
        });
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("invalid gh response: {error}"))?;
    Ok(value.as_array().is_some_and(|items| !items.is_empty()))
}

fn gh_command(repository: &str) -> Result<Command, String> {
    let path = find_gh()
        .ok_or_else(|| "GitHub CLI not found. Install `gh` or set GH_PATH.".to_string())?;
    let mut command = Command::new(path);
    command.current_dir(repository);
    Ok(command)
}

fn find_gh() -> Option<PathBuf> {
    if let Some(path) = env::var_os("GH_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    for path in ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"] {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    if let Some(path) = env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".local/bin/gh"))
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    let shell = PathBuf::from(env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string()));
    let output = Command::new(shell)
        .args(["-lic", "command -v gh"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    path.is_file().then_some(path)
}

fn run_git(path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .current_dir(path)
        .args(args)
        .output()
        .map_err(|error| format!("could not run git: {error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if message.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            message
        })
    }
}
