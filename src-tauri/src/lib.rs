use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, io::{Read, Write}, path::PathBuf, process::Command, sync::Mutex, thread};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Window};
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
    #[serde(default)]
    splits: Option<serde_json::Value>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppStats {
    cpu: f32,
    mem_mb: u64,
    version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WindowState {
    width: u32,
    height: u32,
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AppSettings {
    #[serde(default)]
    window: Option<WindowState>,
    #[serde(default)]
    sidebar_width: Option<u32>,
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

fn app_data_dir() -> Result<PathBuf, String> {
    let mut dir = dirs::data_dir().ok_or_else(|| "Could not locate user data directory".to_string())?;
    dir.push("stacks-tauri");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn store_path() -> Result<PathBuf, String> {
    let mut path = app_data_dir()?;
    path.push("projects.json");
    Ok(path)
}

fn settings_path() -> Result<PathBuf, String> {
    let mut path = app_data_dir()?;
    path.push("settings.json");
    Ok(path)
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
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|e| e.to_string())
}

fn load_settings_from_disk() -> AppSettings {
    settings_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<AppSettings>(&text).ok())
        .unwrap_or_default()
}

fn save_settings_to_disk(settings: &AppSettings) -> Result<(), String> {
    let path = settings_path()?;
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_settings() -> AppSettings {
    load_settings_from_disk()
}

#[tauri::command]
fn persist_window_state(state: WindowState) -> Result<(), String> {
    let mut settings = load_settings_from_disk();
    settings.window = Some(WindowState {
        width: state.width.clamp(780, 10_000),
        height: state.height.clamp(500, 10_000),
        x: state.x,
        y: state.y,
    });
    save_settings_to_disk(&settings)
}

#[tauri::command]
fn save_window_state(state: WindowState) -> Result<(), String> {
    persist_window_state(state)
}

#[tauri::command]
fn save_current_window_state(window: Window) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    persist_window_state(WindowState {
        width: ((size.width as f64) / scale).round() as u32,
        height: ((size.height as f64) / scale).round() as u32,
        x: Some(((position.x as f64) / scale).round() as i32),
        y: Some(((position.y as f64) / scale).round() as i32),
    })
}

#[tauri::command]
fn save_sidebar_width(width: u32) -> Result<(), String> {
    let mut settings = load_settings_from_disk();
    settings.sidebar_width = Some(width.clamp(180, 420));
    save_settings_to_disk(&settings)
}

fn load_window_state() -> Option<WindowState> {
    load_settings_from_disk().window
}

#[tauri::command]
fn new_id() -> String {
    Uuid::new_v4().to_string()
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
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
        if shell.ends_with("zsh") || shell.ends_with("bash") {
            // macOS .app launches do not inherit a user's Terminal environment.
            // Run startup commands in an interactive login shell so ~/.zshrc,
            // nvm, Homebrew PATH setup, etc. are available before execing the
            // long-lived shell.
            cmd.arg("-lic");
        } else {
            cmd.arg("-lc");
        }
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

#[tauri::command]
fn pty_cwd(registry: State<'_, Mutex<PtyRegistry>>, pane_id: String) -> Result<Option<String>, String> {
    let pid = {
        let guard = registry.lock().map_err(|_| "PTY registry lock poisoned".to_string())?;
        let handle = guard.panes.get(&pane_id).ok_or_else(|| "Unknown PTY pane".to_string())?;
        handle.child.process_id()
    };

    let Some(pid) = pid else { return Ok(None); };
    let output = Command::new("lsof")
        .args(["-a", "-d", "cwd", "-p", &pid.to_string(), "-Fn"])
        .output()
        .map_err(|err| err.to_string())?;

    if !output.status.success() {
        return Ok(None);
    }

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(cwd) = line.strip_prefix('n') {
            return Ok(Some(cwd.to_string()));
        }
    }
    Ok(None)
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
fn app_stats() -> Result<AppStats, String> {
    let pid = std::process::id().to_string();
    let output = Command::new("ps")
        .args(["-o", "%cpu=", "-o", "rss=", "-p", &pid])
        .output()
        .map_err(|err| err.to_string())?;

    let text = String::from_utf8_lossy(&output.stdout);
    let mut parts = text.split_whitespace();
    let cpu = parts.next().and_then(|s| s.parse::<f32>().ok()).unwrap_or(0.0);
    let rss_kb = parts.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);

    Ok(AppStats {
        cpu,
        mem_mb: (rss_kb + 1023) / 1024,
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(PtyRegistry::default()))
        .invoke_handler(tauri::generate_handler![
            load_store,
            save_store,
            load_settings,
            save_window_state,
            save_current_window_state,
            save_sidebar_width,
            new_id,
            quit_app,
            spawn_pty,
            write_pty,
            resize_pty,
            kill_pty,
            pty_cwd,
            app_stats,
            git_info,
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let title = if cfg!(debug_assertions) {
                    "Stacks Tauri - DEV BUILD"
                } else {
                    "Stacks"
                };
                let _ = window.set_title(title);
                if let Some(state) = load_window_state() {
                    let width = state.width.clamp(780, 10_000);
                    let height = state.height.clamp(500, 10_000);
                    let _ = window.set_size(LogicalSize::new(width, height));
                    if let (Some(x), Some(y)) = (state.x, state.y) {
                        let _ = window.set_position(LogicalPosition::new(x, y));
                    }
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
