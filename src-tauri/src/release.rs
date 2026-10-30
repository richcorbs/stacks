//! Release policy belongs to the repository script; output and processes belong to PTYs.
use crate::kanban;
use serde::{Deserialize, Serialize};
use std::{
    hash::{Hash, Hasher},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReleaseConfig {
    pub command: String,
    pub latest_command: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseSetup {
    pub cwd: String,
    pub terminal_id: String,
}
fn load(project_id: &str) -> Result<(ReleaseSetup, ReleaseConfig), String> {
    let (path, enabled, config): (String, bool, String) = kanban::with_read_connection(|db| {
        db.query_row(
            "SELECT path,releases_enabled,release_config_path FROM projects WHERE id=?1",
            [project_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| e.to_string())
    })?;
    if !enabled {
        return Err("Releases are disabled for this project".into());
    }
    let root = Path::new(&path).canonicalize().map_err(|e| e.to_string())?;
    let top = git(&root, &["rev-parse", "--show-toplevel"])?;
    if Path::new(&top).canonicalize().map_err(|e| e.to_string())? != root {
        return Err("Project path must be the repository root".into());
    }
    let common = crate::repository_coordinator::repository_identity(&root)?;
    let dir = git(&root, &["rev-parse", "--absolute-git-dir"])?;
    if Path::new(&dir).canonicalize().map_err(|e| e.to_string())? != common {
        return Err("Releases must run in the primary checkout, not a linked worktree".into());
    }
    let config_path = confined_path(&root, &config)?;
    let config: ReleaseConfig = serde_json::from_str(
        &std::fs::read_to_string(config_path).map_err(|e| e.to_string())?,
    )
    .map_err(|e| {
        format!("Invalid release configuration: {e}. Expected command and optional latestCommand.")
    })?;
    if config.command.trim().is_empty() {
        return Err("Release command is empty".into());
    }
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    common.hash(&mut hash);
    Ok((
        ReleaseSetup {
            cwd: root.to_string_lossy().into(),
            terminal_id: format!("release:{:x}", hash.finish()),
        },
        config,
    ))
}
fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().into())
}
fn confined_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Release configuration must be repository-relative".into());
    }
    let path = root.join(path).canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(root) {
        return Err("Release configuration escapes project directory".into());
    }
    Ok(path)
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn version_command(command: &str, version: &str, root: &str) -> Result<String, String> {
    if version.trim().is_empty() || version.contains('\0') || version.len() > 256 {
        return Err("Enter a version (at most 256 bytes, no NUL)".into());
    }
    // Environment, never textual substitution into repository-owned command syntax.
    Ok(format!(
        "cd {} || exit $?; export STACKS_RELEASE_VERSION={} STACKS_RELEASE_PROJECT_PATH={}; {}",
        quote(root),
        quote(version),
        quote(root),
        command
    ))
}
#[tauri::command]
pub fn release_setup(project_id: String) -> Result<ReleaseSetup, String> {
    load(&project_id).map(|(setup, _)| setup)
}
#[tauri::command]
pub fn release_command(
    project_id: String,
    version: String,
    expected_cwd: String,
    expected_terminal_id: String,
) -> Result<String, String> {
    let (setup, config) = load(&project_id)?;
    if setup.cwd != expected_cwd || setup.terminal_id != expected_terminal_id {
        return Err(
            "Project release directory changed; reopen Project Workspace before releasing".into(),
        );
    }
    version_command(&config.command, &version, &setup.cwd)
}
#[tauri::command]
pub async fn release_latest(project_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || latest(&project_id))
        .await
        .map_err(|e| e.to_string())?
}
fn latest(project_id: &str) -> Result<String, String> {
    let (setup, config) = load(project_id)?;
    let command = config
        .latest_command
        .filter(|c| !c.trim().is_empty())
        .ok_or("Latest release lookup is not configured")?;
    // Redirect to temporary files so a verbose command cannot block on a full pipe.
    let stdout = tempfile::tempfile().map_err(|e| e.to_string())?;
    let stderr = tempfile::tempfile().map_err(|e| e.to_string())?;
    let shell = std::env::var("SHELL").unwrap_or("/bin/zsh".into());
    let command = format!("cd {} || exit $?; {}", quote(&setup.cwd), command);
    let mut process = Command::new(&shell);
    process
        .args([
            if shell.ends_with("zsh") || shell.ends_with("bash") {
                "-lic"
            } else {
                "-lc"
            },
            &command,
        ])
        .current_dir(&setup.cwd)
        .stdin(Stdio::null())
        .stdout(stdout.try_clone().map_err(|e| e.to_string())?)
        .stderr(stderr.try_clone().map_err(|e| e.to_string())?);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        process.process_group(0);
    }
    let mut child = process.spawn().map_err(|e| e.to_string())?;
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if start.elapsed() > Duration::from_secs(15) {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "Latest release lookup timed out (15s). Check command and GitHub authentication."
                    .into(),
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    use std::io::{Read, Seek};
    let read = |mut file: std::fs::File| -> Result<String, String> {
        file.rewind().map_err(|e| e.to_string())?;
        let mut text = String::new();
        file.take(4096)
            .read_to_string(&mut text)
            .map_err(|e| e.to_string())?;
        Ok(text.trim().into())
    };
    if !status.success() {
        return Err(format!(
            "Latest release lookup failed ({status}): {}",
            read(stderr)?
        ));
    }
    let value = read(stdout)?;
    if value.is_empty() {
        return Err("Latest release command returned no version".into());
    }
    Ok(value)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn version_is_environment_data_not_shell_syntax() {
        let version = "1.2'; printf injected; # $(touch /tmp/no)";
        let dir = tempfile::Builder::new()
            .prefix("project's dir ")
            .tempdir()
            .unwrap();
        let command = version_command(
            "printf '%s' \"$STACKS_RELEASE_VERSION\"",
            version,
            dir.path().to_str().unwrap(),
        )
        .unwrap();
        let out = Command::new("/bin/sh")
            .args(["-c", &command])
            .output()
            .unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8(out.stdout).unwrap(), version);
        assert!(version_command("true", "", "/tmp").is_err());
    }
    #[test]
    fn configuration_cannot_escape_repository() {
        let root = tempfile::tempdir().unwrap();
        let canonical = root.path().canonicalize().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(canonical.join("release.json"), "{}").unwrap();
        assert!(confined_path(&canonical, "release.json").is_ok());
        assert!(confined_path(&canonical, "../release.json").is_err());
        assert!(confined_path(&canonical, outside.path().to_str().unwrap()).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), root.path().join("escape.json")).unwrap();
            assert!(confined_path(&canonical, "escape.json").is_err());
        }
    }
    #[test]
    fn config_is_minimal() {
        let config: ReleaseConfig =
            serde_json::from_str(include_str!("../../.stacks/release.json")).unwrap();
        assert!(!config.command.is_empty());
        assert!(serde_json::from_str::<ReleaseConfig>(r#"{"stages":[]}"#).is_err());
    }
}
