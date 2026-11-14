//! Native release-tab support.
//!
//! Release policy still belongs to the repository's `.stacks/release.json`.
//! This module loads that contract, runs its read-only status commands, and
//! composes the versioned action command for the native PTY.

use std::{
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use anyhow::{Context as _, Result, bail};
use serde::{Deserialize, Serialize};
use stacks_cards::Project;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReleaseConfig {
    pub command: String,
    #[serde(default)]
    pub latest_command: Option<String>,
    #[serde(default)]
    pub state_command: Option<String>,
    #[serde(default)]
    pub build_and_test_command: Option<String>,
    #[serde(default)]
    pub publish_command: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub restart_after_test: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseAction {
    Release,
    BuildAndTest,
    Publish,
}

impl ReleaseAction {
    pub fn label(self) -> &'static str {
        match self {
            Self::Release => "Release",
            Self::BuildAndTest => "Build & test",
            Self::Publish => "Publish",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ReleaseSetup {
    pub cwd: String,
    pub can_build_and_test: bool,
    pub can_publish: bool,
    #[allow(dead_code)]
    pub restart_after_test: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseState {
    pub version: Option<String>,
    pub draft_ready: bool,
    pub published: bool,
}

fn config(project: &Project) -> Result<(ReleaseSetup, ReleaseConfig)> {
    if !project.releases_enabled {
        bail!("Releases are disabled for this project");
    }
    let root = Path::new(&project.path)
        .canonicalize()
        .with_context(|| format!("resolve project path {}", project.path))?;
    let config_path = confined_path(&root, &project.release_config_path)?;
    let config: ReleaseConfig = serde_json::from_str(
        &std::fs::read_to_string(&config_path)
            .with_context(|| format!("read release config {}", config_path.display()))?,
    )
    .context("Invalid release configuration")?;
    if config.command.trim().is_empty() {
        bail!("Release command is empty");
    }
    let _ = git(&root, &["rev-parse", "--show-toplevel"])
        .context("Release requires a Git repository root; check the project path and Git setup.")?;
    Ok((
        ReleaseSetup {
            cwd: root.to_string_lossy().into(),
            can_build_and_test: action_text(&config, ReleaseAction::BuildAndTest).is_some(),
            can_publish: action_text(&config, ReleaseAction::Publish).is_some(),
            restart_after_test: config.restart_after_test,
        },
        config,
    ))
}

pub fn load_setup(project: &Project) -> Result<ReleaseSetup> {
    config(project).map(|(setup, _)| setup)
}

pub fn latest(project: &Project) -> Result<String> {
    let (setup, config) = config(project)?;
    let command = config
        .latest_command
        .filter(|command| !command.trim().is_empty())
        .context("Latest release lookup is not configured")?;
    capture(&setup.cwd, &command, "Latest release lookup")
}

pub fn state(project: &Project, version: &str) -> Result<Option<ReleaseState>> {
    let (setup, config) = config(project)?;
    let Some(command) = config
        .state_command
        .filter(|command| !command.trim().is_empty())
    else {
        return Ok(None);
    };
    if version.len() > 256 || version.contains('\0') {
        bail!("Invalid release version");
    }
    let command = format!(
        "export STACKS_RELEASE_VERSION={} STACKS_RELEASE_PROJECT_PATH={}; {command}",
        quote(version),
        quote(&setup.cwd)
    );
    let value = capture(&setup.cwd, &command, "Release status")?;
    let state: ReleaseState =
        serde_json::from_str(&value).with_context(|| format!("Invalid release status: {value}"))?;
    if !version.is_empty() && state.version.as_deref() != Some(version) {
        bail!("Release status returned a different version");
    }
    Ok(Some(state))
}

pub fn action_command(
    project: &Project,
    version: &str,
    action: ReleaseAction,
) -> Result<(String, ReleaseSetup)> {
    let (setup, config) = config(project)?;
    let command = action_text(&config, action).with_context(|| {
        format!(
            "{} is not configured in {}",
            action.label(),
            project.release_config_path
        )
    })?;
    let command = if action == ReleaseAction::Publish {
        format!(
            "export STACKS_RELEASE_UI_CONFIRMATION={}; {command}",
            quote(&format!("publish:{version}"))
        )
    } else {
        format!("unset STACKS_RELEASE_UI_CONFIRMATION; {command}")
    };
    Ok((version_command(&command, version, &setup.cwd)?, setup))
}

pub fn next_patch_version(latest: &str) -> Option<String> {
    let version = normalize_version(latest)?;
    let mut parts = version.split('.');
    let major = parts.next()?;
    let minor = parts.next()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    Some(format!("{major}.{minor}.{}", patch + 1))
}

pub fn normalize_version(value: &str) -> Option<String> {
    let value = value.trim();
    let body = value.strip_prefix('v').unwrap_or(value);
    let mut parts = body.split('.');
    let major = parts.next()?;
    let minor = parts.next()?;
    let patch = parts.next()?;
    if parts.next().is_some()
        || [major, minor, patch].iter().any(|part| {
            part.is_empty() || !part.chars().all(|character| character.is_ascii_digit())
        })
    {
        return None;
    }
    Some(format!(
        "{}.{}.{}",
        major.parse::<u64>().ok()?,
        minor.parse::<u64>().ok()?,
        patch.parse::<u64>().ok()?
    ))
}

fn action_text(config: &ReleaseConfig, action: ReleaseAction) -> Option<String> {
    let command = match action {
        ReleaseAction::Release => Some(config.command.clone()),
        ReleaseAction::BuildAndTest => config.build_and_test_command.clone(),
        ReleaseAction::Publish => config.publish_command.clone(),
    }?;
    (!command.trim().is_empty()).then_some(command)
}

fn version_command(command: &str, version: &str, root: &str) -> Result<String> {
    if version.trim().is_empty() || version.contains('\0') || version.len() > 256 {
        bail!("Enter a version (at most 256 bytes, no NUL)");
    }
    Ok(format!(
        "cd {} || exit $?; export STACKS_RELEASE_VERSION={} STACKS_RELEASE_PROJECT_PATH={}; {}",
        quote(root),
        quote(version),
        quote(root),
        command
    ))
}

fn confined_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        bail!("Release configuration must be repository-relative");
    }
    let path = root
        .join(path)
        .canonicalize()
        .context("Resolve release configuration path")?;
    if !path.starts_with(root) {
        bail!("Release configuration escapes the project directory");
    }
    Ok(path)
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn git(root: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .context("run git")?;
    if !output.status.success() {
        bail!("{}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
}

fn capture(cwd: &str, command: &str, label: &str) -> Result<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let full = format!("cd {} || exit $?; {command}", quote(cwd));
    let mut child = Command::new(&shell)
        .args(["-lic", &full])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("start {label}"))?;
    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if started.elapsed() > Duration::from_secs(15) {
            let _ = child.kill();
            bail!("{label} timed out");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        bail!(
            "{label} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_suggestion_and_validation() {
        assert_eq!(next_patch_version("1.2.9").as_deref(), Some("1.2.10"));
        assert_eq!(normalize_version("v01.2.3").as_deref(), Some("1.2.3"));
        assert_eq!(normalize_version("1.2"), None);
    }

    #[test]
    fn version_command_exports_release_contract() {
        let command =
            version_command("echo $STACKS_RELEASE_VERSION", "1.2.3", "/tmp/repo").unwrap();
        assert!(command.contains("STACKS_RELEASE_VERSION='1.2.3'"));
        assert!(command.contains("STACKS_RELEASE_PROJECT_PATH='/tmp/repo'"));
    }
}
