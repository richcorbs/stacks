use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    env,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, State, Window};

use crate::{fs_paths::app_data_dir, process_group};

static TRUST_FILE_LOCK: Mutex<()> = Mutex::new(());

pub struct PiRpcHandle {
    stdin: ChildStdin,
    generation: String,
    stop_tx: mpsc::Sender<mpsc::Sender<()>>,
    alive: Arc<AtomicBool>,
    cwd: String,
    approve_project: bool,
}

impl PiRpcHandle {
    fn stop(&self) {
        let (finished_tx, finished_rx) = mpsc::channel();
        if self.stop_tx.send(finished_tx).is_ok() {
            let _ = finished_rx.recv_timeout(Duration::from_secs(2));
        }
    }
}

#[derive(Default)]
pub struct PiRpcRegistry {
    sessions: HashMap<String, PiRpcHandle>,
    starting: HashSet<String>,
    cancelled: HashSet<String>,
}

impl Drop for PiRpcRegistry {
    fn drop(&mut self) {
        for handle in self.sessions.values() {
            handle.stop();
        }
    }
}

#[derive(Clone, Serialize)]
struct PiRpcEvent {
    pane_id: String,
    generation: String,
    event: Value,
}

#[tauri::command]
pub fn start_pi_session(
    window: Window,
    registry: State<'_, Mutex<PiRpcRegistry>>,
    pane_id: String,
    cwd: String,
    project_path: Option<String>,
) -> Result<String, String> {
    if pane_id.trim().is_empty() {
        return Err("Pi pane ID is required".to_string());
    }
    let cwd = canonical_project_path(&cwd)?;
    let project_path = project_path
        .as_deref()
        .map(canonical_project_path)
        .transpose()?;
    let trusted_projects = read_trusted_projects()?;
    let approve_project = is_project_trusted(&trusted_projects, &cwd, project_path.as_deref());

    // React panes can remount while their first start is still in flight. Treat
    // concurrent starts as idempotent and wait for the owner instead of leaving
    // the remounted pane in an error state.
    let wait_started = Instant::now();
    let replaced_handle = loop {
        let mut guard = registry
            .lock()
            .map_err(|_| "Pi session registry lock poisoned".to_string())?;
        if let Some(handle) = guard.sessions.get(&pane_id) {
            if handle.alive.load(Ordering::Acquire)
                && handle.cwd == cwd
                && handle.approve_project == approve_project
            {
                return Ok(handle.generation.clone());
            }
        }
        if guard.starting.contains(&pane_id) {
            drop(guard);
            if wait_started.elapsed() >= Duration::from_secs(30) {
                return Err("Timed out waiting for Pi session startup".to_string());
            }
            std::thread::sleep(Duration::from_millis(25));
            continue;
        }
        let replaced_handle = guard.sessions.remove(&pane_id);
        guard.cancelled.remove(&pane_id);
        guard.starting.insert(pane_id.clone());
        break replaced_handle;
    };
    if let Some(handle) = replaced_handle {
        handle.stop();
    }

    let result = spawn_pi_session(&window, &pane_id, &cwd, approve_project);
    let mut guard = registry
        .lock()
        .map_err(|_| "Pi session registry lock poisoned".to_string())?;
    guard.starting.remove(&pane_id);

    match result {
        Ok(handle) => {
            if guard.cancelled.remove(&pane_id) {
                drop(guard);
                handle.stop();
                return Err("Pi session start was cancelled".to_string());
            }
            let generation = handle.generation.clone();
            guard.sessions.insert(pane_id, handle);
            Ok(generation)
        }
        Err(error) => Err(error),
    }
}

fn spawn_pi_session(
    window: &Window,
    pane_id: &str,
    cwd: &str,
    approve_project: bool,
) -> Result<PiRpcHandle, String> {
    let pi =
        find_pi().ok_or_else(|| "Pi CLI not found. Install `pi` or set PI_PATH.".to_string())?;
    let runtime_path = pi_runtime_path(&pi);
    let session_dir = session_dir(pane_id)?;
    std::fs::create_dir_all(&session_dir).map_err(|error| error.to_string())?;

    let generation = uuid::Uuid::new_v4().to_string();
    let trust_flag = project_trust_flag(approve_project);
    let mut pi_command = Command::new(pi);
    pi_command
        .current_dir(cwd)
        .args([
            "--mode",
            "rpc",
            trust_flag,
            "--session-dir",
            session_dir
                .to_str()
                .ok_or_else(|| "Pi session path is invalid".to_string())?,
            "--continue",
            "--name",
            "Stacks Pi GUI",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = runtime_path {
        pi_command.env("PATH", path);
    }
    process_group::configure(&mut pi_command);
    let mut child = pi_command.spawn()
        .map_err(|error| format!("Could not start Pi: {error}"))?;

    let pipes = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let (stdin, stdout, stderr) = match pipes {
        (Some(stdin), Some(stdout), Some(stderr)) => (stdin, stdout, stderr),
        _ => {
            process_group::terminate(&mut child, Duration::from_millis(500));
            return Err("Could not open Pi process streams".to_string());
        }
    };

    let alive = Arc::new(AtomicBool::new(true));
    let (stop_tx, stop_rx) = mpsc::channel::<mpsc::Sender<()>>();

    let output_window = window.clone();
    let output_pane_id = pane_id.to_string();
    let output_generation = generation.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            match reader.read_until(b'\n', &mut bytes) {
                Ok(0) => break,
                Ok(_) => {
                    if bytes.last() == Some(&b'\n') {
                        bytes.pop();
                    }
                    if bytes.last() == Some(&b'\r') {
                        bytes.pop();
                    }
                    if bytes.is_empty() {
                        continue;
                    }
                    let event = serde_json::from_slice(&bytes).unwrap_or_else(
                        |error| json!({"type":"pi_protocol_error","message":error.to_string()}),
                    );
                    emit_event(&output_window, &output_pane_id, &output_generation, event);
                }
                Err(error) => {
                    emit_event(
                        &output_window,
                        &output_pane_id,
                        &output_generation,
                        json!({"type":"pi_protocol_error","message":error.to_string()}),
                    );
                    break;
                }
            }
        }
    });

    let error_window = window.clone();
    let error_pane_id = pane_id.to_string();
    let error_generation = generation.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            emit_event(
                &error_window,
                &error_pane_id,
                &error_generation,
                json!({"type":"pi_stderr","message":line}),
            );
        }
    });

    let process_window = window.clone();
    let process_pane_id = pane_id.to_string();
    let process_generation = generation.clone();
    let process_alive = alive.clone();
    std::thread::spawn(move || {
        loop {
            if let Ok(finished_tx) = stop_rx.try_recv() {
                process_group::terminate(&mut child, Duration::from_millis(750));
                let _ = finished_tx.send(());
                break;
            }
            match child.try_wait() {
                Ok(Some(_)) => {
                    // Pi can exit while a tool subprocess is still alive.
                    process_group::terminate(&mut child, Duration::from_millis(250));
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => {
                    process_group::terminate(&mut child, Duration::from_millis(500));
                    break;
                }
            }
        }
        process_alive.store(false, Ordering::Release);
        emit_event(
            &process_window,
            &process_pane_id,
            &process_generation,
            json!({"type":"pi_process_exit"}),
        );
    });

    Ok(PiRpcHandle {
        stdin,
        generation,
        stop_tx,
        alive,
        cwd: cwd.to_string(),
        approve_project,
    })
}

#[tauri::command]
pub fn send_pi_rpc(
    registry: State<'_, Mutex<PiRpcRegistry>>,
    pane_id: String,
    command: Value,
) -> Result<(), String> {
    let mut guard = registry
        .lock()
        .map_err(|_| "Pi session registry lock poisoned".to_string())?;
    let handle = guard
        .sessions
        .get_mut(&pane_id)
        .ok_or_else(|| "Pi session is not running".to_string())?;
    if !handle.alive.load(Ordering::Acquire) {
        return Err("Pi session has exited".to_string());
    }
    send_json(&mut handle.stdin, &command)
}

#[tauri::command]
pub fn stop_pi_session(
    registry: State<'_, Mutex<PiRpcRegistry>>,
    pane_id: String,
) -> Result<(), String> {
    let handle = {
        let mut guard = registry
            .lock()
            .map_err(|_| "Pi session registry lock poisoned".to_string())?;
        if guard.starting.contains(&pane_id) {
            guard.cancelled.insert(pane_id.clone());
        }
        guard.sessions.remove(&pane_id)
    };
    if let Some(handle) = handle {
        handle.stop();
    }
    Ok(())
}

#[tauri::command]
pub fn delete_pi_session(
    registry: State<'_, Mutex<PiRpcRegistry>>,
    pane_id: String,
) -> Result<(), String> {
    let handle = {
        let mut guard = registry
            .lock()
            .map_err(|_| "Pi session registry lock poisoned".to_string())?;
        if guard.starting.contains(&pane_id) {
            guard.cancelled.insert(pane_id.clone());
        }
        guard.sessions.remove(&pane_id)
    };
    if let Some(handle) = handle {
        handle.stop();
    }

    // A delete can race an in-flight start. Wait for that start to observe the
    // cancellation before removing the directory it may still be creating.
    for _ in 0..100 {
        let starting = registry
            .lock()
            .map_err(|_| "Pi session registry lock poisoned".to_string())?
            .starting
            .contains(&pane_id);
        if !starting {
            let directory = session_dir(&pane_id)?;
            if directory.exists() {
                std::fs::remove_dir_all(directory).map_err(|error| error.to_string())?;
            }
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Err("Timed out while deleting a starting Pi session".to_string())
}

fn send_json(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *stdin, value).map_err(|error| error.to_string())?;
    stdin.write_all(b"\n").map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

fn emit_event(window: &Window, pane_id: &str, generation: &str, event: Value) {
    let _ = window.emit(
        "pi-rpc-event",
        PiRpcEvent {
            pane_id: pane_id.to_string(),
            generation: generation.to_string(),
            event,
        },
    );
}

fn session_dir(pane_id: &str) -> Result<PathBuf, String> {
    let mut directory = app_data_dir()?;
    directory.push("pi-sessions");
    directory.push(safe_session_key(pane_id));
    Ok(directory)
}

#[tauri::command]
pub fn pi_project_trusted(cwd: String, project_path: Option<String>) -> Result<bool, String> {
    let cwd = canonical_project_path(&cwd)?;
    let project_path = project_path
        .as_deref()
        .map(canonical_project_path)
        .transpose()?;
    let trusted_projects = read_trusted_projects()?;
    Ok(is_project_trusted(&trusted_projects, &cwd, project_path.as_deref()))
}

#[tauri::command]
pub fn set_pi_project_trusted(cwd: String, project_path: Option<String>, trusted: bool) -> Result<(), String> {
    let cwd = canonical_project_path(&cwd)?;
    let project_path = project_path
        .as_deref()
        .map(canonical_project_path)
        .transpose()?;
    let trust_path = project_path.unwrap_or_else(|| cwd.clone());
    let _guard = TRUST_FILE_LOCK.lock().map_err(|_| "Pi trust lock poisoned".to_string())?;
    let mut projects = read_trusted_projects_unlocked()?;
    if trusted {
        projects.insert(trust_path);
    } else {
        projects.remove(&trust_path);
        projects.remove(&cwd);
    }
    let mut path = app_data_dir()?;
    path.push("pi-trusted-projects.json");
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&projects).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn canonical_project_path(cwd: &str) -> Result<String, String> {
    std::fs::canonicalize(cwd)
        .map_err(|error| format!("Could not resolve Pi working directory: {error}"))?
        .to_str().map(str::to_string)
        .ok_or_else(|| "Pi working directory is not valid UTF-8".to_string())
}

fn is_project_trusted(trusted_projects: &HashSet<String>, cwd: &str, project_path: Option<&str>) -> bool {
    trusted_projects.contains(cwd)
        || project_path.is_some_and(|project_path| {
            trusted_projects.contains(project_path)
                && workspace_belongs_to_project(cwd, project_path)
        })
}

fn workspace_belongs_to_project(cwd: &str, project_path: &str) -> bool {
    if Path::new(cwd).starts_with(project_path) {
        return true;
    }
    match (git_common_directory(cwd), git_common_directory(project_path)) {
        (Some(cwd_git_dir), Some(project_git_dir)) => cwd_git_dir == project_git_dir,
        _ => false,
    }
}

fn git_common_directory(path: &str) -> Option<PathBuf> {
    let output = Command::new("git")
        .args(["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    std::fs::canonicalize(path).ok()
}

fn read_trusted_projects() -> Result<HashSet<String>, String> {
    let _guard = TRUST_FILE_LOCK.lock().map_err(|_| "Pi trust lock poisoned".to_string())?;
    read_trusted_projects_unlocked()
}

fn read_trusted_projects_unlocked() -> Result<HashSet<String>, String> {
    let mut path = app_data_dir()?;
    path.push("pi-trusted-projects.json");
    if !path.exists() { return Ok(HashSet::new()); }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| format!("Could not read trusted Pi projects: {error}"))
}

fn project_trust_flag(approved: bool) -> &'static str {
    if approved {
        "--approve"
    } else {
        "--no-approve"
    }
}

fn safe_session_key(pane_id: &str) -> String {
    pane_id
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

fn pi_runtime_path(pi: &std::path::Path) -> Option<std::ffi::OsString> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let login_path = Command::new(shell)
        .args(["-lic", "printf %s \"$PATH\""])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|path| !path.is_empty());
    if let Some(path) = login_path {
        return Some(path.into());
    }

    let executable_dir = pi.parent()?;
    let mut paths = vec![executable_dir.to_path_buf()];
    paths.extend(env::var_os("PATH").as_deref().map(env::split_paths).into_iter().flatten());
    env::join_paths(paths).ok()
}

fn find_pi() -> Option<PathBuf> {
    if let Some(path) = env::var_os("PI_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    if let Some(path) = env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".local/bin/pi"))
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    for path in ["/opt/homebrew/bin/pi", "/usr/local/bin/pi", "/usr/bin/pi"] {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = Command::new(shell)
        .args(["-lic", "command -v pi"])
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
    use super::{is_project_trusted, project_trust_flag, safe_session_key};
    use std::collections::HashSet;

    #[test]
    fn creates_safe_session_directory_names() {
        assert_eq!(safe_session_key("workspace:123"), "workspace_123");
    }

    #[test]
    fn workspace_directories_inherit_project_trust_only_when_related() {
        let trusted = HashSet::from(["/repo".to_string()]);
        assert!(is_project_trusted(&trusted, "/repo/workspaces/one", Some("/repo")));
        assert!(!is_project_trusted(&trusted, "/unrelated", Some("/repo")));
    }

    #[test]
    fn does_not_trust_projects_without_explicit_approval() {
        assert_eq!(project_trust_flag(false), "--no-approve");
        assert_eq!(project_trust_flag(true), "--approve");
    }
}
