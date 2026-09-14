use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;

use crate::{fs_paths::app_data_file, kanban};

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
    notes: String,
    #[serde(default, alias = "terminals")]
    workspaces: Vec<WorkspaceEntry>,
    #[serde(default)]
    collapsed: bool,
    #[serde(default)]
    kanban_source: Option<String>,
    #[serde(default)]
    start_work_command: Option<String>,
    #[serde(default)]
    server_command: Option<String>,
    #[serde(default)]
    console_command: Option<String>,
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

fn legacy_store_path() -> Result<std::path::PathBuf, String> {
    app_data_file("projects.json")
}

pub(crate) fn migrate_store_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            notes TEXT NOT NULL DEFAULT '',
            collapsed INTEGER NOT NULL DEFAULT 0,
            kanban_source TEXT,
            start_work_command TEXT,
            server_command TEXT,
            console_command TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS legacy_workspaces (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            command TEXT,
            cwd TEXT,
            splits TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0
         );
         INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, unixepoch());",
        )
        .map_err(db_error)
}

#[tauri::command]
pub fn load_store() -> Result<ProjectStore, String> {
    kanban::with_connection(|connection| {
        migrate_store_schema(connection)?;
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .map_err(db_error)?;
        if count == 0 {
            migrate_legacy_json(connection)?;
        }
        migrate_legacy_card_environments(connection)?;
        read_store(connection)
    })
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PiProjectScope {
    pub id: String,
    pub name: String,
    pub kanban_source: String,
}

pub(crate) fn pi_project_scope(project_id: &str) -> Result<PiProjectScope, String> {
    kanban::with_connection(|connection| pi_project_scope_from_connection(connection, project_id))
}

fn pi_project_scope_from_connection(
    connection: &Connection,
    project_id: &str,
) -> Result<PiProjectScope, String> {
    migrate_store_schema(connection)?;
    connection
        .query_row(
            "SELECT id, name, COALESCE(kanban_source, 'local') FROM projects WHERE id = ?1",
            [project_id],
            |row| {
                Ok(PiProjectScope {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    kanban_source: row.get(2)?,
                })
            },
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                "The Pi session's owning Stacks project was not found".to_string()
            }
            other => db_error(other),
        })
}

#[tauri::command]
pub fn save_store(store: ProjectStore) -> Result<(), String> {
    kanban::with_connection(|connection| {
        migrate_store_schema(connection)?;
        write_store(connection, &store)
    })?;
    write_legacy_json_mirror(&store)
}

fn write_legacy_json_mirror(store: &ProjectStore) -> Result<(), String> {
    let path = legacy_store_path()?;
    let text = serde_json::to_string_pretty(store).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, text).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn migrate_legacy_json(connection: &mut Connection) -> Result<(), String> {
    let path = legacy_store_path()?;
    if !path.exists() {
        return Ok(());
    }
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut store: ProjectStore = serde_json::from_str(&text)
        .map_err(|error| format!("Could not migrate projects.json: {error}"))?;
    // Preserve the one legacy implicit mapping at the migration boundary so domain/UI code
    // can rely exclusively on explicit provider metadata afterward.
    for project in &mut store.projects {
        if project.kanban_source.is_none() && project.name.trim().eq_ignore_ascii_case("arcasa") {
            project.kanban_source = Some("superthread".to_string());
        }
    }
    write_store(connection, &store)?;
    // Keep the source as a recovery snapshot. SQLite is authoritative after this marker exists.
    let migrated_path = path.with_extension("json.migrated");
    if !migrated_path.exists() {
        fs::copy(path, migrated_path)
            .map_err(|error| format!("Could not preserve projects migration snapshot: {error}"))?;
    }
    Ok(())
}

fn migrate_legacy_card_environments(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection.transaction().map_err(db_error)?;
    let already_applied = transaction
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = 3",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(db_error)?
        > 0;
    if already_applied {
        transaction.commit().map_err(db_error)?;
        return Ok(());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    transaction.execute(
        "INSERT INTO card_environments (id, card_id, project_id, worktree_path, branch, lifecycle_state, revision, created_at, updated_at)
         SELECT 'environment:legacy:' || c.id, c.id, c.project_id, COALESCE(w.cwd, p.path), '', 'ready', 1, ?1, ?1
         FROM kanban_cards c
         JOIN legacy_workspaces w ON w.id = c.workspace_id
         JOIN projects p ON p.id = c.project_id
         WHERE c.workspace_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM card_environments e WHERE e.card_id = c.id)",
        [now],
    ).map_err(db_error)?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO card_panes (id, environment_id, role, kind, sort_order)
         SELECT 'kanban-card:' || e.card_id || ':terminal:shell', e.id, 'shell', 'terminal', 0
         FROM card_environments e WHERE e.id LIKE 'environment:legacy:%'",
            [],
        )
        .map_err(db_error)?;
    for (index, thread) in ["planning", "work"].into_iter().enumerate() {
        transaction
            .execute(
                "INSERT OR IGNORE INTO card_panes (id, environment_id, role, kind, sort_order)
             SELECT 'kanban-card:' || e.card_id || ':' || ?1, e.id, ?1, 'pi', ?2
             FROM card_environments e WHERE e.id LIKE 'environment:legacy:%'",
                params![thread, index as i64 + 1],
            )
            .map_err(db_error)?;
    }
    transaction.execute(
        "INSERT OR IGNORE INTO card_layouts (environment_id, split_layout, focused_pane_id, updated_at)
         SELECT e.id,
           json_object('kind', 'leaf', 'terminalId', 'kanban-card:' || e.card_id || ':terminal:shell'),
           'kanban-card:' || e.card_id || ':terminal:shell', ?1
         FROM card_environments e WHERE e.id LIKE 'environment:legacy:%'",
        [now],
    ).map_err(db_error)?;
    transaction.execute(
        "INSERT OR IGNORE INTO card_service_definitions (id, environment_id, name, command, sort_order)
         SELECT 'service:legacy:server:' || e.card_id, e.id, 'server', p.server_command, 0
         FROM card_environments e JOIN projects p ON p.id = e.project_id
         WHERE p.server_command IS NOT NULL AND trim(p.server_command) != ''",
        [],
    ).map_err(db_error)?;
    transaction.execute(
        "INSERT OR IGNORE INTO card_service_definitions (id, environment_id, name, command, sort_order)
         SELECT 'service:legacy:console:' || e.card_id, e.id, 'console', p.console_command, 1
         FROM card_environments e JOIN projects p ON p.id = e.project_id
         WHERE p.console_command IS NOT NULL AND trim(p.console_command) != ''",
        [],
    ).map_err(db_error)?;
    transaction
        .execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (3, ?1)",
            [now],
        )
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)
}

fn read_store(connection: &Connection) -> Result<ProjectStore, String> {
    let mut project_statement = connection.prepare(
        "SELECT id, name, path, notes, collapsed, kanban_source, start_work_command, server_command, console_command
         FROM projects ORDER BY sort_order, rowid"
    ).map_err(db_error)?;
    let projects = project_statement
        .query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                notes: row.get(3)?,
                collapsed: row.get::<_, i64>(4)? != 0,
                kanban_source: row.get(5)?,
                start_work_command: row.get(6)?,
                server_command: row.get(7)?,
                console_command: row.get(8)?,
                workspaces: Vec::new(),
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;

    let projects = projects.into_iter().map(|mut project| {
        let mut workspace_statement = connection.prepare(
            "SELECT id, name, command, cwd, splits FROM legacy_workspaces WHERE project_id = ?1 ORDER BY sort_order, rowid"
        ).map_err(db_error)?;
        project.workspaces = workspace_statement.query_map([&project.id], |row| {
            let splits: Option<String> = row.get(4)?;
            Ok(WorkspaceEntry {
                id: row.get(0)?, name: row.get(1)?, command: row.get(2)?, cwd: row.get(3)?,
                splits: splits.and_then(|value| serde_json::from_str(&value).ok()),
            })
        }).map_err(db_error)?.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
        Ok(project)
    }).collect::<Result<Vec<_>, String>>()?;
    Ok(ProjectStore { projects })
}

fn write_store(connection: &mut Connection, store: &ProjectStore) -> Result<(), String> {
    let transaction = connection.transaction().map_err(db_error)?;
    transaction
        .execute("DELETE FROM legacy_workspaces", [])
        .map_err(db_error)?;
    transaction
        .execute("DELETE FROM projects", [])
        .map_err(db_error)?;
    for (project_index, project) in store.projects.iter().enumerate() {
        transaction.execute(
            "INSERT INTO projects (id, name, path, notes, collapsed, kanban_source, start_work_command, server_command, console_command, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![project.id, project.name, project.path, project.notes, project.collapsed as i64,
                project.kanban_source, project.start_work_command, project.server_command, project.console_command, project_index as i64],
        ).map_err(db_error)?;
        for (workspace_index, workspace) in project.workspaces.iter().enumerate() {
            transaction.execute(
                "INSERT INTO legacy_workspaces (id, project_id, name, command, cwd, splits, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![workspace.id, project.id, workspace.name, workspace.command, workspace.cwd,
                    workspace.splits.as_ref().map(serde_json::Value::to_string), workspace_index as i64],
            ).map_err(db_error)?;
        }
    }
    transaction.commit().map_err(db_error)
}

fn db_error(error: rusqlite::Error) -> String {
    format!("Stacks database error: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_store() -> ProjectStore {
        ProjectStore {
            projects: vec![Project {
                id: "p1".into(),
                name: "Project".into(),
                path: "/repo".into(),
                notes: "Scratch pad".into(),
                workspaces: vec![WorkspaceEntry {
                    id: "w1".into(),
                    name: "Dev".into(),
                    command: None,
                    cwd: Some("/repo".into()),
                    splits: None,
                }],
                collapsed: false,
                kanban_source: Some("local".into()),
                start_work_command: None,
                server_command: Some("npm run dev".into()),
                console_command: None,
            }],
        }
    }

    #[test]
    fn loads_legacy_project_terminals_as_workspaces() {
        let text = r#"{"projects":[{"id":"p1","name":"Project","path":"/repo","terminals":[{"id":"w1","name":"Dev","command":"npm run dev","cwd":"/repo"}]}]}"#;
        let store: ProjectStore = serde_json::from_str(text).unwrap();
        assert_eq!(store.projects[0].workspaces[0].id, "w1");
    }

    #[test]
    fn migrates_card_environments_without_changing_workflow_status() {
        let mut connection = Connection::open_in_memory().unwrap();
        kanban::migrate(&connection).unwrap();
        migrate_store_schema(&connection).unwrap();
        write_store(&mut connection, &sample_store()).unwrap();
        connection.execute(
            "INSERT INTO kanban_cards (id, external_provider, external_id, title, status, project_id, workspace_id, created_at, updated_at)
             VALUES ('local:test', 'local:p1', '1', 'Test', 'approved', 'p1', 'w1', 1, 1)", [],
        ).unwrap();

        migrate_legacy_card_environments(&mut connection).unwrap();

        let status: String = connection
            .query_row(
                "SELECT status FROM kanban_cards WHERE id = 'local:test'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let path: String = connection
            .query_row(
                "SELECT worktree_path FROM card_environments WHERE card_id = 'local:test'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let service: String = connection
            .query_row("SELECT command FROM card_service_definitions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(status, "approved");
        assert_eq!(path, "/repo");
        assert_eq!(service, "npm run dev");
    }

    #[test]
    fn resolves_pi_scope_only_from_persisted_project_metadata() {
        let mut connection = Connection::open_in_memory().unwrap();
        kanban::migrate(&connection).unwrap();
        migrate_store_schema(&connection).unwrap();
        let mut store = sample_store();
        store.projects.push(Project {
            id: "remote".into(),
            name: "Remote".into(),
            path: "/remote".into(),
            notes: String::new(),
            workspaces: Vec::new(),
            collapsed: false,
            kanban_source: Some("superthread".into()),
            start_work_command: None,
            server_command: None,
            console_command: None,
        });
        write_store(&mut connection, &store).unwrap();

        assert_eq!(
            pi_project_scope_from_connection(&connection, "p1").unwrap(),
            PiProjectScope {
                id: "p1".into(),
                name: "Project".into(),
                kanban_source: "local".into()
            }
        );
        assert_eq!(
            pi_project_scope_from_connection(&connection, "remote")
                .unwrap()
                .kanban_source,
            "superthread"
        );
        assert!(pi_project_scope_from_connection(&connection, "model-selected-missing").is_err());
    }

    #[test]
    fn ordinary_store_saves_preserve_project_direct_work_state() {
        let mut connection = Connection::open_in_memory().unwrap();
        kanban::migrate(&connection).unwrap();
        migrate_store_schema(&connection).unwrap();
        write_store(&mut connection, &sample_store()).unwrap();
        crate::project_direct::migrate(&connection).unwrap();
        connection.execute(
            "INSERT INTO project_direct_work (project_id, revision, split_layout, focused_pane_id, created_at, updated_at) VALUES ('p1', 3, '{\"kind\":\"leaf\",\"terminalId\":\"project-direct:p1:terminal:shell\"}', 'project-direct:p1:terminal:shell', 1, 2)",
            [],
        ).unwrap();

        let mut updated = sample_store();
        updated.projects[0].name = "Renamed".into();
        write_store(&mut connection, &updated).unwrap();

        assert_eq!(
            connection
                .query_row(
                    "SELECT revision FROM project_direct_work WHERE project_id='p1'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            3
        );
    }

    #[test]
    fn round_trips_projects_through_sqlite() {
        let mut connection = Connection::open_in_memory().unwrap();
        kanban::migrate(&connection).unwrap();
        migrate_store_schema(&connection).unwrap();
        write_store(&mut connection, &sample_store()).unwrap();
        assert_eq!(
            read_store(&connection).unwrap().projects[0]
                .server_command
                .as_deref(),
            Some("npm run dev")
        );
        assert_eq!(
            read_store(&connection).unwrap().projects[0].workspaces[0].name,
            "Dev"
        );
    }
}
