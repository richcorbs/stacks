use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

use crate::pi_rpc::PiRpcRegistry;
use crate::{kanban, pi_rpc, pty, pty_cwd::PtyRegistry};

#[derive(Debug, Clone, Serialize)]
pub struct ProjectDirectWork {
    project_id: String,
    revision: i64,
    split_layout: serde_json::Value,
    focused_pane_id: Option<String>,
    pane_ids: Vec<String>,
    created_at: i64,
    updated_at: i64,
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), String> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_direct_work (
            project_id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1,
            split_layout TEXT NOT NULL,
            focused_pane_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS project_direct_panes (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS project_direct_panes_project_idx ON project_direct_panes(project_id, sort_order);"
    ).map_err(db_error)
}

fn project_exists(connection: &Connection, project_id: &str) -> Result<bool, String> {
    Ok(connection
        .query_row("SELECT 1 FROM projects WHERE id=?1", [project_id], |_| {
            Ok(())
        })
        .optional()
        .map_err(db_error)?
        .is_some())
}

fn load(connection: &Connection, project_id: &str) -> Result<Option<ProjectDirectWork>, String> {
    let row = connection.query_row(
        "SELECT revision, split_layout, focused_pane_id, created_at, updated_at FROM project_direct_work WHERE project_id=?1",
        [project_id],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, i64>(3)?, row.get::<_, i64>(4)?)),
    ).optional().map_err(db_error)?;
    let Some((revision, layout, focused_pane_id, created_at, updated_at)) = row else {
        return Ok(None);
    };
    let mut statement = connection
        .prepare("SELECT id FROM project_direct_panes WHERE project_id=?1 ORDER BY sort_order")
        .map_err(db_error)?;
    let pane_ids = statement
        .query_map([project_id], |row| row.get(0))
        .map_err(db_error)?
        .collect::<Result<Vec<String>, _>>()
        .map_err(db_error)?;
    Ok(Some(ProjectDirectWork {
        project_id: project_id.to_string(),
        revision,
        split_layout: serde_json::from_str(&layout).unwrap_or_else(|_| initial_layout(project_id)),
        focused_pane_id,
        pane_ids,
        created_at,
        updated_at,
    }))
}

#[tauri::command]
pub fn project_direct_load_or_create(project_id: String) -> Result<ProjectDirectWork, String> {
    kanban::with_connection(|connection| {
        migrate(connection)?;
        crate::store::migrate_store_schema(connection)?;
        if !project_exists(connection, &project_id)? {
            return Err("The Direct project work project was not found".into());
        }
        if let Some(state) = load(connection, &project_id)? {
            return Ok(state);
        }
        let shell = shell_id(&project_id);
        let now = unix_timestamp();
        connection.execute(
            "INSERT INTO project_direct_work (project_id, revision, split_layout, focused_pane_id, created_at, updated_at) VALUES (?1, 1, ?2, ?3, ?4, ?4)",
            params![project_id, initial_layout(&project_id).to_string(), shell, now],
        ).map_err(db_error)?;
        connection
            .execute(
                "INSERT INTO project_direct_panes (id, project_id, sort_order) VALUES (?1, ?2, 0)",
                params![shell, project_id],
            )
            .map_err(db_error)?;
        load(connection, &project_id)?
            .ok_or_else(|| "Could not initialize Direct project work".into())
    })
}

#[tauri::command]
pub fn project_direct_save_layout(
    project_id: String,
    split_layout: serde_json::Value,
    focused_pane_id: Option<String>,
    pane_ids: Vec<String>,
    expected_revision: i64,
) -> Result<ProjectDirectWork, String> {
    kanban::with_connection(|connection| {
        migrate(connection)?;
        let transaction = connection.transaction().map_err(db_error)?;
        let changed = transaction.execute(
            "UPDATE project_direct_work SET revision=revision+1, split_layout=?1, focused_pane_id=?2, updated_at=?3 WHERE project_id=?4 AND revision=?5",
            params![split_layout.to_string(), focused_pane_id, unix_timestamp(), project_id, expected_revision],
        ).map_err(db_error)?;
        if changed == 0 {
            return Err("Direct project work layout changed; reopen before saving".into());
        }
        transaction
            .execute(
                "DELETE FROM project_direct_panes WHERE project_id=?1",
                [&project_id],
            )
            .map_err(db_error)?;
        for (index, pane_id) in pane_ids.iter().enumerate() {
            if !pane_id.starts_with(&format!("project-direct:{project_id}:terminal:")) {
                return Err("A Direct project work pane has an invalid owner".into());
            }
            transaction.execute("INSERT INTO project_direct_panes (id, project_id, sort_order) VALUES (?1, ?2, ?3)", params![pane_id, project_id, index as i64]).map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)?;
        load(connection, &project_id)?.ok_or_else(|| "Direct project work was not found".into())
    })
}

#[tauri::command]
pub fn project_direct_delete(
    project_id: String,
    pi_registry: State<'_, Mutex<PiRpcRegistry>>,
    pty_registry: State<'_, Mutex<PtyRegistry>>,
) -> Result<Vec<String>, String> {
    let pane_ids = kanban::with_connection(|connection| {
        migrate(connection)?;
        let mut ids = load(connection, &project_id)?
            .map(|state| state.pane_ids)
            .unwrap_or_default();
        ids.push(format!("project-direct:{project_id}:terminal:server"));
        ids.push(format!("project-direct:{project_id}:terminal:console"));
        Ok(ids)
    })?;
    pi_rpc::delete_pi_session_impl(
        pi_registry.inner(),
        &format!("project-direct:{project_id}:agent"),
    )?;
    let live_pane_ids = pty::kill_ptys_with_prefix(
        pty_registry.inner(),
        &format!("project-direct:{project_id}:terminal:"),
    )?;
    kanban::with_connection(|connection| delete_persistence(connection, &project_id))?;
    Ok(pane_ids.into_iter().chain(live_pane_ids).collect())
}

fn delete_persistence(connection: &Connection, project_id: &str) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM project_direct_panes WHERE project_id=?1",
            [project_id],
        )
        .map_err(db_error)?;
    connection
        .execute(
            "DELETE FROM project_direct_work WHERE project_id=?1",
            [project_id],
        )
        .map_err(db_error)?;
    Ok(())
}

pub(crate) fn project_direct_owner(pane_id: &str) -> Option<&str> {
    pane_id
        .strip_prefix("project-direct:")?
        .strip_suffix(":agent")
}

fn shell_id(project_id: &str) -> String {
    format!("project-direct:{project_id}:terminal:shell")
}
fn initial_layout(project_id: &str) -> serde_json::Value {
    serde_json::json!({"kind":"leaf", "terminalId":shell_id(project_id)})
}
fn unix_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn db_error(error: rusqlite::Error) -> String {
    format!("Direct project work database error: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        kanban::migrate(&connection).unwrap();
        crate::store::migrate_store_schema(&connection).unwrap();
        connection.execute("INSERT INTO projects (id,name,path,sort_order) VALUES ('one','One','/one',0),('two','Two','/two',1)", []).unwrap();
        migrate(&connection).unwrap();
        connection
    }

    #[test]
    fn state_is_stable_revisioned_and_isolated_from_card_state() {
        let mut connection = setup();
        let one = {
            let shell = shell_id("one");
            let now = unix_timestamp();
            connection
                .execute(
                    "INSERT INTO project_direct_work VALUES ('one',1,?1,?2,?3,?3)",
                    params![initial_layout("one").to_string(), shell, now],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO project_direct_panes VALUES (?1,'one',0)",
                    [shell],
                )
                .unwrap();
            load(&connection, "one").unwrap().unwrap()
        };
        assert_eq!(one.revision, 1);
        assert_eq!(one.pane_ids, vec![shell_id("one")]);
        assert!(load(&connection, "two").unwrap().is_none());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM kanban_cards", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let transaction = connection.transaction().unwrap();
        let changed = transaction.execute("UPDATE project_direct_work SET revision=revision+1 WHERE project_id='one' AND revision=1", []).unwrap();
        assert_eq!(changed, 1);
        assert_eq!(transaction.execute("UPDATE project_direct_work SET revision=revision+1 WHERE project_id='one' AND revision=1", []).unwrap(), 0);
    }

    #[test]
    fn deleting_direct_state_does_not_touch_cards_or_other_projects() {
        let connection = setup();
        let now = unix_timestamp();
        for project_id in ["one", "two"] {
            connection
                .execute(
                    "INSERT INTO project_direct_work VALUES (?1,1,?2,?3,?4,?4)",
                    params![
                        project_id,
                        initial_layout(project_id).to_string(),
                        shell_id(project_id),
                        now
                    ],
                )
                .unwrap();
        }
        connection.execute(
            "INSERT INTO kanban_cards (id, external_provider, external_id, title, project_id, created_at, updated_at) VALUES ('local:one','local:one','1','Card','one',1,1)",
            [],
        ).unwrap();

        delete_persistence(&connection, "one").unwrap();

        assert!(load(&connection, "one").unwrap().is_none());
        assert!(load(&connection, "two").unwrap().is_some());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM kanban_cards", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn owner_parser_only_accepts_direct_agent_ids() {
        assert_eq!(
            project_direct_owner("project-direct:one:agent"),
            Some("one")
        );
        assert_eq!(
            project_direct_owner("project-direct:one:terminal:shell"),
            None
        );
        assert_eq!(project_direct_owner("kanban-card:one:work"), None);
    }
}
