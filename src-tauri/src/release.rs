use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};

use crate::{fs_paths::app_data_dir, kanban, repository_coordinator};

const MAX_LOG_BYTES: usize = 2 * 1024 * 1024;
const TRUNCATION_MARKER: &str = "\n[Stacks: earlier release output truncated]\n";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseConfig {
    #[serde(alias = "currentVersionCommand")]
    pub current_version: String,
    #[serde(default, alias = "suggestedVersionCommand")]
    pub suggested_version: Option<String>,
    #[serde(default, alias = "versionValidationCommand", alias = "validateVersionCommand")]
    pub validate_version: Option<String>,
    #[serde(default, alias = "releaseNotesCommand", alias = "generateReleaseNotesCommand")]
    pub generate_notes: Option<String>,
    #[serde(default, alias = "preflightCommand")]
    pub preflight: Option<String>,
    pub stages: Vec<ReleaseStageConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseStageConfig {
    pub id: String,
    pub name: String,
    pub run: String,
    #[serde(default)]
    pub verify: Option<String>,
    pub repository_access: RepositoryAccess,
    #[serde(default, alias = "approvalGate", alias = "postStageApproval")]
    pub approval: Option<ReleaseApproval>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RepositoryAccess {
    Read,
    Exclusive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseApproval {
    #[serde(default)]
    pub instructions: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDraft {
    pub valid: bool,
    pub error: Option<String>,
    pub config_path: String,
    pub current_version: Option<String>,
    pub suggested_version: Option<String>,
    pub generated_notes: Option<String>,
    pub target_branch: String,
    pub source_revision: Option<String>,
    pub config: Option<ReleaseConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseOperation {
    pub id: String,
    pub project_id: String,
    pub project_path: String,
    pub repository_identity: String,
    pub config_path: String,
    pub config: ReleaseConfig,
    pub previous_version: String,
    pub version: String,
    pub notes: String,
    pub target_branch: String,
    pub initial_revision: String,
    pub expected_revision: String,
    pub status: String,
    pub stages: Vec<ReleaseStageState>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseStageState {
    pub id: String,
    pub name: String,
    pub status: String,
    pub attempt: i64,
    pub attempt_token: Option<String>,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub error: Option<String>,
    pub log_path: Option<String>,
    pub log: String,
    pub truncated: bool,
}

struct LiveReleaseProcess {
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
}

#[derive(Default)]
pub struct ReleaseRegistry {
    processes: Mutex<HashMap<String, LiveReleaseProcess>>,
    cancelled: Mutex<HashSet<String>>,
}

impl ReleaseRegistry {
    fn insert(
        &self,
        token: String,
        killer: Box<dyn ChildKiller + Send + Sync>,
        pid: Option<u32>,
    ) -> Result<(), String> {
        self.processes
            .lock()
            .map_err(|_| "Release process registry failed".to_string())?
            .insert(token, LiveReleaseProcess { killer, pid });
        Ok(())
    }
    fn remove(&self, token: &str) {
        if let Ok(mut guard) = self.processes.lock() {
            guard.remove(token);
        }
    }
    fn kill(&self, token: &str) -> Result<(), String> {
        let mut guard = self
            .processes
            .lock()
            .map_err(|_| "Release process registry failed".to_string())?;
        let process = guard
            .get_mut(token)
            .ok_or_else(|| "The release process is no longer running".to_string())?;
        terminate_release_process(process)
            .map_err(|error| format!("Could not cancel release process: {error}"))?;
        self.cancelled
            .lock()
            .map_err(|_| "Release process registry failed".to_string())?
            .insert(token.to_string());
        Ok(())
    }
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.processes.lock() {
            for process in guard.values_mut() {
                let _ = terminate_release_process(process);
            }
            guard.clear();
        }
    }
}

fn terminate_release_process(process: &mut LiveReleaseProcess) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    if let Some(pid) = process.pid {
        unsafe {
            let group = -(pid as i32);
            if libc::kill(group, libc::SIGTERM) == 0 {
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                while std::time::Instant::now() < deadline {
                    if libc::kill(group, 0) != 0 { return Ok(()); }
                    thread::sleep(Duration::from_millis(25));
                }
                if libc::kill(group, 0) == 0 { libc::kill(group, libc::SIGKILL); }
                return Ok(());
            }
        }
    }
    process.killer.kill()
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), String> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS release_operations (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            repository_identity TEXT NOT NULL,
            status TEXT NOT NULL,
            revision INTEGER NOT NULL,
            state_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS release_operations_project_idx ON release_operations(project_id, created_at DESC);
         CREATE INDEX IF NOT EXISTS release_operations_repository_idx ON release_operations(repository_identity, status);
         CREATE UNIQUE INDEX IF NOT EXISTS release_operations_one_active_repository_idx ON release_operations(repository_identity)
            WHERE status IN ('running','awaitingApproval','failed','cancelled','interrupted');
         CREATE TABLE IF NOT EXISTS release_attempts (
            token TEXT PRIMARY KEY,
            operation_id TEXT NOT NULL,
            stage_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            pid INTEGER,
            log_path TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            completed_at INTEGER
         );"
    ).map_err(db_error)?;
    let now = now();
    let mut statement = connection
        .prepare("SELECT id, state_json FROM release_operations WHERE status='running'")
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(statement);
    for (id, json) in rows {
        let mut operation: ReleaseOperation =
            serde_json::from_str(&json).map_err(|error| error.to_string())?;
        operation.status = "interrupted".into();
        operation.updated_at = now;
        operation.revision += 1;
        if let Some(stage) = operation
            .stages
            .iter_mut()
            .find(|stage| stage.status == "running")
        {
            stage.status = "interrupted".into();
            stage.completed_at = Some(now);
            stage.error = Some("Stacks closed while this attempt was running. Retry after reviewing repository state.".into());
        }
        connection.execute("UPDATE release_operations SET status='interrupted', revision=?1, state_json=?2, updated_at=?3 WHERE id=?4", params![operation.revision, serde_json::to_string(&operation).unwrap(), now, id]).map_err(db_error)?;
    }
    connection.execute("UPDATE release_attempts SET status='interrupted', completed_at=?1 WHERE status='running'", [now]).map_err(db_error)?;
    Ok(())
}

#[tauri::command]
pub fn release_inspect(project_id: String) -> Result<ReleaseDraft, String> {
    let project = project(&project_id)?;
    let config_path = project.config_path.clone();
    match inspect(&project, true) {
        Ok(draft) => Ok(draft),
        Err(error) => Ok(ReleaseDraft {
            valid: false,
            error: Some(error),
            config_path,
            current_version: None,
            suggested_version: None,
            generated_notes: None,
            target_branch: project.target_branch,
            source_revision: None,
            config: None,
        }),
    }
}

#[tauri::command]
pub fn release_history(project_id: String) -> Result<Vec<ReleaseOperation>, String> {
    kanban::with_connection(|connection| {
        let mut statement = connection.prepare("SELECT state_json FROM release_operations WHERE project_id=?1 ORDER BY created_at DESC LIMIT 25").map_err(db_error)?;
        let rows = statement
            .query_map([project_id], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .map(|row| {
                row.map_err(db_error)
                    .and_then(|json| decode_operation(&json))
            })
            .collect();
        rows
    })
}

#[tauri::command]
pub fn release_start(
    app: AppHandle,
    registry: State<'_, Arc<ReleaseRegistry>>,
    project_id: String,
    version: String,
    notes: String,
) -> Result<ReleaseOperation, String> {
    let project = project(&project_id)?;
    let draft = inspect(&project, false)?;
    let config = draft
        .config
        .ok_or_else(|| "Release configuration is unavailable".to_string())?;
    let previous = draft
        .current_version
        .ok_or_else(|| "Current-version command returned no version".to_string())?;
    let version = version.trim().to_string();
    if version.is_empty() {
        return Err("A release version is required".into());
    }
    let root = canonical_primary_checkout(&project.path)?;
    let head = repository_preflight(&root, &project.target_branch, None)?;
    let identity = repository_coordinator::repository_identity(&root)?
        .to_string_lossy()
        .to_string();
    ensure_no_active_release(&identity)?;
    let id = uuid::Uuid::new_v4().to_string();
    let notes_path = write_notes(&id, &notes)?;
    let command_env = release_env(
        &version,
        &previous,
        &root,
        &project.target_branch,
        &head,
        &id,
        notes_path.to_string_lossy().as_ref(),
    );
    if let Some(command) = config.validate_version.as_deref() {
        run_capture(command, &root, &command_env)?;
    }
    if let Some(command) = config.preflight.as_deref() {
        run_capture(command, &root, &command_env)?;
    }
    let created = now();
    let mut operation = ReleaseOperation {
        id: id.clone(),
        project_id,
        project_path: root.to_string_lossy().to_string(),
        repository_identity: identity,
        config_path: draft.config_path,
        config: config.clone(),
        previous_version: previous,
        version,
        notes,
        target_branch: project.target_branch,
        initial_revision: head.clone(),
        expected_revision: head,
        status: "running".into(),
        stages: config
            .stages
            .iter()
            .map(|stage| ReleaseStageState {
                id: stage.id.clone(),
                name: stage.name.clone(),
                status: "pending".into(),
                attempt: 0,
                attempt_token: None,
                started_at: None,
                completed_at: None,
                error: None,
                log_path: None,
                log: String::new(),
                truncated: false,
            })
            .collect(),
        created_at: created,
        updated_at: created,
        completed_at: None,
        revision: 1,
    };
    persist_new(&operation)?;
    start_stage(
        &app,
        registry.inner().clone(),
        &mut operation,
        0,
        false,
        &notes_path,
    )?;
    load_operation(&id)
}

#[tauri::command]
pub fn release_cancel(
    registry: State<'_, Arc<ReleaseRegistry>>,
    operation_id: String,
) -> Result<ReleaseOperation, String> {
    let operation = load_operation(&operation_id)?;
    let stage = operation
        .stages
        .iter()
        .find(|stage| stage.status == "running")
        .ok_or_else(|| "No release process is running".to_string())?;
    registry.kill(
        stage
            .attempt_token
            .as_deref()
            .ok_or_else(|| "Running attempt has no token".to_string())?,
    )?;
    Ok(operation)
}

#[tauri::command]
pub fn release_retry(
    app: AppHandle,
    registry: State<'_, Arc<ReleaseRegistry>>,
    operation_id: String,
) -> Result<ReleaseOperation, String> {
    let mut operation = load_operation(&operation_id)?;
    if operation
        .stages
        .iter()
        .any(|stage| stage.status == "running")
    {
        return Err("A release process is already running".into());
    }
    let index = operation
        .stages
        .iter()
        .position(|stage| {
            matches!(
                stage.status.as_str(),
                "failed" | "cancelled" | "interrupted"
            )
        })
        .ok_or_else(|| {
            "There is no failed, cancelled, or interrupted stage to retry".to_string()
        })?;
    repository_preflight(
        Path::new(&operation.project_path),
        &operation.target_branch,
        Some(&operation.expected_revision),
    )?;
    operation.status = "running".into();
    update_operation(&mut operation, None)?;
    let notes_path = write_notes(&operation.id, &operation.notes)?;
    start_stage(
        &app,
        registry.inner().clone(),
        &mut operation,
        index,
        true,
        &notes_path,
    )?;
    load_operation(&operation_id)
}

#[tauri::command]
pub fn release_approve(
    app: AppHandle,
    registry: State<'_, Arc<ReleaseRegistry>>,
    operation_id: String,
) -> Result<ReleaseOperation, String> {
    let mut operation = load_operation(&operation_id)?;
    let index = operation
        .stages
        .iter()
        .position(|stage| stage.status == "awaitingApproval")
        .ok_or_else(|| "No release stage is awaiting approval".to_string())?;
    operation.stages[index].status = "completed".into();
    operation.stages[index].completed_at = Some(now());
    if index + 1 == operation.stages.len() {
        complete_operation(&mut operation, "completed")?;
    } else {
        operation.status = "running".into();
        update_operation(&mut operation, None)?;
        let notes_path = write_notes(&operation.id, &operation.notes)?;
        start_stage(
            &app,
            registry.inner().clone(),
            &mut operation,
            index + 1,
            false,
            &notes_path,
        )?;
    }
    Ok(load_operation(&operation_id)?)
}

#[tauri::command]
pub fn release_abandon(operation_id: String) -> Result<ReleaseOperation, String> {
    let mut operation = load_operation(&operation_id)?;
    if operation
        .stages
        .iter()
        .any(|stage| stage.status == "running")
    {
        return Err("Cancel the running process before abandoning this release".into());
    }
    complete_operation(&mut operation, "abandoned")?;
    load_operation(&operation_id)
}

fn start_stage(
    app: &AppHandle,
    registry: Arc<ReleaseRegistry>,
    operation: &mut ReleaseOperation,
    index: usize,
    retry: bool,
    notes_path: &Path,
) -> Result<(), String> {
    let stage_config = operation.config.stages[index].clone();
    let token = uuid::Uuid::new_v4().to_string();
    let log_path = log_path(
        &operation.id,
        &stage_config.id,
        operation.stages[index].attempt + 1,
    )?;
    let now = now();
    {
        let stage = &mut operation.stages[index];
        stage.status = "running".into();
        stage.attempt += 1;
        stage.attempt_token = Some(token.clone());
        stage.started_at = Some(now);
        stage.completed_at = None;
        stage.error = None;
        stage.log_path = Some(log_path.to_string_lossy().to_string());
        stage.log.clear();
        stage.truncated = false;
    }
    operation.status = "running".into();
    update_operation(operation, None)?;
    kanban::with_connection(|connection| {
        connection.execute(
        "INSERT INTO release_attempts (token,operation_id,stage_id,kind,status,log_path,started_at) VALUES (?1,?2,?3,?4,'running',?5,?6)",
        params![token, operation.id, stage_config.id, if retry { "retry" } else { "run" }, log_path.to_string_lossy(), now],
    ).map(|_| ()).map_err(db_error)
    })?;
    let op = operation.clone();
    let app = app.clone();
    let notes_path = notes_path.to_string_lossy().to_string();
    thread::spawn(move || {
        let result = run_stage_attempt(
            &op,
            index,
            retry,
            &token,
            &log_path,
            &notes_path,
            registry.clone(),
        );
        registry.remove(&token);
        let _ = settle_attempt(&app, registry, &op.id, index, &token, result, &notes_path);
    });
    Ok(())
}

fn run_stage_attempt(
    operation: &ReleaseOperation,
    index: usize,
    retry: bool,
    token: &str,
    log_path: &Path,
    notes_path: &str,
    registry: Arc<ReleaseRegistry>,
) -> Result<String, String> {
    let root = Path::new(&operation.project_path);
    repository_preflight(
        root,
        &operation.target_branch,
        Some(&operation.expected_revision),
    )?;
    let stage = &operation.config.stages[index];
    let env = release_env(
        &operation.version,
        &operation.previous_version,
        root,
        &operation.target_branch,
        &operation.initial_revision,
        &operation.id,
        notes_path,
    );
    let execute = || -> Result<String, String> {
        if retry {
            if let Some(verify) = stage.verify.as_deref() {
                append_log(log_path, b"[Stacks: verifier-first retry]\r\n")?;
                if run_pty(verify, root, &env, token, log_path, registry.clone()).is_ok() {
                    let head = repository_preflight(root, &operation.target_branch, None)?;
                    return Ok(head);
                }
                append_log(
                    log_path,
                    b"[Stacks: verifier did not prove completion; rerunning stage]\r\n",
                )?;
                repository_preflight(
                    root,
                    &operation.target_branch,
                    Some(&operation.expected_revision),
                )?;
            }
        }
        run_pty(&stage.run, root, &env, token, log_path, registry.clone())?;
        if let Some(verify) = stage.verify.as_deref() {
            run_pty(verify, root, &env, token, log_path, registry.clone())?;
        }
        repository_preflight(root, &operation.target_branch, None)
    };
    if stage.repository_access == RepositoryAccess::Exclusive {
        repository_coordinator::global()
            .coordinate(Path::new(&operation.repository_identity), execute)
    } else {
        execute()
    }
}

fn run_pty(
    command: &str,
    cwd: &Path,
    env: &[(String, String)],
    token: &str,
    log_path: &Path,
    registry: Arc<ReleaseRegistry>,
) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut builder = CommandBuilder::new(&shell);
    builder.args(if shell.ends_with("zsh") || shell.ends_with("bash") {
        vec!["-lic", command]
    } else {
        vec!["-lc", command]
    });
    builder.cwd(cwd);
    builder.env("TERM", "xterm-256color");
    for (key, value) in env {
        builder.env(key, value);
    }
    let mut child = pair
        .slave
        .spawn_command(builder)
        .map_err(|error| error.to_string())?;
    drop(pair.slave);
    let pid = child.process_id();
    registry.insert(token.to_string(), child.clone_killer(), pid)?;
    if let Some(pid) = pid {
        kanban::with_connection(|connection| {
            connection
                .execute(
                    "UPDATE release_attempts SET pid=?1 WHERE token=?2",
                    params![pid, token],
                )
                .map(|_| ())
                .map_err(db_error)
        })?;
    }
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let path = log_path.to_path_buf();
    let output = thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let _ = append_log(&path, &buffer[..count]);
        }
    });
    let status = child.wait().map_err(|error| error.to_string())?;
    let _ = output.join();
    if status.success() {
        Ok(())
    } else {
        Err(format!("Command exited with status {}", status.exit_code()))
    }
}

fn settle_attempt(
    app: &AppHandle,
    registry: Arc<ReleaseRegistry>,
    operation_id: &str,
    index: usize,
    token: &str,
    result: Result<String, String>,
    notes_path: &str,
) -> Result<(), String> {
    let mut operation = load_operation(operation_id)?;
    if operation
        .stages
        .get(index)
        .and_then(|stage| stage.attempt_token.as_deref())
        != Some(token)
    {
        return Ok(());
    }
    let log_path = operation.stages[index].log_path.clone().unwrap_or_default();
    let (log, truncated) = read_log(Path::new(&log_path));
    let timestamp = now();
    operation.stages[index].log = log;
    operation.stages[index].truncated = truncated;
    operation.stages[index].completed_at = Some(timestamp);
    match result {
        Ok(head) => {
            operation.expected_revision = head;
            if operation.config.stages[index].approval.is_some() {
                operation.stages[index].status = "awaitingApproval".into();
                operation.status = "awaitingApproval".into();
                update_operation(&mut operation, Some(token))?;
            } else {
                operation.stages[index].status = "completed".into();
                if index + 1 == operation.stages.len() {
                    complete_operation(&mut operation, "completed")?;
                } else {
                    update_operation(&mut operation, Some(token))?;
                    start_stage(
                        app,
                        registry,
                        &mut operation,
                        index + 1,
                        false,
                        Path::new(notes_path),
                    )?;
                }
            }
        }
        Err(error) => {
            let cancelled = registry
                .cancelled
                .lock()
                .map(|mut tokens| tokens.remove(token))
                .unwrap_or(false);
            operation.stages[index].status = if cancelled { "cancelled" } else { "failed" }.into();
            operation.stages[index].error = Some(error);
            operation.status = operation.stages[index].status.clone();
            update_operation(&mut operation, Some(token))?;
        }
    }
    let attempt_status = operation.stages[index].status.clone();
    kanban::with_connection(|connection| {
        connection
            .execute(
                "UPDATE release_attempts SET status=?1,completed_at=?2 WHERE token=?3",
                params![attempt_status, now(), token],
            )
            .map(|_| ())
            .map_err(db_error)
    })?;
    let _ = app.emit("release-operation-changed", operation_id);
    Ok(())
}

fn inspect(project: &ProjectReleaseSettings, generate_notes: bool) -> Result<ReleaseDraft, String> {
    if !project.enabled {
        return Err("Releases are not enabled for this project".into());
    }
    let root = canonical_primary_checkout(&project.path)?;
    let config_path = confined_config_path(&root, &project.config_path)?;
    let bytes = fs::read(&config_path)
        .map_err(|error| format!("Could not read {}: {error}", config_path.display()))?;
    let config: ReleaseConfig = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid release configuration JSON: {error}"))?;
    validate_config(&config)?;
    let head = repository_preflight(&root, &project.target_branch, None)?;
    let base_env = release_env("", "", &root, &project.target_branch, &head, "preview", "");
    let current = run_capture(&config.current_version, &root, &base_env)?
        .trim()
        .to_string();
    if current.is_empty() {
        return Err("Current-version command returned no version".into());
    }
    let env = release_env(
        "",
        &current,
        &root,
        &project.target_branch,
        &head,
        "preview",
        "",
    );
    let suggested = config
        .suggested_version
        .as_deref()
        .map(|command| run_capture(command, &root, &env).map(|value| value.trim().to_string()))
        .transpose()?;
    let notes = if generate_notes {
        config
            .generate_notes
            .as_deref()
            .map(|command| run_capture(command, &root, &env))
            .transpose()?
    } else {
        None
    };
    Ok(ReleaseDraft {
        valid: true,
        error: None,
        config_path: config_path.to_string_lossy().to_string(),
        current_version: Some(current),
        suggested_version: suggested,
        generated_notes: notes,
        target_branch: project.target_branch.clone(),
        source_revision: Some(head),
        config: Some(config),
    })
}

fn validate_config(config: &ReleaseConfig) -> Result<(), String> {
    command_present("currentVersion", &config.current_version)?;
    if config.stages.is_empty() {
        return Err("Release configuration must contain at least one stage".into());
    }
    for (name, command) in [
        ("suggestedVersion", config.suggested_version.as_deref()),
        ("validateVersion", config.validate_version.as_deref()),
        ("generateNotes", config.generate_notes.as_deref()),
        ("preflight", config.preflight.as_deref()),
    ] {
        if let Some(command) = command {
            command_present(name, command)?;
        }
    }
    let mut ids = HashSet::new();
    for stage in &config.stages {
        if let Some(command) = stage.verify.as_deref() {
            command_present(&format!("stage {} verify", stage.id), command)?;
        }
        if stage.id.trim().is_empty() || stage.name.trim().is_empty() {
            return Err("Every release stage requires a stable ID and display name".into());
        }
        if !ids.insert(stage.id.as_str()) {
            return Err(format!("Duplicate release stage ID: {}", stage.id));
        }
        command_present(&format!("stage {} run", stage.id), &stage.run)?;
    }
    Ok(())
}
fn command_present(name: &str, command: &str) -> Result<(), String> {
    if command.trim().is_empty() {
        Err(format!("{name} command cannot be empty"))
    } else {
        Ok(())
    }
}

#[derive(Clone)]
struct ProjectReleaseSettings {
    path: String,
    target_branch: String,
    enabled: bool,
    config_path: String,
}
fn project(id: &str) -> Result<ProjectReleaseSettings, String> {
    kanban::with_connection(|connection| {
        connection.query_row("SELECT path,target_branch,releases_enabled,release_config_path FROM projects WHERE id=?1", [id], |row| Ok(ProjectReleaseSettings { path: row.get(0)?, target_branch: row.get(1)?, enabled: row.get::<_, i64>(2)? != 0, config_path: row.get(3)? })).map_err(|error| match error { rusqlite::Error::QueryReturnedNoRows => "Project not found".into(), other => db_error(other) })
    })
}

fn canonical_primary_checkout(path: &str) -> Result<PathBuf, String> {
    let configured = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("Could not resolve project path: {error}"))?;
    let top = git_output(&configured, &["rev-parse", "--show-toplevel"])?;
    let top = Path::new(top.trim())
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if configured != top {
        return Err("The project path must be the canonical repository root".into());
    }
    let git_dir = resolve_git_path(&top, &git_output(&top, &["rev-parse", "--git-dir"])?)?;
    let common = repository_coordinator::repository_identity(&top)?;
    if git_dir != common {
        return Err("Releases must run from the primary checkout, not a linked worktree".into());
    }
    Ok(top)
}
fn resolve_git_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value.trim());
    (if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    })
    .canonicalize()
    .map_err(|error| error.to_string())
}
fn confined_config_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(
            "Release config path must be repository-relative and cannot escape the project root"
                .into(),
        );
    }
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|error| format!("Could not resolve release config path: {error}"))?;
    if !path.starts_with(root) {
        return Err("Release config path escapes the canonical project root".into());
    }
    Ok(path)
}
fn repository_preflight(
    root: &Path,
    branch: &str,
    expected: Option<&str>,
) -> Result<String, String> {
    let current = git_output(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    if current.trim() != branch {
        return Err(format!(
            "Target branch {branch} must be checked out (currently {})",
            current.trim()
        ));
    }
    let git_dir = resolve_git_path(root, &git_output(root, &["rev-parse", "--git-dir"])?)?;
    for marker in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "BISECT_LOG",
        "rebase-merge",
        "rebase-apply",
    ] {
        if git_dir.join(marker).exists() {
            return Err(format!("A Git operation is active ({marker})"));
        }
    }
    let head = git_output(root, &["rev-parse", "HEAD"])?.trim().to_string();
    if let Some(expected) = expected {
        if head != expected {
            return Err(format!("HEAD changed: expected {expected}, found {head}"));
        }
    }
    if !git_output(root, &["status", "--porcelain", "--untracked-files=all"])?
        .trim()
        .is_empty()
    {
        return Err("The primary checkout must have a clean working tree".into());
    }
    Ok(head)
}
fn git_output(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn run_capture(command: &str, cwd: &Path, env: &[(String, String)]) -> Result<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut process = Command::new(&shell);
    process
        .current_dir(cwd)
        .args(if shell.ends_with("zsh") || shell.ends_with("bash") {
            vec!["-lic", command]
        } else {
            vec!["-lc", command]
        });
    for (key, value) in env {
        process.env(key, value);
    }
    let output = process.output().map_err(|error| error.to_string())?;
    if output.status.success() {
        String::from_utf8(output.stdout).map_err(|error| error.to_string())
    } else {
        Err(format!(
            "Command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}
fn release_env(
    version: &str,
    previous: &str,
    root: &Path,
    branch: &str,
    revision: &str,
    operation: &str,
    notes: &str,
) -> Vec<(String, String)> {
    vec![
        ("STACKS_RELEASE_VERSION".into(), version.into()),
        ("STACKS_RELEASE_PREVIOUS_VERSION".into(), previous.into()),
        (
            "STACKS_RELEASE_PROJECT_PATH".into(),
            root.to_string_lossy().to_string(),
        ),
        ("STACKS_RELEASE_TARGET_BRANCH".into(), branch.into()),
        ("STACKS_RELEASE_INITIAL_REVISION".into(), revision.into()),
        ("STACKS_RELEASE_OPERATION_ID".into(), operation.into()),
        ("STACKS_RELEASE_NOTES_FILE".into(), notes.into()),
    ]
}

fn persist_new(operation: &ReleaseOperation) -> Result<(), String> {
    kanban::with_connection(|connection| {
        connection.execute("INSERT INTO release_operations (id,project_id,repository_identity,status,revision,state_json,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", params![operation.id,operation.project_id,operation.repository_identity,operation.status,operation.revision,serde_json::to_string(operation).unwrap(),operation.created_at,operation.updated_at]).map(|_| ()).map_err(db_error)
    })
}
fn update_operation(
    operation: &mut ReleaseOperation,
    attempt_token: Option<&str>,
) -> Result<(), String> {
    kanban::with_connection(|connection| {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let current: Option<(i64, String)> = transaction
            .query_row(
                "SELECT revision,state_json FROM release_operations WHERE id=?1",
                [&operation.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?;
        let (revision, json) = current.ok_or_else(|| "Release operation not found".to_string())?;
        if revision != operation.revision {
            return Err("Release operation changed; reload before continuing".into());
        }
        if let Some(token) = attempt_token {
            let persisted: ReleaseOperation =
                serde_json::from_str(&json).map_err(|error| error.to_string())?;
            if !persisted
                .stages
                .iter()
                .any(|stage| stage.attempt_token.as_deref() == Some(token))
            {
                return Ok(());
            }
        }
        operation.revision += 1;
        operation.updated_at = now();
        transaction.execute("UPDATE release_operations SET status=?1,revision=?2,state_json=?3,updated_at=?4 WHERE id=?5 AND revision=?6", params![operation.status,operation.revision,serde_json::to_string(operation).unwrap(),operation.updated_at,operation.id,revision]).map_err(db_error)?;
        transaction.commit().map_err(db_error)
    })
}
fn complete_operation(operation: &mut ReleaseOperation, status: &str) -> Result<(), String> {
    operation.status = status.into();
    operation.completed_at = Some(now());
    update_operation(operation, None)
}
fn load_operation(id: &str) -> Result<ReleaseOperation, String> {
    kanban::with_connection(|connection| {
        connection
            .query_row(
                "SELECT state_json FROM release_operations WHERE id=?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .map_err(db_error)
            .and_then(|json| decode_operation(&json))
    })
}
fn decode_operation(json: &str) -> Result<ReleaseOperation, String> {
    let mut operation: ReleaseOperation =
        serde_json::from_str(json).map_err(|error| error.to_string())?;
    for stage in &mut operation.stages {
        if let Some(path) = stage.log_path.as_deref() {
            let (log, truncated) = read_log(Path::new(path));
            stage.log = log;
            stage.truncated = truncated;
        }
    }
    Ok(operation)
}
fn ensure_no_active_release(identity: &str) -> Result<(), String> {
    kanban::with_connection(|connection| {
        let active: i64 = connection.query_row("SELECT COUNT(*) FROM release_operations WHERE repository_identity=?1 AND status IN ('running','awaitingApproval','failed','cancelled','interrupted')", [identity], |row| row.get(0)).map_err(db_error)?;
        if active > 0 {
            Err("This repository already has an active release. Resume or abandon it first.".into())
        } else {
            Ok(())
        }
    })
}

fn release_dir() -> Result<PathBuf, String> {
    let path = app_data_dir()?.join("releases");
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}
fn write_notes(id: &str, notes: &str) -> Result<PathBuf, String> {
    let path = release_dir()?.join(format!("{id}-approved-notes.txt"));
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|error| error.to_string())?;
    file.write_all(notes.as_bytes())
        .map_err(|error| error.to_string())?;
    Ok(path)
}
fn log_path(operation: &str, stage: &str, attempt: i64) -> Result<PathBuf, String> {
    let safe = stage
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    Ok(release_dir()?.join(format!("{operation}-{safe}-{attempt}.log")))
}
fn append_log(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut current = fs::read(path).unwrap_or_default();
    current.extend_from_slice(bytes);
    if current.len() > MAX_LOG_BYTES {
        let keep = MAX_LOG_BYTES.saturating_sub(TRUNCATION_MARKER.len());
        current = [
            TRUNCATION_MARKER.as_bytes(),
            &current[current.len() - keep..],
        ]
        .concat();
    }
    fs::write(path, current).map_err(|error| error.to_string())
}
fn read_log(path: &Path) -> (String, bool) {
    let bytes = fs::read(path).unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes).to_string();
    let truncated = text.starts_with(TRUNCATION_MARKER.trim_start());
    (text, truncated)
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs() as i64
}
fn db_error(error: rusqlite::Error) -> String {
    format!("Release database error: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_duplicate_and_empty_stages() {
        let mut config = ReleaseConfig {
            current_version: "echo 1".into(),
            suggested_version: None,
            validate_version: None,
            generate_notes: None,
            preflight: None,
            stages: vec![],
        };
        assert!(validate_config(&config).is_err());
        config.stages = vec![stage("same"), stage("same")];
        assert!(validate_config(&config).unwrap_err().contains("Duplicate"));
    }
    #[test]
    fn rejects_unknown_fields_and_repository_access_values() {
        let unknown = r#"{"currentVersion":"true","stages":[{"id":"one","name":"One","run":"true","repositoryAccess":"read","surprise":true}]}"#;
        let access = r#"{"currentVersion":"true","stages":[{"id":"one","name":"One","run":"true","repositoryAccess":"write"}]}"#;
        assert!(serde_json::from_str::<ReleaseConfig>(unknown).is_err());
        assert!(serde_json::from_str::<ReleaseConfig>(access).is_err());
    }

    #[test]
    fn config_paths_cannot_escape() {
        let root = std::env::temp_dir();
        assert!(confined_config_path(&root, "../release.json").is_err());
        assert!(confined_config_path(&root, "/tmp/release.json").is_err());
    }
    #[test]
    fn primary_checkout_and_preflight_reject_linked_dirty_wrong_branch_and_revision() {
        let root =
            std::env::temp_dir().join(format!("stacks-release-test-{}", uuid::Uuid::new_v4()));
        let main = root.join("main");
        let linked = root.join("linked");
        fs::create_dir_all(&main).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
        ] {
            assert!(Command::new("git")
                .arg("-C")
                .arg(&main)
                .args(args)
                .status()
                .unwrap()
                .success());
        }
        fs::write(main.join("file"), "initial").unwrap();
        assert!(Command::new("git")
            .arg("-C")
            .arg(&main)
            .args(["add", "."])
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .arg("-C")
            .arg(&main)
            .args(["commit", "-m", "initial"])
            .status()
            .unwrap()
            .success());
        let head = repository_preflight(&main, "main", None).unwrap();
        assert!(repository_preflight(&main, "other", None).is_err());
        assert!(repository_preflight(&main, "main", Some("wrong")).is_err());
        fs::write(main.join("untracked"), "dirty").unwrap();
        assert!(repository_preflight(&main, "main", Some(&head)).is_err());
        fs::remove_file(main.join("untracked")).unwrap();
        assert!(Command::new("git")
            .arg("-C")
            .arg(&main)
            .args(["worktree", "add", "-b", "linked", linked.to_str().unwrap()])
            .status()
            .unwrap()
            .success());
        assert!(canonical_primary_checkout(linked.to_str().unwrap()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn release_values_are_environment_only() {
        let env = release_env(
            "v 1; echo bad",
            "old",
            Path::new("/repo"),
            "main",
            "abc",
            "op",
            "/notes",
        );
        assert_eq!(env[0].1, "v 1; echo bad");
    }
    fn stage(id: &str) -> ReleaseStageConfig {
        ReleaseStageConfig {
            id: id.into(),
            name: id.into(),
            run: "true".into(),
            verify: None,
            repository_access: RepositoryAccess::Read,
            approval: None,
        }
    }
}
