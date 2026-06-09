use serde::{Deserialize, Serialize};
use std::fs;

use crate::fs_paths::app_data_file;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectStore {
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

fn store_path() -> Result<std::path::PathBuf, String> {
    app_data_file("projects.json")
}

#[tauri::command]
pub fn load_store() -> Result<ProjectStore, String> {
    let path = store_path()?;
    if !path.exists() {
        return Ok(ProjectStore::default());
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_store(store: ProjectStore) -> Result<(), String> {
    let path = store_path()?;
    let text = serde_json::to_string_pretty(&store).map_err(|e| e.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|e| e.to_string())
}
