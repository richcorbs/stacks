use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;

use crate::{
    fs_paths::app_data_file,
    kanban,
    superthread::{SuperthreadMappingDraft, SuperthreadService},
};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectStore {
    projects: Vec<Project>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Project {
    id: String,
    name: String,
    path: String,
    #[serde(default, skip_serializing)]
    notes: String,
    #[serde(default, alias = "terminals", skip_serializing)]
    workspaces: Vec<WorkspaceEntry>,
    #[serde(default, skip_serializing)]
    collapsed: bool,
    #[serde(default)]
    kanban_source: Option<String>,
    #[serde(default)]
    start_work_command: Option<String>,
    #[serde(default)]
    superthread_spaces: Option<String>,
    #[serde(default)]
    superthread_workspace_slug: Option<String>,
    #[serde(default)]
    superthread_api_token_env_var: Option<String>,
    #[serde(default)]
    superthread_board_id: Option<String>,
    #[serde(default)]
    superthread_board_name: Option<String>,
    #[serde(default)]
    superthread_incoming_columns: Vec<SuperthreadColumnMapping>,
    #[serde(default)]
    superthread_default_incoming_column_id: Option<String>,
    #[serde(default)]
    superthread_in_progress_column_id: Option<String>,
    #[serde(default)]
    superthread_in_progress_column_name: Option<String>,
    #[serde(default)]
    superthread_done_column_id: Option<String>,
    #[serde(default)]
    superthread_done_column_name: Option<String>,
    #[serde(default)]
    superthread_mapping_revision: i64,
    #[serde(default)]
    server_command: Option<String>,
    #[serde(default)]
    console_command: Option<String>,
    #[serde(default = "default_delivery_workflow")]
    delivery_workflow: String,
    #[serde(default = "default_target_branch")]
    target_branch: String,
    #[serde(default)]
    supports_feature_environments: bool,
    #[serde(default = "default_merge_strategy")]
    github_merge_strategy: String,
    #[serde(default = "default_true")]
    require_passing_ci: bool,
    #[serde(default)]
    require_approval: bool,
    #[serde(default)]
    releases_enabled: bool,
    #[serde(default = "default_release_config_path")]
    release_config_path: String,
    #[serde(default)]
    config_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectConfigurationInput {
    id: String,
    name: String,
    path: String,
    #[serde(default)]
    kanban_source: Option<String>,
    #[serde(default)]
    start_work_command: Option<String>,
    #[serde(default)]
    superthread_spaces: Option<String>,
    #[serde(default)]
    superthread_workspace_slug: Option<String>,
    #[serde(default)]
    superthread_api_token_env_var: Option<String>,
    #[serde(default)]
    superthread_board_id: Option<String>,
    #[serde(default)]
    superthread_board_name: Option<String>,
    #[serde(default)]
    superthread_incoming_columns: Vec<SuperthreadColumnMapping>,
    #[serde(default)]
    superthread_default_incoming_column_id: Option<String>,
    #[serde(default)]
    superthread_in_progress_column_id: Option<String>,
    #[serde(default)]
    superthread_in_progress_column_name: Option<String>,
    #[serde(default)]
    superthread_done_column_id: Option<String>,
    #[serde(default)]
    superthread_done_column_name: Option<String>,
    #[serde(default)]
    server_command: Option<String>,
    #[serde(default)]
    console_command: Option<String>,
    #[serde(default = "default_delivery_workflow")]
    delivery_workflow: String,
    #[serde(default = "default_target_branch")]
    target_branch: String,
    #[serde(default)]
    supports_feature_environments: bool,
    #[serde(default = "default_merge_strategy")]
    github_merge_strategy: String,
    #[serde(default = "default_true")]
    require_passing_ci: bool,
    #[serde(default)]
    require_approval: bool,
    #[serde(default)]
    releases_enabled: bool,
    #[serde(default = "default_release_config_path")]
    release_config_path: String,
    #[serde(default)]
    expected_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct SuperthreadColumnMapping {
    id: String,
    name: String,
}

fn default_release_config_path() -> String {
    ".stacks/release.json".to_string()
}

fn default_delivery_workflow() -> String {
    "local_merge".to_string()
}
fn default_target_branch() -> String {
    "main".to_string()
}
fn default_merge_strategy() -> String {
    "merge".to_string()
}
fn default_true() -> bool {
    true
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
            notes_revision INTEGER NOT NULL DEFAULT 0,
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
        .map_err(db_error)?;
    let columns = connection
        .prepare("PRAGMA table_info(projects)")
        .map_err(db_error)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    for (name, sql) in [
        ("notes_revision", "ALTER TABLE projects ADD COLUMN notes_revision INTEGER NOT NULL DEFAULT 0"),
        ("delivery_workflow", "ALTER TABLE projects ADD COLUMN delivery_workflow TEXT NOT NULL DEFAULT 'local_merge'"),
        ("target_branch", "ALTER TABLE projects ADD COLUMN target_branch TEXT NOT NULL DEFAULT 'main'"),
        ("supports_feature_environments", "ALTER TABLE projects ADD COLUMN supports_feature_environments INTEGER NOT NULL DEFAULT 0"),
        ("github_merge_strategy", "ALTER TABLE projects ADD COLUMN github_merge_strategy TEXT NOT NULL DEFAULT 'merge'"),
        ("require_passing_ci", "ALTER TABLE projects ADD COLUMN require_passing_ci INTEGER NOT NULL DEFAULT 1"),
        ("require_approval", "ALTER TABLE projects ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 0"),
        ("superthread_spaces", "ALTER TABLE projects ADD COLUMN superthread_spaces TEXT"),
        ("superthread_workspace_slug", "ALTER TABLE projects ADD COLUMN superthread_workspace_slug TEXT"),
        ("superthread_api_token_env_var", "ALTER TABLE projects ADD COLUMN superthread_api_token_env_var TEXT NOT NULL DEFAULT 'ST_TOKEN'"),
        ("superthread_board_id", "ALTER TABLE projects ADD COLUMN superthread_board_id TEXT"),
        ("superthread_board_name", "ALTER TABLE projects ADD COLUMN superthread_board_name TEXT"),
        ("superthread_incoming_columns", "ALTER TABLE projects ADD COLUMN superthread_incoming_columns TEXT NOT NULL DEFAULT '[]'"),
        ("superthread_default_incoming_column_id", "ALTER TABLE projects ADD COLUMN superthread_default_incoming_column_id TEXT"),
        ("superthread_in_progress_column_id", "ALTER TABLE projects ADD COLUMN superthread_in_progress_column_id TEXT"),
        ("superthread_in_progress_column_name", "ALTER TABLE projects ADD COLUMN superthread_in_progress_column_name TEXT"),
        ("superthread_done_column_id", "ALTER TABLE projects ADD COLUMN superthread_done_column_id TEXT"),
        ("superthread_done_column_name", "ALTER TABLE projects ADD COLUMN superthread_done_column_name TEXT"),
        ("superthread_mapping_revision", "ALTER TABLE projects ADD COLUMN superthread_mapping_revision INTEGER NOT NULL DEFAULT 0"),
        ("releases_enabled", "ALTER TABLE projects ADD COLUMN releases_enabled INTEGER NOT NULL DEFAULT 0"),
        ("release_config_path", "ALTER TABLE projects ADD COLUMN release_config_path TEXT NOT NULL DEFAULT '.stacks/release.json'"),
        ("config_revision", "ALTER TABLE projects ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !columns.iter().any(|column| column == name) { connection.execute(sql, []).map_err(db_error)?; }
    }
    Ok(())
}

#[tauri::command]
pub fn load_store() -> Result<ProjectStore, String> {
    kanban::with_connection(|connection| read_store(connection))
}

pub(crate) fn migrate_legacy_data(
    connection: &mut Connection,
    import_legacy_json: bool,
) -> Result<(), String> {
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .map_err(db_error)?;
    if import_legacy_json && count == 0 {
        migrate_legacy_json(connection)?;
    }
    migrate_legacy_card_environments(connection)
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

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProjectNotes {
    notes: String,
    revision: i64,
}

#[tauri::command]
pub fn load_project_notes(project_id: String) -> Result<ProjectNotes, String> {
    kanban::with_connection(|connection| {
        load_project_notes_from_connection(connection, &project_id)
    })
}

fn load_project_notes_from_connection(
    connection: &Connection,
    project_id: &str,
) -> Result<ProjectNotes, String> {
    connection
        .query_row(
            "SELECT notes, notes_revision FROM projects WHERE id=?1",
            [project_id],
            |row| {
                Ok(ProjectNotes {
                    notes: row.get(0)?,
                    revision: row.get(1)?,
                })
            },
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                "Project notes could not be loaded because the project was not found".to_string()
            }
            other => db_error(other),
        })
}

#[tauri::command]
pub fn save_project_notes(
    project_id: String,
    notes: String,
    expected_revision: i64,
) -> Result<ProjectNotes, String> {
    kanban::with_connection(|connection| {
        save_project_notes_to_connection(connection, &project_id, &notes, expected_revision)
    })
}

fn save_project_notes_to_connection(
    connection: &Connection,
    project_id: &str,
    notes: &str,
    expected_revision: i64,
) -> Result<ProjectNotes, String> {
    let changed = connection.execute(
        "UPDATE projects SET notes=?1, notes_revision=notes_revision+1 WHERE id=?2 AND notes_revision=?3",
        params![notes, project_id, expected_revision],
    ).map_err(db_error)?;
    if changed == 1 {
        return load_project_notes_from_connection(connection, project_id);
    }
    let exists = connection
        .query_row("SELECT 1 FROM projects WHERE id=?1", [project_id], |_| {
            Ok(())
        })
        .optional()
        .map_err(db_error)?
        .is_some();
    if exists {
        Err(
            "Project notes changed since they were loaded; retry after reviewing the current draft"
                .to_string(),
        )
    } else {
        Err("Project notes could not be saved because the project was not found".to_string())
    }
}

#[tauri::command]
pub fn save_store(store: ProjectStore) -> Result<(), String> {
    kanban::with_connection(|connection| write_store(connection, &store))?;
    write_legacy_json_mirror(&store)
}

fn validate_project_input(input: &ProjectConfigurationInput) -> Result<(), String> {
    if input.name.trim().is_empty() || input.path.trim().is_empty() {
        return Err("Name and directory are required".into());
    }
    let branch = normalize_target_branch(&input.target_branch);
    if !valid_branch_name(branch) {
        return Err(format!(
            "Invalid target branch for project {}",
            input.name.trim()
        ));
    }
    if input.kanban_source.as_deref() == Some("superthread") {
        if input
            .superthread_spaces
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            return Err("Superthread spaces are required".into());
        }
        let token_env = input
            .superthread_api_token_env_var
            .as_deref()
            .unwrap_or("ST_TOKEN")
            .trim();
        if token_env.is_empty()
            || !token_env
                .starts_with(|character: char| character == '_' || character.is_ascii_alphabetic())
            || !token_env
                .chars()
                .all(|character| character == '_' || character.is_ascii_alphanumeric())
        {
            return Err(
                "Superthread API Token Env Variable must be a valid environment variable name"
                    .into(),
            );
        }
        validate_superthread_mapping(input)?;
    }
    Ok(())
}

fn validate_superthread_mapping(input: &ProjectConfigurationInput) -> Result<(), String> {
    let board = input
        .superthread_board_id
        .as_deref()
        .unwrap_or_default()
        .trim();
    if board.is_empty() {
        return Err("Configure and test a Superthread board before saving".into());
    }
    if input.superthread_incoming_columns.is_empty() {
        return Err("Select at least one Incoming column".into());
    }
    let incoming = input
        .superthread_incoming_columns
        .iter()
        .map(|column| column.id.trim())
        .collect::<std::collections::HashSet<_>>();
    if incoming.len() != input.superthread_incoming_columns.len() || incoming.contains("") {
        return Err("Incoming columns must have unique IDs".into());
    }
    let default = input
        .superthread_default_incoming_column_id
        .as_deref()
        .unwrap_or_default()
        .trim();
    if !incoming.contains(default) {
        return Err("Default incoming column must be one of the Incoming columns".into());
    }
    let progress = input
        .superthread_in_progress_column_id
        .as_deref()
        .unwrap_or_default()
        .trim();
    let done = input
        .superthread_done_column_id
        .as_deref()
        .unwrap_or_default()
        .trim();
    if progress.is_empty()
        || done.is_empty()
        || progress == done
        || incoming.contains(progress)
        || incoming.contains(done)
    {
        return Err("Incoming, In progress, and Stacks is done columns must be distinct".into());
    }
    Ok(())
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn persist_targeted_store(store: ProjectStore) -> Result<ProjectStore, String> {
    write_legacy_json_mirror(&store)?;
    Ok(store)
}

#[tauri::command]
pub async fn create_project(
    service: State<'_, SuperthreadService>,
    mut input: ProjectConfigurationInput,
) -> Result<ProjectStore, String> {
    validate_live_superthread_configuration(service.inner().clone(), &mut input).await?;
    create_project_validated(input)
}

fn create_project_validated(input: ProjectConfigurationInput) -> Result<ProjectStore, String> {
    validate_project_input(&input)?;
    let store = kanban::with_connection(|connection| {
        if connection
            .query_row(
                "SELECT 1 FROM projects WHERE id=?1",
                [&input.id],
                |_| Ok(()),
            )
            .optional()
            .map_err(db_error)?
            .is_some()
        {
            return Err("That project already exists".into());
        }
        if connection
            .query_row(
                "SELECT 1 FROM projects WHERE path=?1",
                [input.path.trim()],
                |_| Ok(()),
            )
            .optional()
            .map_err(db_error)?
            .is_some()
        {
            return Err("That project directory is already added".into());
        }
        let source = if input.kanban_source.as_deref() == Some("superthread") {
            "superthread"
        } else {
            "local"
        };
        if source == "superthread" {
            if let Some(owner) = connection
                .query_row(
                    "SELECT name FROM projects WHERE kanban_source='superthread' LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(db_error)?
            {
                return Err(format!("Superthread is already owned by {owner}. Change that project to a local board first."));
            }
            let active: i64 = connection.query_row("SELECT COUNT(*) FROM kanban_cards WHERE external_provider='superthread' AND (status != 'done' OR scope_suspended=1 OR delivery_operation_stage IS NOT NULL)", [], |row| row.get(0)).map_err(db_error)?;
            let environments: i64 = connection.query_row("SELECT COUNT(*) FROM card_environments e JOIN kanban_cards c ON c.id=e.card_id WHERE c.external_provider='superthread'", [], |row| row.get(0)).map_err(db_error)?;
            if active > 0 || environments > 0 {
                return Err(format!("Superthread ownership cannot change: finish {active} active Superthread card(s) and clean up {environments} environment(s) first."));
            }
        }
        let order: i64 = connection
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM projects",
                [],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        let target = normalize_target_branch(&input.target_branch).to_string();
        let release = if input.release_config_path.trim().is_empty() {
            default_release_config_path()
        } else {
            input.release_config_path.trim().into()
        };
        let spaces = if source == "superthread" {
            non_empty(input.superthread_spaces.clone())
        } else {
            None
        };
        let slug = if source == "superthread" {
            non_empty(input.superthread_workspace_slug.clone())
        } else {
            None
        };
        let transaction = connection.transaction().map_err(db_error)?;
        transaction.execute(
            "INSERT INTO projects(id,name,path,kanban_source,start_work_command,superthread_spaces,superthread_workspace_slug,superthread_api_token_env_var,superthread_board_id,superthread_board_name,superthread_incoming_columns,superthread_default_incoming_column_id,superthread_in_progress_column_id,superthread_in_progress_column_name,superthread_done_column_id,superthread_done_column_name,superthread_mapping_revision,server_command,console_command,sort_order,delivery_workflow,target_branch,supports_feature_environments,github_merge_strategy,require_passing_ci,require_approval,releases_enabled,release_config_path,config_revision) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,1,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,0)",
            params![input.id, input.name.trim(), input.path.trim(), source, non_empty(input.start_work_command), spaces, slug,
                input.superthread_api_token_env_var.as_deref().unwrap_or("ST_TOKEN").trim(), input.superthread_board_id, input.superthread_board_name, serde_json::to_string(&input.superthread_incoming_columns).map_err(|e| e.to_string())?,
                input.superthread_default_incoming_column_id, input.superthread_in_progress_column_id, input.superthread_in_progress_column_name,
                input.superthread_done_column_id, input.superthread_done_column_name, non_empty(input.server_command), non_empty(input.console_command), order,
                normalize_delivery_workflow(&input.delivery_workflow), target, input.supports_feature_environments as i64,
                normalize_merge_strategy(&input.github_merge_strategy), input.require_passing_ci as i64, input.require_approval as i64, input.releases_enabled as i64, release],
        ).map_err(db_error)?;
        if source == "superthread" {
            transaction
                .execute(
                    "UPDATE kanban_cards SET project_id=?1 WHERE external_provider='superthread'",
                    [&input.id],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)?;
        read_store(connection)
    })?;
    persist_targeted_store(store)
}

#[tauri::command]
pub async fn update_project_configuration(
    service: State<'_, SuperthreadService>,
    mut input: ProjectConfigurationInput,
) -> Result<ProjectStore, String> {
    let provider = service.inner().clone();
    if kanban::with_connection(|connection| kanban::executing_for_project(connection, &input.id))? {
        return Err(
            "Project settings cannot be saved while provider synchronization is executing".into(),
        );
    }
    validate_live_superthread_configuration(provider.clone(), &mut input).await?;
    let saved = update_project_configuration_validated(input)?;
    let _ = tauri::async_runtime::spawn_blocking(move || kanban::run_pending_once(provider, None))
        .await;
    Ok(saved)
}

async fn validate_live_superthread_configuration(
    service: SuperthreadService,
    input: &mut ProjectConfigurationInput,
) -> Result<(), String> {
    if input.kanban_source.as_deref() != Some("superthread") {
        return Ok(());
    }
    validate_project_input(input)?;
    let draft = SuperthreadMappingDraft {
        spaces: input.superthread_spaces.clone().unwrap_or_default(),
        board_id: input.superthread_board_id.clone().unwrap_or_default(),
        incoming_column_ids: input
            .superthread_incoming_columns
            .iter()
            .map(|column| column.id.clone())
            .collect(),
        default_incoming_column_id: input
            .superthread_default_incoming_column_id
            .clone()
            .unwrap_or_default(),
        in_progress_column_id: input
            .superthread_in_progress_column_id
            .clone()
            .unwrap_or_default(),
        done_column_id: input.superthread_done_column_id.clone().unwrap_or_default(),
        api_token_env_var: input
            .superthread_api_token_env_var
            .clone()
            .unwrap_or_else(|| "ST_TOKEN".into()),
    };
    let tested = tauri::async_runtime::spawn_blocking(move || service.test_mapping(&draft))
        .await
        .map_err(|error| format!("Superthread configuration test failed: {error}"))??;
    input.superthread_board_name = Some(tested.board_name);
    input.superthread_incoming_columns = tested
        .incoming_columns
        .into_iter()
        .map(|column| SuperthreadColumnMapping {
            id: column.id,
            name: column.name,
        })
        .collect();
    input.superthread_in_progress_column_name = Some(tested.in_progress_column_name);
    input.superthread_done_column_name = Some(tested.done_column_name);
    Ok(())
}

fn update_project_configuration_validated(
    input: ProjectConfigurationInput,
) -> Result<ProjectStore, String> {
    validate_project_input(&input)?;
    let store = kanban::with_connection(|connection| {
        let duplicate = connection
            .query_row(
                "SELECT name FROM projects WHERE id != ?1 AND path = ?2 LIMIT 1",
                params![input.id, input.path.trim()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?;
        if duplicate.is_some() {
            return Err("That project directory is already added".into());
        }
        let (previous_source, previous_board_id, current_revision, previous_mapping_revision) = connection.query_row(
            "SELECT COALESCE(kanban_source, 'local'), superthread_board_id, config_revision, superthread_mapping_revision FROM projects WHERE id=?1", [&input.id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?)),
        ).optional().map_err(db_error)?.ok_or_else(|| "Project configuration could not be saved because the project was not found".to_string())?;
        if current_revision != input.expected_revision {
            return Err("Project configuration changed since it was loaded; review this draft before saving again".into());
        }
        let next_source = if input.kanban_source.as_deref() == Some("superthread") {
            "superthread"
        } else {
            "local"
        };
        if next_source == "superthread" {
            if let Some(owner) = connection.query_row(
                "SELECT name FROM projects WHERE kanban_source='superthread' AND id != ?1 LIMIT 1", [&input.id], |row| row.get::<_, String>(0),
            ).optional().map_err(db_error)? {
                return Err(format!("Superthread is already owned by {owner}. Change that project to a local board first."));
            }
        }
        let board_rebound = previous_source == "superthread"
            && next_source == "superthread"
            && previous_board_id.is_some()
            && previous_board_id.as_deref().unwrap_or_default()
                != input.superthread_board_id.as_deref().unwrap_or_default();
        if board_rebound && kanban::unresolved_for_project(connection, &input.id)? > 0 {
            return Err("Superthread board cannot change while provider synchronization is pending or failed. Retry the synchronization first.".into());
        }
        if previous_source != next_source || board_rebound {
            let active: i64 = connection.query_row("SELECT COUNT(*) FROM kanban_cards WHERE external_provider='superthread' AND (status != 'done' OR scope_suspended=1 OR delivery_operation_stage IS NOT NULL)", [], |row| row.get(0)).map_err(db_error)?;
            let environments: i64 = connection.query_row("SELECT COUNT(*) FROM card_environments e JOIN kanban_cards c ON c.id=e.card_id WHERE c.external_provider='superthread'", [], |row| row.get(0)).map_err(db_error)?;
            if active > 0 || environments > 0 {
                return Err(format!("Superthread ownership or board cannot change: finish {active} active Superthread card(s) and clean up {environments} environment(s) first."));
            }
        }
        let transaction = connection.transaction().map_err(db_error)?;
        if !update_project_configuration_row(&transaction, &input, next_source)? {
            return Err("Project configuration changed since it was loaded; review this draft before saving again".into());
        }
        let next_mapping_revision: i64 = transaction
            .query_row(
                "SELECT superthread_mapping_revision FROM projects WHERE id=?1",
                [&input.id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if next_mapping_revision != previous_mapping_revision {
            kanban::supersede_for_mapping_change(&transaction, &input.id)?;
        }
        if previous_source != next_source {
            if next_source == "superthread" {
                transaction.execute("UPDATE kanban_cards SET project_id=?1 WHERE external_provider='superthread'", [&input.id],).map_err(db_error)?;
            } else {
                transaction.execute("UPDATE kanban_cards SET project_id=NULL,in_scope=0 WHERE external_provider='superthread'", []).map_err(db_error)?;
            }
        }
        transaction.commit().map_err(db_error)?;
        read_store(connection)
    })?;
    persist_targeted_store(store)
}

fn update_project_configuration_row(
    connection: &Connection,
    input: &ProjectConfigurationInput,
    source: &str,
) -> Result<bool, String> {
    let target_branch = normalize_target_branch(&input.target_branch).to_string();
    let release_path = if input.release_config_path.trim().is_empty() {
        default_release_config_path()
    } else {
        input.release_config_path.trim().into()
    };
    let superthread_spaces = if source == "superthread" {
        non_empty(input.superthread_spaces.clone())
    } else {
        None
    };
    let superthread_slug = if source == "superthread" {
        non_empty(input.superthread_workspace_slug.clone())
    } else {
        None
    };
    let incoming = serde_json::to_string(&input.superthread_incoming_columns)
        .map_err(|error| error.to_string())?;
    connection.execute(
        "UPDATE projects SET name=?1,path=?2,kanban_source=?3,start_work_command=?4,superthread_spaces=?5,superthread_workspace_slug=?6,superthread_api_token_env_var=?27,
         superthread_board_id=?7,superthread_board_name=?8,superthread_incoming_columns=?9,superthread_default_incoming_column_id=?10,
         superthread_in_progress_column_id=?11,superthread_in_progress_column_name=?12,superthread_done_column_id=?13,superthread_done_column_name=?14,
         superthread_mapping_revision=superthread_mapping_revision + CASE WHEN COALESCE(superthread_board_id,'')!=COALESCE(?7,'') OR COALESCE((SELECT group_concat(json_extract(value,'$.id'),'|') FROM json_each(superthread_incoming_columns)),'')!=COALESCE((SELECT group_concat(json_extract(value,'$.id'),'|') FROM json_each(?9)),'') OR COALESCE(superthread_default_incoming_column_id,'')!=COALESCE(?10,'') OR COALESCE(superthread_in_progress_column_id,'')!=COALESCE(?11,'') OR COALESCE(superthread_done_column_id,'')!=COALESCE(?13,'') THEN 1 ELSE 0 END,
         server_command=?15,console_command=?16,delivery_workflow=?17,target_branch=?18,supports_feature_environments=?19,github_merge_strategy=?20,require_passing_ci=?21,require_approval=?22,releases_enabled=?23,release_config_path=?24,config_revision=config_revision+1 WHERE id=?25 AND config_revision=?26",
        params![input.name.trim(), input.path.trim(), source, non_empty(input.start_work_command.clone()), superthread_spaces, superthread_slug,
            input.superthread_board_id, input.superthread_board_name, incoming, input.superthread_default_incoming_column_id,
            input.superthread_in_progress_column_id, input.superthread_in_progress_column_name, input.superthread_done_column_id, input.superthread_done_column_name,
            non_empty(input.server_command.clone()), non_empty(input.console_command.clone()), normalize_delivery_workflow(&input.delivery_workflow), target_branch,
            input.supports_feature_environments as i64, normalize_merge_strategy(&input.github_merge_strategy), input.require_passing_ci as i64,
            input.require_approval as i64, input.releases_enabled as i64, release_path, input.id, input.expected_revision,
            input.superthread_api_token_env_var.as_deref().unwrap_or("ST_TOKEN").trim()],
    ).map(|changed| changed == 1).map_err(db_error)
}

#[tauri::command]
pub fn delete_project(project_id: String) -> Result<ProjectStore, String> {
    let (store, removed_cards) = kanban::with_connection(|connection| {
        let source = connection
            .query_row(
                "SELECT COALESCE(kanban_source,'local') FROM projects WHERE id=?1",
                [&project_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Project could not be deleted because it was not found".to_string())?;
        let active: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM kanban_cards WHERE project_id=?1 AND status != 'done'",
                [&project_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        let environments: i64 = connection.query_row("SELECT COUNT(*) FROM card_environments e JOIN kanban_cards c ON c.id=e.card_id WHERE e.project_id=?1 OR c.project_id=?1", [&project_id], |row| row.get(0)).map_err(db_error)?;
        if active > 0 || environments > 0 {
            return Err(format!("Project deletion is blocked: finish its {active} active card(s) and clean up its {environments} card environment(s) first."));
        }
        let removed_cards = connection.prepare("SELECT id FROM kanban_cards WHERE project_id=?1 AND external_provider != 'superthread'").map_err(db_error)?
            .query_map([&project_id], |row| row.get::<_, String>(0)).map_err(db_error)?.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
        let transaction = connection.transaction().map_err(db_error)?;
        if source == "superthread" {
            transaction.execute("UPDATE kanban_cards SET project_id=NULL,in_scope=0 WHERE external_provider='superthread'", []).map_err(db_error)?;
        }
        transaction.execute("DELETE FROM kanban_cards WHERE project_id=?1 AND external_provider != 'superthread'", [&project_id]).map_err(db_error)?;
        transaction
            .execute(
                "DELETE FROM kanban_project_sequences WHERE project_id=?1",
                [&project_id],
            )
            .map_err(db_error)?;
        transaction
            .execute("DELETE FROM projects WHERE id=?1", [&project_id])
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        Ok((read_store(connection)?, removed_cards))
    })?;
    let store = persist_targeted_store(store)?;
    for card_id in removed_cards {
        let directory = crate::kanban::card_directory(&card_id)?;
        if directory.exists() {
            fs::remove_dir_all(directory).map_err(|error| {
                format!(
                    "Project was deleted, but completed card files could not be removed: {error}"
                )
            })?;
        }
    }
    Ok(store)
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
    // This is the sole migration boundary where notes from the old JSON source are imported.
    for project in &store.projects {
        connection
            .execute(
                "UPDATE projects SET notes=?1 WHERE id=?2",
                params![project.notes, project.id],
            )
            .map_err(db_error)?;
    }
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
        "SELECT id, name, path, notes, collapsed, kanban_source, start_work_command, superthread_spaces, superthread_workspace_slug, superthread_api_token_env_var,
                superthread_board_id, superthread_board_name, superthread_incoming_columns, superthread_default_incoming_column_id,
                superthread_in_progress_column_id, superthread_in_progress_column_name, superthread_done_column_id, superthread_done_column_name, superthread_mapping_revision,
                server_command, console_command, delivery_workflow, target_branch, supports_feature_environments, github_merge_strategy, require_passing_ci, require_approval,
                releases_enabled, release_config_path, config_revision
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
                superthread_spaces: row.get(7)?,
                superthread_workspace_slug: row.get(8)?,
                superthread_api_token_env_var: row.get(9)?,
                superthread_board_id: row.get(10)?,
                superthread_board_name: row.get(11)?,
                superthread_incoming_columns: serde_json::from_str(&row.get::<_, String>(12)?)
                    .unwrap_or_default(),
                superthread_default_incoming_column_id: row.get(13)?,
                superthread_in_progress_column_id: row.get(14)?,
                superthread_in_progress_column_name: row.get(15)?,
                superthread_done_column_id: row.get(16)?,
                superthread_done_column_name: row.get(17)?,
                superthread_mapping_revision: row.get(18)?,
                server_command: row.get(19)?,
                console_command: row.get(20)?,
                delivery_workflow: row.get(21)?,
                target_branch: row.get(22)?,
                supports_feature_environments: row.get::<_, i64>(23)? != 0,
                github_merge_strategy: row.get(24)?,
                require_passing_ci: row.get::<_, i64>(25)? != 0,
                require_approval: row.get::<_, i64>(26)? != 0,
                releases_enabled: row.get::<_, i64>(27)? != 0,
                release_config_path: row.get(28)?,
                config_revision: row.get(29)?,
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
    let incoming_owners = store
        .projects
        .iter()
        .filter(|project| project.kanban_source.as_deref() == Some("superthread"))
        .collect::<Vec<_>>();
    if incoming_owners.len() > 1 {
        let existing_name = connection
            .query_row(
                "SELECT name FROM projects WHERE kanban_source='superthread' ORDER BY id LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?;
        let owner_name = existing_name
            .as_deref()
            .unwrap_or(incoming_owners[0].name.as_str());
        return Err(format!("Superthread is already owned by {owner_name}. At most one project can use Superthread as its work board."));
    }
    let existing_owner = connection
        .query_row(
            "SELECT id FROM projects WHERE kanban_source='superthread' ORDER BY id LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    let incoming_owner = incoming_owners.first().map(|project| project.id.as_str());
    if existing_owner.as_deref() != incoming_owner {
        let active: i64 = connection.query_row(
            "SELECT COUNT(*) FROM kanban_cards WHERE external_provider='superthread' AND (status != 'done' OR scope_suspended=1 OR delivery_operation_stage IS NOT NULL)", [], |row| row.get(0)
        ).map_err(db_error)?;
        let environments: i64 = connection.query_row(
            "SELECT COUNT(*) FROM card_environments e JOIN kanban_cards c ON c.id=e.card_id WHERE c.external_provider='superthread'", [], |row| row.get(0)
        ).map_err(db_error)?;
        if active > 0 || environments > 0 {
            let owner_name = existing_owner
                .as_deref()
                .and_then(|id| store.projects.iter().find(|project| project.id == id))
                .map(|project| project.name.as_str())
                .unwrap_or("the current owner");
            return Err(format!("Superthread ownership cannot change from {owner_name}: finish {active} active Superthread card(s) and clean up {environments} environment(s) first."));
        }
    }
    let incoming_ids = store
        .projects
        .iter()
        .map(|project| project.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let removed_projects = connection
        .prepare("SELECT id FROM projects")
        .map_err(db_error)?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?
        .into_iter()
        .filter(|id| !incoming_ids.contains(id.as_str()))
        .collect::<Vec<_>>();
    let mut removed_card_ids = Vec::new();
    for project_id in &removed_projects {
        let active: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM kanban_cards WHERE project_id=?1 AND status != 'done'",
                [project_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        let environments: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM card_environments e JOIN kanban_cards c ON c.id=e.card_id WHERE e.project_id=?1 OR c.project_id=?1",
                [project_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if active > 0 || environments > 0 {
            return Err(format!("Project deletion is blocked: finish its {active} active card(s) and clean up its {environments} card environment(s) first."));
        }
        removed_card_ids.extend(
            connection
                .prepare("SELECT id FROM kanban_cards WHERE project_id=?1 AND external_provider != 'superthread'")
                .map_err(db_error)?
                .query_map([project_id], |row| row.get::<_, String>(0))
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?,
        );
    }
    // Notes have a focused compare-and-swap writer. Snapshot them before the broad
    // replacement so an unrelated settings save cannot become an alternate writer.
    let persisted_notes = connection
        .prepare("SELECT id, notes, notes_revision FROM projects")
        .map_err(db_error)?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (row.get::<_, String>(1)?, row.get::<_, i64>(2)?),
            ))
        })
        .map_err(db_error)?
        .collect::<Result<std::collections::HashMap<_, _>, _>>()
        .map_err(db_error)?;
    let transaction = connection.transaction().map_err(db_error)?;
    for project_id in &removed_projects {
        transaction
            .execute("DELETE FROM kanban_cards WHERE project_id=?1 AND external_provider != 'superthread'", [project_id])
            .map_err(db_error)?;
        transaction
            .execute(
                "DELETE FROM kanban_project_sequences WHERE project_id=?1",
                [project_id],
            )
            .map_err(db_error)?;
    }
    transaction
        .execute("DELETE FROM legacy_workspaces", [])
        .map_err(db_error)?;
    transaction
        .execute("DELETE FROM projects", [])
        .map_err(db_error)?;
    for (project_index, project) in store.projects.iter().enumerate() {
        let target_branch = normalize_target_branch(&project.target_branch);
        if !valid_branch_name(target_branch) {
            return Err(format!(
                "Invalid target branch for project {}",
                project.name
            ));
        }
        let (notes, notes_revision) = persisted_notes
            .get(&project.id)
            .cloned()
            .unwrap_or_default();
        transaction.execute(
            "INSERT INTO projects (id, name, path, notes, notes_revision, collapsed, kanban_source, start_work_command, superthread_spaces, superthread_workspace_slug, server_command, console_command, sort_order,
                 delivery_workflow, target_branch, supports_feature_environments, github_merge_strategy, require_passing_ci, require_approval,
                 releases_enabled, release_config_path, config_revision, superthread_board_id, superthread_board_name, superthread_incoming_columns,
                 superthread_default_incoming_column_id, superthread_in_progress_column_id, superthread_in_progress_column_name,
                 superthread_done_column_id, superthread_done_column_name, superthread_mapping_revision, superthread_api_token_env_var)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32)",
            params![project.id, project.name, project.path, notes, notes_revision, project.collapsed as i64,
                project.kanban_source, project.start_work_command, project.superthread_spaces, project.superthread_workspace_slug,
                project.server_command, project.console_command, project_index as i64,
                normalize_delivery_workflow(&project.delivery_workflow), target_branch, project.supports_feature_environments as i64,
                normalize_merge_strategy(&project.github_merge_strategy), project.require_passing_ci as i64, project.require_approval as i64,
                project.releases_enabled as i64, if project.release_config_path.trim().is_empty() { default_release_config_path() } else { project.release_config_path.clone() }, project.config_revision,
                project.superthread_board_id, project.superthread_board_name, serde_json::to_string(&project.superthread_incoming_columns).map_err(|e| e.to_string())?,
                project.superthread_default_incoming_column_id, project.superthread_in_progress_column_id, project.superthread_in_progress_column_name,
                project.superthread_done_column_id, project.superthread_done_column_name, project.superthread_mapping_revision,
                project.superthread_api_token_env_var.as_deref().unwrap_or("ST_TOKEN")],
        ).map_err(db_error)?;
        for (workspace_index, workspace) in project.workspaces.iter().enumerate() {
            transaction.execute(
                "INSERT INTO legacy_workspaces (id, project_id, name, command, cwd, splits, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![workspace.id, project.id, workspace.name, workspace.command, workspace.cwd,
                    workspace.splits.as_ref().map(serde_json::Value::to_string), workspace_index as i64],
            ).map_err(db_error)?;
        }
    }
    if existing_owner.as_deref() != incoming_owner {
        if let Some(owner_id) = incoming_owner {
            transaction
                .execute(
                    "UPDATE kanban_cards SET project_id=?1 WHERE external_provider='superthread'",
                    [owner_id],
                )
                .map_err(db_error)?;
        } else {
            transaction.execute("UPDATE kanban_cards SET project_id=NULL, in_scope=0 WHERE external_provider='superthread'", []).map_err(db_error)?;
        }
    }
    transaction.commit().map_err(db_error)?;
    for card_id in removed_card_ids {
        let directory = crate::kanban::card_directory(&card_id)?;
        if directory.exists() {
            fs::remove_dir_all(&directory).map_err(|error| {
                format!(
                    "Project was deleted, but completed card files could not be removed: {error}"
                )
            })?;
        }
    }
    Ok(())
}

fn normalize_delivery_workflow(value: &str) -> &str {
    if value == "github_pull_request" {
        value
    } else {
        "local_merge"
    }
}

fn normalize_target_branch(value: &str) -> &str {
    let value = value.trim();
    if value.is_empty() {
        "main"
    } else {
        value
    }
}

fn valid_branch_name(value: &str) -> bool {
    !value.starts_with('-')
        && !value.ends_with('/')
        && !value.ends_with('.')
        && !value.ends_with(".lock")
        && !value.contains("..")
        && !value.contains("@{")
        && !value.chars().any(|character| {
            character.is_control() || character.is_whitespace() || "~^:?*[\\".contains(character)
        })
}

fn normalize_merge_strategy(value: &str) -> &str {
    if matches!(value, "squash" | "rebase") {
        value
    } else {
        "merge"
    }
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
                superthread_spaces: None,
                superthread_workspace_slug: None,
                superthread_api_token_env_var: Some("ST_TOKEN".into()),
                superthread_board_id: None,
                superthread_board_name: None,
                superthread_incoming_columns: vec![],
                superthread_default_incoming_column_id: None,
                superthread_in_progress_column_id: None,
                superthread_in_progress_column_name: None,
                superthread_done_column_id: None,
                superthread_done_column_name: None,
                superthread_mapping_revision: 0,
                server_command: Some("npm run dev".into()),
                console_command: None,
                delivery_workflow: default_delivery_workflow(),
                target_branch: default_target_branch(),
                supports_feature_environments: false,
                github_merge_strategy: default_merge_strategy(),
                require_passing_ci: true,
                require_approval: false,
                releases_enabled: false,
                release_config_path: default_release_config_path(),
                config_revision: 0,
            }],
        }
    }

    #[test]
    fn loads_legacy_project_terminals_as_workspaces() {
        let text = r#"{"projects":[{"id":"p1","name":"Project","path":"/repo","terminals":[{"id":"w1","name":"Dev","command":"npm run dev","cwd":"/repo"}]}]}"#;
        let store: ProjectStore = serde_json::from_str(text).unwrap();
        assert_eq!(store.projects[0].workspaces[0].id, "w1");
        assert_eq!(store.projects[0].delivery_workflow, "local_merge");
        assert_eq!(store.projects[0].target_branch, "main");
        assert_eq!(store.projects[0].github_merge_strategy, "merge");
        assert!(store.projects[0].require_passing_ci);
        assert!(!store.projects[0].require_approval);
    }

    #[test]
    fn targeted_configuration_update_preserves_project_owned_state_and_rejects_stale_drafts() {
        let mut connection = Connection::open_in_memory().unwrap();
        kanban::migrate(&connection).unwrap();
        migrate_store_schema(&connection).unwrap();
        write_store(&mut connection, &sample_store()).unwrap();
        connection
            .execute(
                "ALTER TABLE projects ADD COLUMN future_value TEXT NOT NULL DEFAULT 'future'",
                [],
            )
            .unwrap();
        connection.execute("UPDATE projects SET notes='new notes',notes_revision=7,collapsed=1,sort_order=9,future_value='keep me' WHERE id='p1'", []).unwrap();
        let input = ProjectConfigurationInput {
            id: "p1".into(),
            name: "Renamed".into(),
            path: "/renamed".into(),
            kanban_source: Some("local".into()),
            start_work_command: Some(" setup ".into()),
            superthread_spaces: None,
            superthread_workspace_slug: None,
            superthread_api_token_env_var: Some("ST_TOKEN".into()),
            superthread_board_id: None,
            superthread_board_name: None,
            superthread_incoming_columns: vec![],
            superthread_default_incoming_column_id: None,
            superthread_in_progress_column_id: None,
            superthread_in_progress_column_name: None,
            superthread_done_column_id: None,
            superthread_done_column_name: None,
            server_command: Some("server".into()),
            console_command: Some("console".into()),
            delivery_workflow: "github_pull_request".into(),
            target_branch: "develop".into(),
            supports_feature_environments: true,
            github_merge_strategy: "squash".into(),
            require_passing_ci: false,
            require_approval: true,
            releases_enabled: true,
            release_config_path: "release.json".into(),
            expected_revision: 0,
        };

        assert!(update_project_configuration_row(&connection, &input, "local").unwrap());
        assert!(!update_project_configuration_row(&connection, &input, "local").unwrap());
        let saved = read_store(&connection).unwrap();
        let project = &saved.projects[0];
        assert_eq!(
            (
                project.name.as_str(),
                project.path.as_str(),
                project.config_revision
            ),
            ("Renamed", "/renamed", 1)
        );
        assert_eq!(project.workspaces.len(), 1);
        let untouched: (String, i64, i64, i64, String) = connection.query_row(
            "SELECT notes,notes_revision,collapsed,sort_order,future_value FROM projects WHERE id='p1'", [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).unwrap();
        assert_eq!(untouched, ("new notes".into(), 7, 1, 9, "keep me".into()));
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
        let service_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM card_service_definitions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(status, "approved");
        assert_eq!(path, "/repo");
        assert_eq!(service_count, 0);
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
            superthread_spaces: Some("Product".into()),
            superthread_workspace_slug: None,
            superthread_api_token_env_var: Some("ST_TOKEN".into()),
            superthread_board_id: Some("board".into()),
            superthread_board_name: Some("Board".into()),
            superthread_incoming_columns: vec![SuperthreadColumnMapping {
                id: "incoming".into(),
                name: "Incoming".into(),
            }],
            superthread_default_incoming_column_id: Some("incoming".into()),
            superthread_in_progress_column_id: Some("progress".into()),
            superthread_in_progress_column_name: Some("Progress".into()),
            superthread_done_column_id: Some("done".into()),
            superthread_done_column_name: Some("Done".into()),
            superthread_mapping_revision: 1,
            server_command: None,
            console_command: None,
            delivery_workflow: default_delivery_workflow(),
            target_branch: default_target_branch(),
            supports_feature_environments: false,
            github_merge_strategy: default_merge_strategy(),
            require_passing_ci: true,
            require_approval: false,
            releases_enabled: false,
            release_config_path: default_release_config_path(),
            config_revision: 0,
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
    fn project_deletion_blocks_active_work_and_removes_completed_history() {
        let mut connection = Connection::open_in_memory().unwrap();
        kanban::migrate(&connection).unwrap();
        migrate_store_schema(&connection).unwrap();
        write_store(&mut connection, &sample_store()).unwrap();
        connection.execute(
            "INSERT INTO kanban_cards (id, external_provider, external_id, title, status, project_id, created_at, updated_at) VALUES ('local:owned', 'local:p1', '1', 'Owned', 'ready', 'p1', 1, 1)", [],
        ).unwrap();

        let empty = ProjectStore::default();
        assert!(write_store(&mut connection, &empty)
            .unwrap_err()
            .contains("active card"));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM projects WHERE id='p1'", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );

        connection
            .execute(
                "UPDATE kanban_cards SET status='done', completion_outcome='merged' WHERE id='local:owned'",
                [],
            )
            .unwrap();
        write_store(&mut connection, &empty).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM kanban_cards WHERE id='local:owned'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn enforces_singleton_superthread_ownership_and_safe_history_transfer() {
        let mut connection = Connection::open_in_memory().unwrap();
        kanban::migrate(&connection).unwrap();
        migrate_store_schema(&connection).unwrap();
        let mut owned = sample_store();
        owned.projects[0].kanban_source = Some("superthread".into());
        owned.projects[0].superthread_spaces = Some("Product".into());
        write_store(&mut connection, &owned).unwrap();
        connection.execute(
            "INSERT INTO kanban_cards(id, external_provider, external_id, title, status, project_id, created_at, updated_at) VALUES ('superthread:1','superthread','1','History','ready','p1',1,1)", [],
        ).unwrap();

        let mut competing = owned.clone();
        let mut second = competing.projects[0].clone();
        second.id = "p2".into();
        second.name = "Second".into();
        second.path = "/second".into();
        second.workspaces.clear();
        competing.projects.push(second.clone());
        assert!(write_store(&mut connection, &competing)
            .unwrap_err()
            .contains("already owned by Project"));

        let mut no_owner = owned.clone();
        no_owner.projects[0].kanban_source = Some("local".into());
        no_owner.projects[0].superthread_spaces = None;
        assert!(write_store(&mut connection, &no_owner)
            .unwrap_err()
            .contains("finish 1 active"));
        connection
            .execute(
                "UPDATE kanban_cards SET status='done' WHERE id='superthread:1'",
                [],
            )
            .unwrap();
        connection.execute(
            "INSERT INTO card_environments(id, card_id, project_id, worktree_path, created_at, updated_at) VALUES ('e','superthread:1','p1','/tmp/work',1,1)", [],
        ).unwrap();
        assert!(write_store(&mut connection, &no_owner)
            .unwrap_err()
            .contains("clean up 1 environment"));
        connection
            .execute("DELETE FROM card_environments", [])
            .unwrap();
        write_store(&mut connection, &no_owner).unwrap();
        let hidden: (Option<String>, i64) = connection
            .query_row(
                "SELECT project_id, in_scope FROM kanban_cards WHERE id='superthread:1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(hidden, (None, 0));

        second.kanban_source = Some("superthread".into());
        let transferred = ProjectStore {
            projects: vec![no_owner.projects[0].clone(), second],
        };
        write_store(&mut connection, &transferred).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT project_id FROM kanban_cards WHERE id='superthread:1'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "p2"
        );
    }

    #[test]
    fn adds_notes_revision_without_losing_existing_notes() {
        let connection = Connection::open_in_memory().unwrap();
        kanban::migrate(&connection).unwrap();
        connection.execute_batch(
            "CREATE TABLE projects (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
                notes TEXT NOT NULL DEFAULT '', collapsed INTEGER NOT NULL DEFAULT 0,
                kanban_source TEXT, start_work_command TEXT, server_command TEXT,
                console_command TEXT, sort_order INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO projects (id, name, path, notes) VALUES ('p1', 'Project', '/repo', 'existing');"
        ).unwrap();

        migrate_store_schema(&connection).unwrap();

        assert_eq!(
            load_project_notes_from_connection(&connection, "p1").unwrap(),
            ProjectNotes {
                notes: "existing".into(),
                revision: 0,
            }
        );
    }

    #[test]
    fn loads_and_compare_and_swap_saves_project_notes() {
        let mut connection = Connection::open_in_memory().unwrap();
        kanban::migrate(&connection).unwrap();
        migrate_store_schema(&connection).unwrap();
        write_store(&mut connection, &sample_store()).unwrap();

        assert_eq!(
            load_project_notes_from_connection(&connection, "p1").unwrap(),
            ProjectNotes {
                notes: String::new(),
                revision: 0,
            }
        );
        assert_eq!(
            save_project_notes_to_connection(&connection, "p1", "first", 0).unwrap(),
            ProjectNotes {
                notes: "first".into(),
                revision: 1,
            }
        );
        assert!(
            save_project_notes_to_connection(&connection, "p1", "stale", 0)
                .unwrap_err()
                .contains("changed")
        );
        assert_eq!(
            load_project_notes_from_connection(&connection, "p1").unwrap(),
            ProjectNotes {
                notes: "first".into(),
                revision: 1,
            }
        );
        assert!(load_project_notes_from_connection(&connection, "missing")
            .unwrap_err()
            .contains("not found"));
    }

    #[test]
    fn broad_store_saves_preserve_notes_and_deletion_removes_them() {
        let mut connection = Connection::open_in_memory().unwrap();
        kanban::migrate(&connection).unwrap();
        migrate_store_schema(&connection).unwrap();
        let mut store = sample_store();
        write_store(&mut connection, &store).unwrap();
        save_project_notes_to_connection(&connection, "p1", "durable", 0).unwrap();

        store.projects[0].name = "Renamed".into();
        store.projects[0].notes = "stale broad snapshot".into();
        write_store(&mut connection, &store).unwrap();
        assert_eq!(
            load_project_notes_from_connection(&connection, "p1").unwrap(),
            ProjectNotes {
                notes: "durable".into(),
                revision: 1,
            }
        );

        let mut new_project = store.projects[0].clone();
        new_project.id = "p2".into();
        new_project.name = "New".into();
        new_project.notes = "must not be imported".into();
        new_project.workspaces.clear();
        store.projects.push(new_project);
        write_store(&mut connection, &store).unwrap();
        assert_eq!(
            load_project_notes_from_connection(&connection, "p2").unwrap(),
            ProjectNotes {
                notes: String::new(),
                revision: 0,
            }
        );

        store.projects.retain(|project| project.id != "p2");
        write_store(&mut connection, &store).unwrap();
        assert!(load_project_notes_from_connection(&connection, "p2").is_err());
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
        let project = &read_store(&connection).unwrap().projects[0];
        assert_eq!(project.delivery_workflow, "local_merge");
        assert_eq!(project.target_branch, "main");
        assert!(project.require_passing_ci);
    }
}
