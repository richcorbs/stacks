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
    #[serde(default, alias = "terminals")]
    workspaces: Vec<WorkspaceEntry>,
    #[serde(default)]
    collapsed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceEntry {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_legacy_project_terminals_as_workspaces() {
        let text = r#"{
            "projects": [{
                "id": "p1",
                "name": "Project",
                "path": "/repo",
                "terminals": [{ "id": "w1", "name": "Dev", "command": "npm run dev", "cwd": "/repo" }]
            }]
        }"#;

        let store: ProjectStore = serde_json::from_str(text).expect("legacy store should deserialize");
        assert_eq!(store.projects.len(), 1);
        assert_eq!(store.projects[0].workspaces.len(), 1);
        assert_eq!(store.projects[0].workspaces[0].id, "w1");
        assert_eq!(store.projects[0].workspaces[0].name, "Dev");
    }

    #[test]
    fn saves_projects_with_workspaces_key() {
        let store = ProjectStore {
            projects: vec![Project {
                id: "p1".into(),
                name: "Project".into(),
                path: "/repo".into(),
                workspaces: vec![WorkspaceEntry {
                    id: "w1".into(),
                    name: "Dev".into(),
                    command: None,
                    cwd: Some("/repo".into()),
                    splits: None,
                }],
                collapsed: false,
            }],
        };

        let value = serde_json::to_value(store).expect("store should serialize");
        assert!(value["projects"][0].get("workspaces").is_some());
        assert!(value["projects"][0].get("terminals").is_none());
    }
}
