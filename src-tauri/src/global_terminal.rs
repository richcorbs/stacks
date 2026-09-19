use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::kanban;

const PANE_PREFIX: &str = "global-terminal:";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalTerminalTab {
    id: String,
    split_layout: serde_json::Value,
    focused_pane_id: String,
    maximized_pane_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GlobalTerminalState {
    revision: i64,
    home_dir: String,
    tabs: Vec<GlobalTerminalTab>,
    selected_tab_id: String,
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS global_terminal_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            revision INTEGER NOT NULL,
            tabs TEXT NOT NULL,
            selected_tab_id TEXT NOT NULL,
            updated_at INTEGER NOT NULL
         );",
        )
        .map_err(db_error)
}

fn home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .ok_or_else(|| "Could not resolve the user home directory".to_string())
}

fn new_tab() -> GlobalTerminalTab {
    let tab_id = uuid::Uuid::new_v4().to_string();
    let pane_id = format!("{PANE_PREFIX}{tab_id}:pane:{}", uuid::Uuid::new_v4());
    GlobalTerminalTab {
        id: tab_id,
        split_layout: serde_json::json!({"kind":"leaf", "terminalId":pane_id}),
        focused_pane_id: pane_id,
        maximized_pane_id: None,
    }
}

fn collect_tab_panes(node: &serde_json::Value, prefix: &str, panes: &mut Vec<String>) -> bool {
    match node.get("kind").and_then(serde_json::Value::as_str) {
        Some("leaf") => {
            let Some(id) = node.get("terminalId").and_then(serde_json::Value::as_str) else {
                return false;
            };
            if !id.starts_with(prefix) || panes.iter().any(|pane| pane == id) {
                return false;
            }
            panes.push(id.to_string());
            true
        }
        Some("split") => {
            node.get("direction")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|direction| direction == "row" || direction == "column")
                && node
                    .get("first")
                    .is_some_and(|child| collect_tab_panes(child, prefix, panes))
                && node
                    .get("second")
                    .is_some_and(|child| collect_tab_panes(child, prefix, panes))
        }
        _ => false,
    }
}

fn normalize(
    mut tabs: Vec<GlobalTerminalTab>,
    selected: String,
) -> (Vec<GlobalTerminalTab>, String) {
    let mut tab_ids = HashSet::new();
    tabs.retain_mut(|tab| {
        if tab.id.is_empty() || !tab_ids.insert(tab.id.clone()) {
            return false;
        }
        let mut panes = Vec::new();
        if !collect_tab_panes(
            &tab.split_layout,
            &format!("{PANE_PREFIX}{}:pane:", tab.id),
            &mut panes,
        ) || !panes.contains(&tab.focused_pane_id)
        {
            return false;
        }
        if tab
            .maximized_pane_id
            .as_ref()
            .is_some_and(|id| !panes.contains(id))
        {
            tab.maximized_pane_id = None;
        }
        true
    });
    if tabs.is_empty() {
        tabs.push(new_tab());
    }
    let selected = if tabs.iter().any(|tab| tab.id == selected) {
        selected
    } else {
        tabs[0].id.clone()
    };
    (tabs, selected)
}

fn load(connection: &Connection) -> Result<Option<GlobalTerminalState>, String> {
    let row = connection
        .query_row(
            "SELECT revision,tabs,selected_tab_id FROM global_terminal_state WHERE singleton=1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(db_error)?;
    let Some((revision, tabs_json, selected)) = row else {
        return Ok(None);
    };
    let tabs = serde_json::from_str(&tabs_json).unwrap_or_default();
    let (tabs, selected_tab_id) = normalize(tabs, selected);
    Ok(Some(GlobalTerminalState {
        revision,
        home_dir: home_dir()?,
        tabs,
        selected_tab_id,
    }))
}

#[tauri::command]
pub fn global_terminal_load_or_create() -> Result<GlobalTerminalState, String> {
    kanban::with_connection(|connection| {
        if let Some(state) = load(connection)? {
            return Ok(state);
        }
        let tab = new_tab();
        let tabs = vec![tab.clone()];
        connection.execute(
            "INSERT INTO global_terminal_state (singleton,revision,tabs,selected_tab_id,updated_at) VALUES (1,1,?1,?2,?3)",
            params![serde_json::to_string(&tabs).map_err(|error| error.to_string())?, tab.id, unix_timestamp()],
        ).map_err(db_error)?;
        load(connection)?.ok_or_else(|| "Could not initialize the top-level terminal".to_string())
    })
}

#[tauri::command]
pub fn global_terminal_save(
    tabs: Vec<GlobalTerminalTab>,
    selected_tab_id: String,
    expected_revision: i64,
) -> Result<GlobalTerminalState, String> {
    kanban::with_connection(|connection| {
        let (tabs, selected_tab_id) = normalize(tabs, selected_tab_id);
        let changed = connection.execute(
            "UPDATE global_terminal_state SET revision=revision+1,tabs=?1,selected_tab_id=?2,updated_at=?3 WHERE singleton=1 AND revision=?4",
            params![serde_json::to_string(&tabs).map_err(|error| error.to_string())?, selected_tab_id, unix_timestamp(), expected_revision],
        ).map_err(db_error)?;
        if changed == 0 {
            return Err("Top-level terminal layout changed; reload before saving".to_string());
        }
        load(connection)?.ok_or_else(|| "Top-level terminal state was not found".to_string())
    })
}

fn unix_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn db_error(error: rusqlite::Error) -> String {
    format!("Top-level terminal database error: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalization_protects_the_final_tab_and_selection() {
        let (tabs, selected) = normalize(vec![], "missing".into());
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].id, selected);
        assert!(tabs[0].focused_pane_id.starts_with(PANE_PREFIX));
    }
    #[test]
    fn stale_revisions_are_rejected() {
        let connection = Connection::open_in_memory().unwrap();
        crate::kanban::migrate(&connection).unwrap();
        crate::store::migrate_store_schema(&connection).unwrap();
        migrate(&connection).unwrap();
        let tab = new_tab();
        connection
            .execute(
                "INSERT INTO global_terminal_state VALUES (1,1,?1,?2,0)",
                params![serde_json::to_string(&vec![tab.clone()]).unwrap(), tab.id],
            )
            .unwrap();
        assert_eq!(connection.execute("UPDATE global_terminal_state SET revision=revision+1 WHERE singleton=1 AND revision=1", []).unwrap(), 1);
        assert_eq!(connection.execute("UPDATE global_terminal_state SET revision=revision+1 WHERE singleton=1 AND revision=1", []).unwrap(), 0);
    }
}
