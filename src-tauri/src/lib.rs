use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, io::{Read, Write}, path::PathBuf, process::Command, sync::Mutex, thread};
use tauri::{Emitter, Manager, State, Window};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ProjectStore {
    projects: Vec<Project>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Project {
    id: String,
    name: String,
    path: String,
    #[serde(default)]
    terminals: Vec<TerminalEntry>,
    #[serde(default)]
    collapsed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TerminalEntry {
    id: String,
    name: String,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PtyData {
    pane_id: String,
    generation: String,
    data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PtyExit {
    pane_id: String,
    generation: String,
    status: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GitInfo {
    branch: String,
    added: u32,
    removed: u32,
}

struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
struct PtyRegistry {
    panes: HashMap<String, PtyHandle>,
}

fn store_path() -> Result<PathBuf, String> {
    let mut dir = dirs::data_dir().ok_or_else(|| "Could not locate user data directory".to_string())?;
    dir.push("stacks-tauri");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    dir.push("projects.json");
    Ok(dir)
}

#[tauri::command]
fn load_store() -> Result<ProjectStore, String> {
    let path = store_path()?;
    if !path.exists() {
        return Ok(ProjectStore::default());
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_store(store: ProjectStore) -> Result<(), String> {
    let path = store_path()?;
    let text = serde_json::to_string_pretty(&store).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn new_id() -> String {
    Uuid::new_v4().to_string()
}

#[tauri::command]
fn spawn_pty(
    window: Window,
    registry: State<'_, Mutex<PtyRegistry>>,
    pane_id: String,
    generation: Option<String>,
    cwd: String,
    command: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let generation = generation.unwrap_or_else(|| format!("{}:{}", pane_id, uuid::Uuid::new_v4()));
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let startup_command = command
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    if let Some(startup) = startup_command {
        cmd.arg("-lc");
        cmd.arg(format!("{}; exec {} -l", startup, shell));
    } else if shell.ends_with("zsh") || shell.ends_with("bash") {
        cmd.arg("-l");
    }
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    {
        let mut guard = registry.lock().map_err(|_| "PTY registry lock poisoned".to_string())?;
        if let Some(mut old) = guard.panes.remove(&pane_id) {
            let _ = old.child.kill();
        }
        guard.panes.insert(pane_id.clone(), PtyHandle { master: pair.master, writer, child });
    }

    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = window.emit("pty-data", PtyData { pane_id: pane_id.clone(), generation: generation.clone(), data: buf[..n].to_vec() });
                }
                Err(_) => break,
            }
        }
        let _ = window.emit("pty-exit", PtyExit { pane_id, generation, status: None });
    });

    Ok(())
}

#[tauri::command]
fn write_pty(registry: State<'_, Mutex<PtyRegistry>>, pane_id: String, data: Vec<u8>) -> Result<(), String> {
    let mut guard = registry.lock().map_err(|_| "PTY registry lock poisoned".to_string())?;
    let handle = guard.panes.get_mut(&pane_id).ok_or_else(|| "Unknown PTY pane".to_string())?;
    handle.writer.write_all(&data).map_err(|e| e.to_string())?;
    handle.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn resize_pty(registry: State<'_, Mutex<PtyRegistry>>, pane_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let mut guard = registry.lock().map_err(|_| "PTY registry lock poisoned".to_string())?;
    let handle = guard.panes.get_mut(&pane_id).ok_or_else(|| "Unknown PTY pane".to_string())?;
    handle.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[tauri::command]
fn kill_pty(registry: State<'_, Mutex<PtyRegistry>>, pane_id: String) -> Result<(), String> {
    let mut guard = registry.lock().map_err(|_| "PTY registry lock poisoned".to_string())?;
    if let Some(mut handle) = guard.panes.remove(&pane_id) {
        let _ = handle.child.kill();
    }
    Ok(())
}

fn parse_numstat(text: &str, added: &mut u32, removed: &mut u32) {
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        if let Some(a) = parts.next().and_then(|s| s.parse::<u32>().ok()) {
            *added = added.saturating_add(a);
        }
        if let Some(r) = parts.next().and_then(|s| s.parse::<u32>().ok()) {
            *removed = removed.saturating_add(r);
        }
    }
}

#[tauri::command]
fn git_info(path: String) -> Result<Option<GitInfo>, String> {
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

    let mut added = 0u32;
    let mut removed = 0u32;

    // Unstaged tracked changes.
    if let Ok(output) = Command::new("git")
        .args(["-C", &path, "diff", "--numstat"])
        .output()
    {
        if output.status.success() {
            parse_numstat(&String::from_utf8_lossy(&output.stdout), &mut added, &mut removed);
        }
    }

    // Staged tracked changes.
    if let Ok(output) = Command::new("git")
        .args(["-C", &path, "diff", "--cached", "--numstat"])
        .output()
    {
        if output.status.success() {
            parse_numstat(&String::from_utf8_lossy(&output.stdout), &mut added, &mut removed);
        }
    }

    // Count untracked files as +1 each so new files show activity without
    // huge noisy counts for lockfiles/generated files.
    if let Ok(output) = Command::new("git")
        .args(["-C", &path, "status", "--porcelain=v1", "--untracked-files=all"])
        .output()
    {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                if line.starts_with("?? ") {
                    added = added.saturating_add(1);
                }
            }
        }
    }

    Ok(Some(GitInfo { branch, added, removed }))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(PtyRegistry::default()))
        .invoke_handler(tauri::generate_handler![
            load_store,
            save_store,
            new_id,
            spawn_pty,
            write_pty,
            resize_pty,
            kill_pty,
            git_info,
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Stacks Tauri");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
