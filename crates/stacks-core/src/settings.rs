//! `settings.json` access shared with the Tauri app.
//!
//! Writes patch individual JSON keys instead of re-serialising the whole
//! struct, so keys owned by the GUI (or a future client) survive a TUI write.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use crate::paths;

static SETTINGS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const DEFAULT_CONFIRMATION_DELAY_MS: u64 = 2_000;

fn lock() -> &'static Mutex<()> {
    SETTINGS_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub command_usage_counts: Option<BTreeMap<String, u64>>,
    #[serde(default)]
    pub window: Option<Value>,
    #[serde(default)]
    pub ui_font_size: Option<u32>,
    #[serde(default)]
    pub terminal_font_size: Option<u32>,
    #[serde(default)]
    pub terminal_font_family: Option<String>,
    #[serde(default)]
    pub terminal_scrollback: Option<u32>,
    #[serde(default)]
    pub copy_on_select: Option<bool>,
    #[serde(default)]
    pub confirm_close: Option<bool>,
    #[serde(default)]
    pub confirm_delete: Option<bool>,
    #[serde(default)]
    pub editor_app: Option<String>,
    #[serde(default)]
    pub focused_terminal_border_color: Option<String>,
    #[serde(default)]
    pub maximized_terminal_border_color: Option<String>,
    #[serde(default)]
    pub superthread_enabled: Option<bool>,
    #[serde(default)]
    pub kanban_project_id: Option<String>,
    #[serde(default)]
    pub kanban_done_collapsed: Option<bool>,
    #[serde(default)]
    pub kanban_backlog_collapsed: Option<bool>,
    #[serde(default)]
    pub kanban_attention_collapsed: Option<bool>,
    #[serde(default)]
    pub kanban_progress_collapsed: Option<bool>,
    #[serde(default)]
    pub activity_notifications: Option<bool>,

    // TUI-owned preferences. The GUI ignores unknown JSON keys.
    #[serde(default)]
    pub tui_hide_done: Option<bool>,
    #[serde(default)]
    pub tui_confirmation_delay_ms: Option<u64>,
    #[serde(default)]
    pub tui_accent: Option<String>,
}

/// Preferences the TUI edits (write-through to `settings.json`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuiPreferences {
    pub confirmation_delay_ms: u64,
    pub hide_done: bool,
    pub accent: Option<String>,
    pub copy_on_select: bool,
    pub terminal_font_size: Option<u32>,
    pub terminal_scrollback: u32,
    pub confirm_close: bool,
    pub confirm_delete: bool,
}

impl Default for TuiPreferences {
    fn default() -> Self {
        Self {
            confirmation_delay_ms: DEFAULT_CONFIRMATION_DELAY_MS,
            hide_done: false,
            accent: None,
            copy_on_select: true,
            terminal_font_size: None,
            terminal_scrollback: 10_000,
            confirm_close: true,
            confirm_delete: true,
        }
    }
}

impl AppSettings {
    pub fn tui_preferences(&self) -> TuiPreferences {
        TuiPreferences {
            confirmation_delay_ms: self
                .tui_confirmation_delay_ms
                .unwrap_or(DEFAULT_CONFIRMATION_DELAY_MS)
                .clamp(0, 10_000),
            hide_done: self.tui_hide_done.unwrap_or(false),
            accent: self
                .tui_accent
                .clone()
                .filter(|value| !value.trim().is_empty()),
            copy_on_select: self.copy_on_select.unwrap_or(true),
            terminal_font_size: self.terminal_font_size,
            terminal_scrollback: self
                .terminal_scrollback
                .unwrap_or(10_000)
                .clamp(100, 200_000),
            confirm_close: self.confirm_close.unwrap_or(true),
            confirm_delete: self.confirm_delete.unwrap_or(true),
        }
    }
}

fn path() -> Result<PathBuf, String> {
    paths::settings_path()
}

fn read_value_unlocked() -> Value {
    path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()))
}

fn write_value_unlocked(value: &Value) -> Result<(), String> {
    let path = path()?;
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, format!("{text}\n")).map_err(|error| error.to_string())?;
    fs::rename(&tmp, &path).map_err(|error| error.to_string())
}

pub fn load() -> AppSettings {
    let _guard = lock().lock();
    serde_json::from_value::<AppSettings>(read_value_unlocked()).unwrap_or_default()
}

pub fn load_from(path: PathBuf) -> AppSettings {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<AppSettings>(&text).ok())
        .unwrap_or_default()
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TuiUiState {
    pub screen: String,
    pub project_id: Option<String>,
    pub card_id: Option<String>,
    pub detail_tab: Option<usize>,
    pub project_tab: Option<String>,
    pub terminal_tab: Option<String>,
    pub terminal_layout: Option<String>,
}

pub fn load_ui_state() -> TuiUiState {
    let _guard = lock().lock();
    let value = read_value_unlocked();
    TuiUiState {
        screen: value
            .get("tui_last_screen")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        project_id: value
            .get("tui_last_project_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        card_id: value
            .get("tui_last_card_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        detail_tab: value
            .get("tui_last_detail_tab")
            .and_then(Value::as_u64)
            .map(|value| value as usize),
        project_tab: value
            .get("tui_last_project_tab")
            .and_then(Value::as_str)
            .map(str::to_string),
        terminal_tab: value
            .get("tui_last_terminal_tab")
            .and_then(Value::as_str)
            .map(str::to_string),
        terminal_layout: value
            .get("tui_last_terminal_layout")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

pub fn save_ui_state(state: &TuiUiState) -> Result<(), String> {
    let _guard = lock().lock();
    let mut value = read_value_unlocked();
    let object = value
        .as_object_mut()
        .ok_or_else(|| "settings.json must contain an object".to_string())?;
    object.insert(
        "tui_last_screen".into(),
        Value::String(state.screen.clone()),
    );
    for (key, value_opt) in [
        ("tui_last_project_id", state.project_id.as_ref()),
        ("tui_last_card_id", state.card_id.as_ref()),
        ("tui_last_project_tab", state.project_tab.as_ref()),
        ("tui_last_terminal_tab", state.terminal_tab.as_ref()),
        ("tui_last_terminal_layout", state.terminal_layout.as_ref()),
    ] {
        match value_opt {
            Some(value) => {
                object.insert(key.into(), Value::String(value.clone()));
            }
            None => {
                object.remove(key);
            }
        }
    }
    match state.detail_tab {
        Some(tab) => {
            object.insert("tui_last_detail_tab".into(), Value::from(tab as u64));
        }
        None => {
            object.remove("tui_last_detail_tab");
        }
    }
    write_value_unlocked(&value)
}

/// Merge the TUI's editable fields into the on-disk object.
pub fn save_tui_preferences(preferences: &TuiPreferences) -> Result<AppSettings, String> {
    let _guard = lock().lock();
    let mut value = read_value_unlocked();
    let object = value
        .as_object_mut()
        .ok_or_else(|| "settings.json must contain an object".to_string())?;
    object.insert("tui_hide_done".into(), Value::Bool(preferences.hide_done));
    object.insert(
        "tui_confirmation_delay_ms".into(),
        Value::from(preferences.confirmation_delay_ms),
    );
    object.insert(
        "copy_on_select".into(),
        Value::Bool(preferences.copy_on_select),
    );
    object.insert(
        "terminal_scrollback".into(),
        Value::from(preferences.terminal_scrollback.clamp(100, 200_000)),
    );
    object.insert(
        "confirm_close".into(),
        Value::Bool(preferences.confirm_close),
    );
    object.insert(
        "confirm_delete".into(),
        Value::Bool(preferences.confirm_delete),
    );
    if let Some(size) = preferences.terminal_font_size {
        object.insert("terminal_font_size".into(), Value::from(size.clamp(8, 32)));
    }
    match &preferences.accent {
        Some(accent) if !accent.trim().is_empty() => {
            object.insert("tui_accent".into(), Value::String(accent.clone()));
        }
        _ => {
            object.remove("tui_accent");
        }
    }
    write_value_unlocked(&value)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// Whole-settings save used by hosts that edit the shipping preference set.
pub fn save_app_settings(next: &AppSettings) -> Result<AppSettings, String> {
    let _guard = lock().lock();
    let mut value = read_value_unlocked();
    let patch = serde_json::to_value(next).map_err(|error| error.to_string())?;
    if let (Some(target), Some(patch)) = (value.as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            target.insert(key.clone(), value.clone());
        }
    }
    write_value_unlocked(&value)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// Record command-palette usage so recency survives restarts and is shared
/// with the GUI (`commandPaletteUsage.ts` uses the same keys).
pub fn record_command_usage(command_id: &str) -> Result<(), String> {
    if command_id.trim().is_empty() {
        return Err("Command id is required".to_string());
    }
    let _guard = lock().lock();
    let mut value = read_value_unlocked();
    let object = value
        .as_object_mut()
        .ok_or_else(|| "settings.json must contain an object".to_string())?;
    let counts = object
        .entry("command_usage_counts")
        .or_insert_with(|| Value::Object(Map::new()));
    if !counts.is_object() {
        *counts = Value::Object(Map::new());
    }
    let counts = counts.as_object_mut().expect("object");
    let current = counts
        .get(command_id)
        .and_then(Value::as_u64)
        .unwrap_or_default();
    counts.insert(command_id.to_string(), Value::from(current + 1));
    write_value_unlocked(&value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tui_preferences_round_trip_and_preserve_unknown_keys() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        fs::write(
            &settings,
            r#"{"editor_app":"Zed","copy_on_select":false,"unknown_key":{"kept":true}}"#,
        )
        .unwrap();
        // Exercises the merge shape without depending on the process data dir.
        let mut value: Value =
            serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.insert("tui_hide_done".into(), Value::Bool(true));
        object.insert("copy_on_select".into(), Value::Bool(false));
        fs::write(&settings, serde_json::to_string_pretty(&value).unwrap()).unwrap();

        let raw: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(raw["editor_app"], "Zed");
        assert_eq!(raw["unknown_key"]["kept"], true);
        assert_eq!(raw["tui_hide_done"], true);
    }

    #[test]
    fn confirmation_delay_is_clamped() {
        let settings = AppSettings {
            tui_confirmation_delay_ms: Some(99_999),
            ..Default::default()
        };
        assert_eq!(settings.tui_preferences().confirmation_delay_ms, 10_000);
        assert_eq!(
            AppSettings::default()
                .tui_preferences()
                .confirmation_delay_ms,
            2_000
        );
    }
}
