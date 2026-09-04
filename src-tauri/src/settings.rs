use std::{collections::HashMap, fs, sync::{Mutex, OnceLock}};
use tauri::Window;

use crate::fs_paths::app_data_file;
pub use crate::settings_model::{AppSettings, WindowState};

static SETTINGS_FILE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn settings_file_lock() -> &'static Mutex<()> {
    SETTINGS_FILE_LOCK.get_or_init(|| Mutex::new(()))
}

fn settings_path() -> Result<std::path::PathBuf, String> {
    app_data_file("settings.json")
}

fn read_settings_from_disk_unlocked() -> AppSettings {
    settings_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<AppSettings>(&text).ok())
        .unwrap_or_default()
}

fn write_settings_to_disk_unlocked(settings: &AppSettings) -> Result<(), String> {
    let path = settings_path()?;
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|e| e.to_string())
}

fn load_settings_from_disk() -> AppSettings {
    let _guard = settings_file_lock().lock().ok();
    read_settings_from_disk_unlocked()
}

fn update_settings_on_disk(update: impl FnOnce(&mut AppSettings)) -> Result<(), String> {
    let _guard = settings_file_lock().lock().map_err(|_| "Settings file lock poisoned".to_string())?;
    let mut settings = read_settings_from_disk_unlocked();
    update(&mut settings);
    write_settings_to_disk_unlocked(&settings)
}

#[tauri::command]
pub fn load_settings() -> AppSettings {
    load_settings_from_disk()
}

#[tauri::command]
pub fn persist_window_state(state: WindowState) -> Result<(), String> {
    update_settings_on_disk(|settings| {
        settings.window = Some(state.clamped());
    })
}

#[tauri::command]
pub fn save_window_state(state: WindowState) -> Result<(), String> {
    persist_window_state(state)
}

#[tauri::command]
pub fn save_current_window_state(window: Window) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    persist_window_state(WindowState::new(
        ((size.width as f64) / scale).round() as u32,
        ((size.height as f64) / scale).round() as u32,
        Some(((position.x as f64) / scale).round() as i32),
        Some(((position.y as f64) / scale).round() as i32),
    ))
}

#[tauri::command]
pub fn save_sidebar_width(width: u32) -> Result<(), String> {
    update_settings_on_disk(|settings| {
        settings.sidebar_width = Some(width.clamp(180, 420));
    })
}

#[tauri::command]
pub fn save_developer_services_state(visible: bool, active_tab: String) -> Result<(), String> {
    if !matches!(active_tab.as_str(), "superthread" | "diff" | "pull-requests" | "actions") {
        return Err("Invalid developer services tab".to_string());
    }
    update_settings_on_disk(|settings| {
        settings.developer_services_visible = Some(visible);
        settings.developer_services_tab = Some(active_tab);
    })
}

#[tauri::command]
pub fn save_terminal_font_size(font_size: u32) -> Result<(), String> {
    update_settings_on_disk(|settings| {
        settings.terminal_font_size = Some(font_size.clamp(8, 32));
    })
}

#[tauri::command]
pub fn save_workspace_focus(
    active_project_id: Option<String>,
    active_workspace_id: Option<String>,
    focused_terminal_by_workspace_id: HashMap<String, String>,
    maximized_workspace_ids: HashMap<String, bool>,
) -> Result<(), String> {
    update_settings_on_disk(|settings| {
        settings.active_project_id = active_project_id.filter(|id| !id.trim().is_empty());
        settings.active_workspace_id = active_workspace_id.filter(|id| !id.trim().is_empty());
        settings.focused_terminal_by_workspace_id = Some(focused_terminal_by_workspace_id);
        settings.maximized_workspace_ids = Some(maximized_workspace_ids.into_iter().filter(|(_, maximized)| *maximized).collect());
    })
}

#[tauri::command]
pub fn save_app_settings(next: AppSettings) -> Result<(), String> {
    update_settings_on_disk(|settings| settings.apply_user_settings(next))
}

pub fn reset_settings_file() -> Result<(), String> {
    update_settings_on_disk(|settings| {
        settings.window = None;
        settings.sidebar_width = None;
    })
}

#[tauri::command]
pub fn reset_settings() -> Result<(), String> {
    reset_settings_file()
}

pub fn load_window_state() -> Option<WindowState> {
    load_settings_from_disk().window
}

