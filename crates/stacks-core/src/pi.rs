//! Persistent Pi RPC sessions for card CHAT threads.
//!
//! Protocol shape follows `src-tauri/src/pi_rpc.rs` and the native card #322
//! agent view: `pi --mode rpc`, newline-delimited JSON on stdin/stdout, one
//! process per card thread, transcripts persisted through `--session-dir`.

use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use crate::paths;

pub const MAX_STORED_PI_MESSAGES: usize = 400;

#[derive(Debug, Clone)]
pub enum PiEvent {
    Json(Value),
    Stderr(String),
    Exited(Option<i32>),
}

pub type PiSink = Arc<dyn Fn(PiEvent) + Send + Sync>;

pub struct PiSession {
    pub owner_id: String,
    pub generation: String,
    stdin: Arc<Mutex<ChildStdin>>,
    child: Child,
    alive: Arc<AtomicBool>,
    sequence: AtomicU64,
    sink: PiSink,
}

impl PiSession {
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        owner_id: impl Into<String>,
        cwd: &str,
        project_id: &str,
        project_path: &str,
        session_dir: &Path,
        trusted: bool,
        enable_mcp: bool,
        sink: PiSink,
    ) -> Result<Self, String> {
        let owner_id = owner_id.into();
        let pi = find_pi()
            .ok_or_else(|| "Pi CLI not found. Install `pi` or set PI_PATH.".to_string())?;
        std::fs::create_dir_all(session_dir)
            .map_err(|error| format!("Could not create the Pi session directory: {error}"))?;
        let extension = extension_path().filter(|path| path.is_file());
        let mut command = Command::new(pi);
        command
            .current_dir(cwd)
            .arg("--mode")
            .arg("rpc")
            .arg(if trusted { "--approve" } else { "--no-approve" })
            .arg("--no-extensions");
        if enable_mcp {
            for extension in ["builtin:codemode", "builtin:tool-search", "builtin:mcp"] {
                command.arg("--extension").arg(extension);
            }
        } else if let Some(extension) = extension.as_ref() {
            command.arg("--extension").arg(extension);
        }
        command
            .arg("--session-dir")
            .arg(session_dir)
            .arg("--continue")
            .arg("--name")
            .arg("Stacks TUI")
            .env("STACKS_PROJECT_ID", project_id)
            .env("STACKS_PROJECT_NAME", project_path)
            .env("STACKS_PI_OWNER", &owner_id)
            .env("STACKS_TUI", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start Pi: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Could not open Pi stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Could not open Pi stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Could not open Pi stderr".to_string())?;
        let alive = Arc::new(AtomicBool::new(true));
        let generation = format!("stacks-tui-pi:{}", uuid::Uuid::new_v4());

        let reader_sink = Arc::clone(&sink);
        std::thread::Builder::new()
            .name("stacks-tui-pi-stdout".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    match serde_json::from_str::<Value>(&line) {
                        Ok(value) => reader_sink(PiEvent::Json(value)),
                        Err(_) => reader_sink(PiEvent::Stderr(line)),
                    }
                }
            })
            .map_err(|error| format!("Could not start the Pi reader: {error}"))?;

        let stderr_sink = Arc::clone(&sink);
        std::thread::Builder::new()
            .name("stacks-tui-pi-stderr".into())
            .spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    stderr_sink(PiEvent::Stderr(line));
                }
            })
            .map_err(|error| format!("Could not start the Pi error reader: {error}"))?;

        Ok(Self {
            owner_id,
            generation,
            stdin: Arc::new(Mutex::new(stdin)),
            child,
            alive,
            sequence: AtomicU64::new(1),
            sink,
        })
    }

    pub fn send(&self, mut command: Value) -> Result<(), String> {
        if !self.alive.load(Ordering::Acquire) {
            return Err("Pi session has exited".to_string());
        }
        if command.get("id").is_none() {
            let id = self.sequence.fetch_add(1, Ordering::Relaxed);
            if let Some(object) = command.as_object_mut() {
                object.insert("id".into(), Value::from(format!("tui-{id}")));
            }
        }
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "Pi stdin lock poisoned".to_string())?;
        writeln!(stdin, "{command}").map_err(|error| error.to_string())?;
        stdin.flush().map_err(|error| error.to_string())
    }

    pub fn prompt(&self, text: &str) -> Result<(), String> {
        self.send(json!({"type": "prompt", "message": text}))
    }

    pub fn steer(&self, text: &str) -> Result<(), String> {
        self.send(json!({"type": "steer", "message": text}))
    }

    pub fn follow_up(&self, text: &str) -> Result<(), String> {
        self.send(json!({"type": "follow_up", "message": text}))
    }

    pub fn abort(&self) -> Result<(), String> {
        self.send(json!({"type": "abort"}))
    }

    pub fn stop(&mut self) {
        self.alive.store(false, Ordering::Release);
        let _ = self.child.kill();
        let _ = self.child.wait();
        (self.sink)(PiEvent::Exited(
            self.child
                .try_wait()
                .ok()
                .flatten()
                .and_then(|status| status.code()),
        ));
    }

    pub fn has_exited(&mut self) -> bool {
        if !self.alive.load(Ordering::Acquire) {
            return true;
        }
        match self.child.try_wait() {
            Ok(Some(status)) => {
                self.alive.store(false, Ordering::Release);
                (self.sink)(PiEvent::Exited(status.code()));
                true
            }
            Ok(None) => false,
            Err(_) => true,
        }
    }
}

impl Drop for PiSession {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The exact interactive Pi launch used for native Chat/Work panes.
#[derive(Debug, Clone)]
pub struct NativeLaunch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

pub fn native_launch(
    project: &crate::model::Project,
    card: Option<(&str, &str)>,
    trusted: bool,
    automation_socket: &Path,
) -> Result<NativeLaunch, String> {
    let program =
        find_pi().ok_or_else(|| "Pi CLI not found. Install `pi` or set PI_PATH.".to_string())?;
    let extension = extension_path()
        .filter(|path| path.is_file())
        .ok_or_else(|| "The bundled Stacks Pi extension was not found".to_string())?;
    native_launch_with(
        program,
        extension,
        project,
        card,
        trusted,
        automation_socket,
    )
}

fn native_launch_with(
    program: PathBuf,
    extension: PathBuf,
    project: &crate::model::Project,
    card: Option<(&str, &str)>,
    trusted: bool,
    automation_socket: &Path,
) -> Result<NativeLaunch, String> {
    let session_dir = match card {
        Some((card_id, thread)) => {
            let directory = card_session_dir(card_id, thread);
            // The GUI renamed the planning thread from "main" to "planning".
            // A native pane must find the same persisted conversation.
            if thread == "planning" && !directory.exists() {
                if let Some(parent) = directory.parent() {
                    let legacy = parent.join("main");
                    if legacy.is_dir() {
                        let _ = std::fs::rename(&legacy, &directory);
                    }
                }
            }
            directory
        }
        None => pi_sessions_dir(),
    };
    native_launch_with_session(
        program,
        extension,
        project,
        card,
        trusted,
        automation_socket,
        session_dir,
    )
}

fn native_launch_with_session(
    program: PathBuf,
    extension: PathBuf,
    project: &crate::model::Project,
    card: Option<(&str, &str)>,
    trusted: bool,
    automation_socket: &Path,
    session_dir: PathBuf,
) -> Result<NativeLaunch, String> {
    std::fs::create_dir_all(&session_dir)
        .map_err(|error| format!("Could not create the Pi session directory: {error}"))?;
    let mut args = vec![
        if trusted { "--approve" } else { "--no-approve" }.to_string(),
        "--no-extensions".to_string(),
        "--extension".to_string(),
        extension.to_string_lossy().into_owned(),
    ];
    if project.enable_mcp {
        for builtin in ["builtin:codemode", "builtin:tool-search", "builtin:mcp"] {
            args.push("--extension".into());
            args.push(builtin.into());
        }
    }
    args.extend([
        "--session-dir".to_string(),
        session_dir.to_string_lossy().into_owned(),
        "--continue".to_string(),
        "--name".to_string(),
        "Stacks TUI".to_string(),
    ]);
    let mut env = vec![
        ("STACKS_PROJECT_ID".to_string(), project.id.clone()),
        ("STACKS_PROJECT_NAME".to_string(), project.name.clone()),
        (
            "STACKS_KANBAN_SOURCE".to_string(),
            project
                .kanban_source
                .clone()
                .unwrap_or_else(|| "local".to_string()),
        ),
        (
            "STACKS_AUTOMATION_SOCKET".to_string(),
            automation_socket.to_string_lossy().into_owned(),
        ),
    ];
    if let Some((card_id, thread)) = card {
        env.push(("STACKS_CARD_ID".to_string(), card_id.to_string()));
        env.push(("STACKS_CARD_THREAD".to_string(), thread.to_string()));
    }
    if project.enable_mcp {
        for name in project
            .mcp_env_names
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            if let Some(value) = resolve_env(name) {
                env.push((name.to_string(), value));
            }
        }
    }
    if let Some(name) = project.superthread_token_env_var.as_deref() {
        if let Some(value) = resolve_env(name) {
            env.push((name.to_string(), value));
        }
    }
    Ok(NativeLaunch { program, args, env })
}

/// Project-workspace Pi session directory (one persistent project agent).
pub fn project_session_dir(project_id: &str) -> PathBuf {
    pi_sessions_dir().join(format!("project-{}", safe_session_key(project_id)))
}

pub fn native_launch_project(
    project: &crate::model::Project,
    trusted: bool,
    automation_socket: &Path,
) -> Result<NativeLaunch, String> {
    let program =
        find_pi().ok_or_else(|| "Pi CLI not found. Install `pi` or set PI_PATH.".to_string())?;
    let extension = extension_path()
        .filter(|path| path.is_file())
        .ok_or_else(|| "The bundled Stacks Pi extension was not found".to_string())?;
    native_launch_with_session(
        program,
        extension,
        project,
        None,
        trusted,
        automation_socket,
        project_session_dir(&project.id),
    )
}

fn resolve_env(name: &str) -> Option<String> {
    if let Ok(value) = std::env::var(name) {
        if !value.trim().is_empty() {
            return Some(value);
        }
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let output = Command::new(shell)
        .args(["-lic", &format!("printf %s \"${name}\"")])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

pub fn find_pi() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PI_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let output = Command::new(shell)
        .args(["-lic", "command -v pi"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then_some(PathBuf::from(path))
}

pub fn safe_session_key(owner_id: &str) -> String {
    owner_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

pub fn pi_sessions_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("STACKS_TUI_PI_SESSIONS") {
        return PathBuf::from(path);
    }
    paths::product_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("pi-sessions")
}

pub fn card_session_dir(card_id: &str, thread: &str) -> PathBuf {
    paths::card_directory(card_id)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("pi-sessions")
        .join(safe_session_key(thread))
}

pub fn extension_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("STACKS_TUI_PI_EXTENSION") {
        return Some(PathBuf::from(path));
    }
    let bundled = std::env::current_exe().ok().and_then(|exe| {
        exe.parent()
            .map(|parent| parent.join("../Resources/stacks-cards.ts"))
    });
    if let Some(path) = bundled.as_ref() {
        if path.is_file() {
            return Some(path.clone());
        }
    }
    let development =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/resources/stacks-cards.ts");
    development.is_file().then_some(development)
}

pub fn project_trusted(project_path: &str) -> bool {
    let Ok(dir) = paths::product_data_dir() else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(dir.join("pi-trusted-projects.json")) else {
        return false;
    };
    serde_json::from_str::<Vec<String>>(&text)
        .map(|projects| projects.iter().any(|path| path == project_path))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_keys_are_path_safe() {
        assert_eq!(safe_session_key("local:../x"), "local____x");
        assert_eq!(safe_session_key("local-1_abc"), "local-1_abc");
    }

    #[test]
    fn message_compaction_limit_is_shared_with_the_gui() {
        assert_eq!(MAX_STORED_PI_MESSAGES, 400);
    }

    #[test]
    fn native_launch_uses_the_pi_tui_with_card_scope() {
        let dir = tempfile::tempdir().unwrap();
        let project = crate::model::Project {
            id: "p1".into(),
            name: "Stacks".into(),
            path: dir.path().to_string_lossy().into_owned(),
            color_id: None,
            delivery_workflow: crate::model::DeliveryWorkflow::LocalMerge,
            kanban_source: Some("local".into()),
            server_command: None,
            console_command: None,
            notes: String::new(),
            releases_enabled: false,
            release_config_path: String::new(),
            supports_feature_environments: false,
            target_branch: "main".into(),
            start_work_command: None,
            deployment_command: None,
            enable_mcp: false,
            mcp_env_names: String::new(),
            superthread_token_env_var: None,
        };
        let socket = dir.path().join("automation.sock");
        let launch = native_launch_with(
            std::path::PathBuf::from("/usr/local/bin/pi"),
            std::path::PathBuf::from("/tmp/stacks-cards.ts"),
            &project,
            Some(("local:1", "planning")),
            true,
            &socket,
        )
        .unwrap();
        assert_eq!(
            launch.program,
            std::path::PathBuf::from("/usr/local/bin/pi")
        );
        assert!(!launch.args.iter().any(|arg| arg == "--mode"));
        assert!(launch.args.iter().any(|arg| arg == "--no-extensions"));
        assert!(launch.args.iter().any(|arg| arg == "--session-dir"));
        assert!(launch.args.iter().any(|arg| arg == "Stacks TUI"));
        assert!(
            launch
                .env
                .iter()
                .any(|(key, value)| key == "STACKS_CARD_ID" && value == "local:1")
        );
        assert!(
            launch
                .env
                .iter()
                .any(|(key, _)| key == "STACKS_AUTOMATION_SOCKET")
        );
    }
}
