use serde::Serialize;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{
    env,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    time::Duration,
};
use wait_timeout::ChildExt;

const GITHUB_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum GithubStatus {
    Pending,
    Success,
    Failure,
    Skipped,
    NoCi,
    Unknown,
}

#[derive(Debug, Serialize)]
pub struct GithubPullRequest {
    number: u64,
    title: String,
    author: String,
    ci_status: GithubStatus,
    has_merge_conflicts: bool,
    head_ref_name: String,
    url: String,
    draft: bool,
}

#[derive(Debug, Serialize)]
pub struct GithubPullRequestsResponse {
    repository: String,
    pull_requests: Vec<GithubPullRequest>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GithubCurrentPullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub draft: bool,
    pub ci_status: GithubStatus,
    pub base_ref_name: String,
    pub head_ref_name: String,
}

#[derive(Debug, Serialize)]
pub struct GithubActionRun {
    id: u64,
    name: String,
    state: GithubStatus,
    created_at: String,
    url: String,
}

#[derive(Debug, Serialize)]
pub struct GithubActionRunsResponse {
    repository: String,
    action_runs: Vec<GithubActionRun>,
}

#[tauri::command]
pub async fn github_pull_requests(path: String) -> Result<GithubPullRequestsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || load_pull_requests(&path))
        .await
        .map_err(|error| format!("GitHub worker failed: {error}"))?
}

#[tauri::command]
pub async fn github_current_pull_request(path: String) -> Result<Option<GithubCurrentPullRequest>, String> {
    tauri::async_runtime::spawn_blocking(move || current_pull_request_for_path(&path))
        .await
        .map_err(|error| format!("GitHub worker failed: {error}"))?
}

#[tauri::command]
pub async fn github_action_runs(path: String) -> Result<GithubActionRunsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || load_action_runs(&path))
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
        validate_repository(&repository)?;
        let strategy = match strategy.as_str() {
            "merge" => "--merge",
            "squash" => "--squash",
            "rebase" => "--rebase",
            _ => return Err("Unsupported GitHub merge strategy".to_string()),
        };
        let number_text = number.to_string();
        let state = run_gh(None, &["pr", "view", &number_text, "--repo", &repository, "--json", "state", "--jq", ".state"])?;
        if state.trim().eq_ignore_ascii_case("MERGED") {
            return Ok(());
        }
        run_gh(
            None,
            &[
                "pr",
                "merge",
                &number_text,
                "--repo",
                &repository,
                strategy,
            ],
        )?;
        Ok(())
    })
    .await
    .map_err(|error| format!("GitHub worker failed: {error}"))?
}

pub fn current_pull_request_for_path(path: &str) -> Result<Option<GithubCurrentPullRequest>, String> {
    let branch_output = Command::new("git")
        .args(["-C", path, "branch", "--show-current"])
        .output()
        .map_err(|error| error.to_string())?;
    if !branch_output.status.success() {
        return Ok(None);
    }
    let branch = String::from_utf8_lossy(&branch_output.stdout).trim().to_string();
    if branch.is_empty() {
        return Ok(None);
    }
    let output = run_gh(
        Some(Path::new(path)),
        &[
            "pr", "list", "--state", "open", "--head", &branch,
            "--limit", "1", "--json", "number,title,url,isDraft,statusCheckRollup,baseRefName,headRefName",
        ],
    )?;
    let values: Vec<serde_json::Value> = serde_json::from_str(&output)
        .map_err(|error| format!("Invalid GitHub pull request response: {error}"))?;
    Ok(values.first().map(|value| GithubCurrentPullRequest {
        number: value["number"].as_u64().unwrap_or(0),
        title: value["title"].as_str().unwrap_or("Untitled pull request").to_string(),
        url: value["url"].as_str().unwrap_or_default().to_string(),
        draft: value["isDraft"].as_bool().unwrap_or(false),
        ci_status: ci_status(value["statusCheckRollup"].as_array()),
        base_ref_name: value["baseRefName"].as_str().unwrap_or_default().to_string(),
        head_ref_name: value["headRefName"].as_str().unwrap_or(&branch).to_string(),
    }))
}

fn load_pull_requests(path: &str) -> Result<GithubPullRequestsResponse, String> {
    let repository = repository_name(path)?;
    let output = run_gh(
        Some(Path::new(path)),
        &[
            "pr",
            "list",
            "--repo",
            &repository,
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            "number,title,author,statusCheckRollup,mergeable,mergeStateStatus,headRefName,url,isDraft",
        ],
    )?;
    let values: Vec<serde_json::Value> = serde_json::from_str(&output)
        .map_err(|error| format!("Invalid GitHub pull request response: {error}"))?;
    let pull_requests = values
        .into_iter()
        .map(|value| {
            Ok(GithubPullRequest {
                number: value["number"]
                    .as_u64()
                    .ok_or("Pull request number is missing")?,
                title: value["title"]
                    .as_str()
                    .unwrap_or("Untitled pull request")
                    .to_string(),
                author: value["author"]["login"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string(),
                ci_status: ci_status(value["statusCheckRollup"].as_array()),
                has_merge_conflicts: has_merge_conflicts(&value),
                head_ref_name: value["headRefName"].as_str().unwrap_or_default().to_string(),
                url: value["url"].as_str().unwrap_or_default().to_string(),
                draft: value["isDraft"].as_bool().unwrap_or(false),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(GithubPullRequestsResponse {
        repository,
        pull_requests,
    })
}

fn has_merge_conflicts(value: &serde_json::Value) -> bool {
    value["mergeable"].as_str() == Some("CONFLICTING")
        || value["mergeStateStatus"].as_str() == Some("DIRTY")
}

fn ci_status(checks: Option<&Vec<serde_json::Value>>) -> GithubStatus {
    let Some(checks) = checks else {
        return GithubStatus::NoCi;
    };
    if checks.is_empty() {
        return GithubStatus::NoCi;
    }
    let values = checks
        .iter()
        .flat_map(|check| {
            [
                check["status"].as_str(),
                check["state"].as_str(),
                check["conclusion"].as_str(),
            ]
            .into_iter()
            .flatten()
            .map(str::to_ascii_uppercase)
        })
        .collect::<Vec<_>>();
    if values.iter().any(|value| {
        matches!(
            value.as_str(),
            "FAILURE" | "FAILED" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED"
        )
    }) {
        GithubStatus::Failure
    } else if values.iter().any(|value| {
        matches!(
            value.as_str(),
            "QUEUED" | "IN_PROGRESS" | "PENDING" | "EXPECTED" | "WAITING" | "REQUESTED"
        )
    }) {
        GithubStatus::Pending
    } else if values.iter().all(|value| {
        matches!(
            value.as_str(),
            "SUCCESS" | "COMPLETED" | "NEUTRAL" | "SKIPPED"
        )
    }) {
        GithubStatus::Success
    } else {
        GithubStatus::Unknown
    }
}

fn load_action_runs(path: &str) -> Result<GithubActionRunsResponse, String> {
    let repository = repository_name(path)?;
    let output = run_gh(
        Some(Path::new(path)),
        &[
            "run",
            "list",
            "--repo",
            &repository,
            "--limit",
            "20",
            "--json",
            "databaseId,displayTitle,workflowName,status,conclusion,createdAt,url",
        ],
    )?;
    let values: Vec<serde_json::Value> = serde_json::from_str(&output)
        .map_err(|error| format!("Invalid GitHub Actions response: {error}"))?;
    let action_runs = values
        .into_iter()
        .map(|value| {
            let display_title = value["displayTitle"].as_str().unwrap_or_default();
            let workflow = value["workflowName"].as_str().unwrap_or("GitHub Action");
            Ok(GithubActionRun {
                id: value["databaseId"]
                    .as_u64()
                    .ok_or("Action run ID is missing")?,
                name: if display_title.is_empty() {
                    workflow.to_string()
                } else {
                    format!("{workflow} — {display_title}")
                },
                state: action_status(
                    value["status"].as_str().unwrap_or("unknown"),
                    value["conclusion"].as_str().unwrap_or_default(),
                ),
                created_at: value["createdAt"].as_str().unwrap_or_default().to_string(),
                url: value["url"].as_str().unwrap_or_default().to_string(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(GithubActionRunsResponse {
        repository,
        action_runs,
    })
}

fn action_status(status: &str, conclusion: &str) -> GithubStatus {
    match conclusion.to_ascii_lowercase().as_str() {
        "success" => GithubStatus::Success,
        "failure" | "cancelled" | "timed_out" | "action_required" | "startup_failure" => {
            GithubStatus::Failure
        }
        "skipped" => GithubStatus::Skipped,
        "" => match status.to_ascii_lowercase().as_str() {
            "queued" | "in_progress" | "waiting" | "requested" | "pending" => GithubStatus::Pending,
            _ => GithubStatus::Unknown,
        },
        _ => GithubStatus::Unknown,
    }
}

fn repository_name(path: &str) -> Result<String, String> {
    let repository = run_gh(
        Some(Path::new(path)),
        &[
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "--jq",
            ".nameWithOwner",
        ],
    )?
    .trim()
    .to_string();
    validate_repository(&repository)?;
    Ok(repository)
}

fn validate_repository(repository: &str) -> Result<(), String> {
    let valid_part = |part: &str| {
        !part.is_empty()
            && part.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
            })
    };
    let mut parts = repository.split('/');
    if parts.next().is_some_and(valid_part)
        && parts.next().is_some_and(valid_part)
        && parts.next().is_none()
    {
        Ok(())
    } else {
        Err("Could not determine the GitHub repository".to_string())
    }
}

fn run_gh(current_dir: Option<&Path>, args: &[&str]) -> Result<String, String> {
    let gh = find_gh()
        .ok_or_else(|| "GitHub CLI not found. Install and authenticate `gh`.".to_string())?;
    let mut command = Command::new(&gh);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = current_dir {
        command.current_dir(path);
    }
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not run GitHub CLI: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Could not capture GitHub output")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Could not capture GitHub errors")?;
    let stdout_reader = std::thread::spawn(move || read_stream(stdout));
    let stderr_reader = std::thread::spawn(move || read_stream(stderr));
    let status = match child.wait_timeout(GITHUB_COMMAND_TIMEOUT) {
        Ok(Some(status)) => status,
        Ok(None) => {
            terminate_process_group(&mut child);
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(format!(
                "GitHub CLI timed out after {} seconds",
                GITHUB_COMMAND_TIMEOUT.as_secs()
            ));
        }
        Err(error) => {
            terminate_process_group(&mut child);
            return Err(format!("Could not wait for GitHub CLI: {error}"));
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| "Could not read GitHub output".to_string())??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "Could not read GitHub errors".to_string())??;
    command_result(status, stdout, stderr)
}

fn command_result(status: ExitStatus, stdout: Vec<u8>, stderr: Vec<u8>) -> Result<String, String> {
    if status.success() {
        Ok(String::from_utf8_lossy(&stdout).to_string())
    } else {
        let message = String::from_utf8_lossy(&stderr).trim().to_string();
        Err(if message.is_empty() {
            "GitHub CLI request failed".to_string()
        } else {
            message
        })
    }
}

fn read_stream(mut stream: impl Read) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    stream
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

fn terminate_process_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
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
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
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

#[cfg(test)]
mod tests {
    use super::{action_status, ci_status, has_merge_conflicts, validate_repository, GithubStatus};
    use serde_json::json;

    #[test]
    fn summarizes_ci_checks() {
        let running = vec![json!({ "status": "IN_PROGRESS" })];
        let failed = vec![json!({ "conclusion": "FAILURE" })];
        let passed = vec![json!({ "conclusion": "SUCCESS" })];
        assert_eq!(ci_status(Some(&running)), GithubStatus::Pending);
        assert_eq!(ci_status(Some(&failed)), GithubStatus::Failure);
        assert_eq!(ci_status(Some(&passed)), GithubStatus::Success);
        assert_eq!(ci_status(Some(&vec![])), GithubStatus::NoCi);
    }

    #[test]
    fn detects_merge_conflicts() {
        assert!(has_merge_conflicts(&json!({ "mergeable": "CONFLICTING" })));
        assert!(has_merge_conflicts(&json!({ "mergeStateStatus": "DIRTY" })));
        assert!(!has_merge_conflicts(&json!({ "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN" })));
    }

    #[test]
    fn summarizes_action_statuses() {
        assert_eq!(action_status("completed", "success"), GithubStatus::Success);
        assert_eq!(action_status("in_progress", ""), GithubStatus::Pending);
        assert_eq!(action_status("completed", "skipped"), GithubStatus::Skipped);
        assert_eq!(
            action_status("completed", "timed_out"),
            GithubStatus::Failure
        );
    }

    #[test]
    fn validates_repository_names() {
        assert!(validate_repository("owner/repository").is_ok());
        assert!(validate_repository("owner/repo.name").is_ok());
        assert!(validate_repository("owner/repository/extra").is_err());
        assert!(validate_repository("owner;rm/repository").is_err());
    }
}
