use super::*;
#[allow(unused_imports)]
use super::{
    cards::*, cleanup::*, domain::*, environment::*, github_delivery::*, health::*,
    local_delivery::*, repository::*, sync::*,
};

pub(in crate::kanban) fn git_status_success(path: &str, args: &[&str]) -> Result<bool, String> {
    Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .status()
        .map(|status| status.success())
        .map_err(|error| error.to_string())
}

pub(in crate::kanban) fn git_output(path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("Git command failed in {path}")
        } else {
            detail
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(in crate::kanban) fn repository_identity(path: &str) -> Result<String, String> {
    repository_coordinator::repository_identity(path)?
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "Repository path is not valid UTF-8".to_string())
}

pub(in crate::kanban) fn has_git_operation(path: &str) -> Result<bool, String> {
    for marker in [
        "MERGE_HEAD",
        "rebase-merge",
        "rebase-apply",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
    ] {
        let marker_path = git_output(path, &["rev-parse", "--git-path", marker])?;
        let marker_path = if Path::new(&marker_path).is_absolute() {
            PathBuf::from(marker_path)
        } else {
            Path::new(path).join(marker_path)
        };
        if marker_path.exists() {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(in crate::kanban) fn validate_checkout(
    path: &str,
    expected_repository: Option<&str>,
) -> Result<EnvironmentStartPreflight, String> {
    validate_checkout_with_policy(path, expected_repository, true)
}

pub(in crate::kanban) fn validate_target_checkout(
    path: &str,
    expected_repository: Option<&str>,
) -> Result<EnvironmentStartPreflight, String> {
    validate_checkout_with_policy(path, expected_repository, false)
}

pub(in crate::kanban) fn validate_checkout_with_policy(
    path: &str,
    expected_repository: Option<&str>,
    require_clean: bool,
) -> Result<EnvironmentStartPreflight, String> {
    let canonical = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("Checkout does not exist at {path}: {error}"))?;
    let canonical = canonical
        .to_str()
        .ok_or_else(|| "Checkout path is not valid UTF-8".to_string())?
        .to_string();
    let repository_id = repository_identity(&canonical)?;
    if expected_repository.is_some_and(|expected| expected != repository_id) {
        return Err(format!(
            "Checkout at {path} belongs to a different repository"
        ));
    }
    let branch = git_output(&canonical, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map_err(|_| format!("Checkout at {path} is detached; a named branch is required"))?;
    if require_clean
        && !git_output(
            &canonical,
            &["status", "--porcelain=v1", "--untracked-files=all"],
        )?
        .is_empty()
    {
        return Err(format!(
            "Checkout at {path} has modified or untracked files"
        ));
    }
    if has_git_operation(&canonical)? {
        return Err(format!(
            "Checkout at {path} has an in-progress Git operation"
        ));
    }
    let revision = git_output(&canonical, &["rev-parse", "HEAD"])?;
    Ok(EnvironmentStartPreflight {
        repository_id,
        target_checkout_path: canonical,
        target_branch: branch,
        target_revision: revision,
    })
}

/// Only update the configured, checked-out target. Never infer a target from the remote.
pub(in crate::kanban) fn fast_forward_tracking_target(
    target: &EnvironmentStartPreflight,
) -> Result<(), String> {
    let path = &target.target_checkout_path;
    let branch = &target.target_branch;
    let remote = git_output(path, &["config", "--get", &format!("branch.{branch}.remote")]);
    let merge = git_output(path, &["config", "--get", &format!("branch.{branch}.merge")]);
    let remote = match (remote, merge) {
        (Ok(remote), Ok(merge)) if !remote.is_empty() && remote != "." && !merge.is_empty() => remote,
        _ => return Ok(()), // No configured remote upstream: local-only project.
    };
    let upstream = git_output(path, &["rev-parse", "--symbolic-full-name", "@{upstream}"])
        .map_err(|error| format!("Cannot resolve upstream for {branch}: {error}"))?;
    if !upstream.starts_with("refs/remotes/") {
        return Ok(()); // A local upstream is not a tracking remote.
    }
    git_output(path, &["fetch", "--", &remote])
        .map_err(|error| format!("Could not fetch target branch {branch} from {remote}: {error}"))?;
    let current = validate_checkout(path, Some(&target.repository_id))?;
    if current.target_branch != *branch || current.target_revision != target.target_revision {
        return Err(format!("Target checkout {branch} changed while fetching; review it and retry"));
    }
    let remote_tip = git_output(path, &["rev-parse", "@{upstream}"])
        .map_err(|error| format!("Cannot resolve upstream for {branch} after fetch: {error}"))?;
    if !git_status_success(path, &["merge-base", "--is-ancestor", &target.target_revision, &remote_tip])? {
        if git_status_success(path, &["merge-base", "--is-ancestor", &remote_tip, &target.target_revision])? {
            return Ok(()); // Local branch is already ahead.
        }
        return Err(format!("Target branch {branch} diverged from {upstream}; reconcile it manually before starting work"));
    }
    if remote_tip != target.target_revision {
        git_output(path, &["merge", "--ff-only", &remote_tip])
            .map_err(|error| format!("Could not fast-forward {branch} from {upstream}: {error}"))?;
    }
    Ok(())
}

pub(in crate::kanban) fn ensure_registered_distinct_worktree(
    target: &str,
    source: &str,
) -> Result<(), String> {
    let output = git_output(target, &["worktree", "list", "--porcelain"])?;
    let paths = output
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .collect::<Vec<_>>();
    let source = Path::new(source)
        .canonicalize()
        .map_err(|error| format!("Setup result at {source} cannot be validated: {error}"))?;
    let target = Path::new(target)
        .canonicalize()
        .map_err(|error| format!("Target checkout cannot be validated: {error}"))?;
    if source == target
        || !paths
            .iter()
            .any(|path| Path::new(path).canonicalize().ok().as_ref() == Some(&source))
    {
        return Err(format!(
            "Setup result {} is not a distinct registered worktree",
            source.display()
        ));
    }
    Ok(())
}
