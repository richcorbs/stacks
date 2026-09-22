use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use rusqlite::{params, Connection, OptionalExtension};
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
    #[serde(
        default,
        alias = "versionValidationCommand",
        alias = "validateVersionCommand"
    )]
    pub validate_version: Option<String>,
    #[serde(
        default,
        alias = "releaseNotesCommand",
        alias = "generateReleaseNotesCommand"
    )]
    pub generate_notes: Option<String>,
    #[serde(default, alias = "preflightCommand")]
    pub preflight: Option<String>,
    #[serde(default)]
    pub reconciliation: Option<ReleaseReconciliationConfig>,
    pub stages: Vec<ReleaseStageConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseReconciliationConfig {
    pub protocol_version: u32,
    pub command: String,
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
    pub reconciliation: Option<ReleaseReconciliation>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseReconciliation {
    pub protocol_version: u32,
    pub disposition: String,
    pub requested_version: String,
    #[serde(default)]
    pub latest_published_version: Option<String>,
    #[serde(default)]
    pub source_revision: Option<String>,
    #[serde(default)]
    pub head_revision: Option<String>,
    #[serde(default)]
    pub prepared_revision: Option<String>,
    #[serde(default)]
    pub prepared_parent: Option<String>,
    #[serde(default)]
    pub approved_paths: Vec<String>,
    #[serde(default)]
    pub local_tag_revision: Option<String>,
    #[serde(default)]
    pub remote_tag_revision: Option<String>,
    #[serde(default)]
    pub release: Option<ReleaseIdentity>,
    #[serde(default)]
    pub expected_assets: Vec<String>,
    #[serde(default)]
    pub existing_assets: Vec<ArtifactEvidence>,
    #[serde(default)]
    pub missing_assets: Vec<String>,
    #[serde(default)]
    pub extra_assets: Vec<String>,
    #[serde(default)]
    pub conflicting_assets: Vec<String>,
    #[serde(default)]
    pub artifact: serde_json::Value,
    #[serde(default)]
    pub identity: serde_json::Value,
    #[serde(default)]
    pub issues: Vec<String>,
    #[serde(default)]
    pub permitted_actions: Vec<String>,
    #[serde(default)]
    pub proven_stages: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePreviewRefresh {
    pub notes: String,
    pub reconciliation: ReleaseReconciliation,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseIdentity {
    #[serde(default)]
    pub id: serde_json::Value,
    pub tag: String,
    #[serde(default)]
    pub revision: Option<String>,
    pub title: String,
    pub notes: String,
    #[serde(default)]
    pub target: String,
    pub draft: bool,
    pub prerelease: bool,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEvidence {
    pub name: String,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub digest: Option<String>,
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
    #[serde(default)]
    pub prepared_revision: Option<String>,
    #[serde(default)]
    pub prepared_parent: Option<String>,
    #[serde(default)]
    pub approved_paths: Vec<String>,
    #[serde(default)]
    pub reconciliation: Option<ReleaseReconciliation>,
    #[serde(default)]
    pub identity_fingerprint: String,
    #[serde(default)]
    pub artifact_evidence: serde_json::Value,
    #[serde(default)]
    pub release_url: Option<String>,
    #[serde(default)]
    pub adopted: bool,
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

#[derive(Clone)]
struct ExecutionOutcome {
    head: Option<String>,
    error: Option<String>,
}

enum AttemptPhase {
    Executing(Option<LiveReleaseProcess>),
    Settling(ExecutionOutcome),
    SettlementFailed(ExecutionOutcome, String),
    Recovering,
}

#[derive(Default)]
pub struct ReleaseRegistry {
    attempts: Mutex<HashMap<String, AttemptPhase>>,
    cancelled: Mutex<HashSet<String>>,
}

impl ReleaseRegistry {
    fn begin(&self, token: String) -> Result<(), String> {
        self.attempts
            .lock()
            .map_err(|_| "Release process registry failed".to_string())?
            .insert(token, AttemptPhase::Executing(None));
        Ok(())
    }
    fn attach_process(&self, token: &str, mut process: LiveReleaseProcess) -> Result<(), String> {
        let mut attempts = self
            .attempts
            .lock()
            .map_err(|_| "Release process registry failed".to_string())?;
        match attempts.get_mut(token) {
            Some(AttemptPhase::Executing(slot)) => {
                if self
                    .cancelled
                    .lock()
                    .map_err(|_| "Release process registry failed".to_string())?
                    .contains(token)
                {
                    let _ = terminate_release_process(&mut process);
                    return Err("Release attempt was cancelled before process launch".into());
                }
                *slot = Some(process);
                Ok(())
            }
            _ => Err("Release attempt ownership changed before process launch".into()),
        }
    }
    fn detach_process(&self, token: &str) {
        if let Ok(mut attempts) = self.attempts.lock() {
            if let Some(AttemptPhase::Executing(process)) = attempts.get_mut(token) {
                *process = None;
            }
        }
    }
    fn execution_finished(&self, token: &str, outcome: ExecutionOutcome) {
        if let Ok(mut attempts) = self.attempts.lock() {
            if matches!(attempts.get(token), Some(AttemptPhase::Executing(_))) {
                attempts.insert(token.to_string(), AttemptPhase::Settling(outcome));
            }
        }
    }
    fn settlement_failed(&self, token: &str, error: String) {
        if let Ok(mut attempts) = self.attempts.lock() {
            let outcome = match attempts.remove(token) {
                Some(AttemptPhase::Settling(outcome))
                | Some(AttemptPhase::SettlementFailed(outcome, _)) => outcome,
                _ => ExecutionOutcome {
                    head: None,
                    error: Some(
                        "Execution outcome was unavailable during settlement recovery".into(),
                    ),
                },
            };
            attempts.insert(
                token.to_string(),
                AttemptPhase::SettlementFailed(outcome, error),
            );
        }
    }
    fn remove(&self, token: &str) {
        if let Ok(mut guard) = self.attempts.lock() {
            guard.remove(token);
        }
    }
    fn actively_owned(&self, token: &str) -> bool {
        self.attempts
            .lock()
            .map(|attempts| {
                matches!(
                    attempts.get(token),
                    Some(AttemptPhase::Executing(_)) | Some(AttemptPhase::Settling(_))
                )
            })
            .unwrap_or(false)
    }
    fn claim_recovery(
        &self,
        token: &str,
    ) -> Result<Option<(Option<ExecutionOutcome>, Option<String>)>, String> {
        let mut attempts = self
            .attempts
            .lock()
            .map_err(|_| "Release process registry failed".to_string())?;
        match attempts.remove(token) {
            Some(AttemptPhase::Executing(process)) => {
                attempts.insert(token.into(), AttemptPhase::Executing(process));
                Ok(None)
            }
            Some(AttemptPhase::Settling(outcome)) => {
                attempts.insert(token.into(), AttemptPhase::Settling(outcome));
                Ok(None)
            }
            Some(AttemptPhase::Recovering) => {
                attempts.insert(token.into(), AttemptPhase::Recovering);
                Ok(None)
            }
            Some(AttemptPhase::SettlementFailed(outcome, error)) => {
                attempts.insert(token.into(), AttemptPhase::Recovering);
                Ok(Some((Some(outcome), Some(error))))
            }
            None => {
                attempts.insert(token.into(), AttemptPhase::Recovering);
                Ok(Some((None, None)))
            }
        }
    }
    fn kill(&self, token: &str) -> Result<bool, String> {
        let mut attempts = self
            .attempts
            .lock()
            .map_err(|_| "Release process registry failed".to_string())?;
        match attempts.get_mut(token) {
            Some(AttemptPhase::Executing(process)) => {
                if let Some(process) = process.as_mut() {
                    terminate_release_process(process)
                        .map_err(|error| format!("Could not cancel release process: {error}"))?;
                }
                self.cancelled
                    .lock()
                    .map_err(|_| "Release process registry failed".to_string())?
                    .insert(token.to_string());
                Ok(true)
            }
            _ => Ok(false),
        }
    }
    pub fn shutdown(&self) {
        if let Ok(mut attempts) = self.attempts.lock() {
            for attempt in attempts.values_mut() {
                if let AttemptPhase::Executing(Some(process)) = attempt {
                    let _ = terminate_release_process(process);
                }
            }
            attempts.clear();
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
                    if libc::kill(group, 0) != 0 {
                        return Ok(());
                    }
                    thread::sleep(Duration::from_millis(25));
                }
                if libc::kill(group, 0) == 0 {
                    libc::kill(group, libc::SIGKILL);
                }
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
    // SQLite has no `ADD COLUMN IF NOT EXISTS`; duplicate-column errors mean the
    // journal is already current, while every other migration error is fatal.
    for column in [
        "execution_status TEXT NOT NULL DEFAULT 'executing'",
        "execution_head TEXT",
        "execution_error TEXT",
        "settlement_error TEXT",
        "recovery_error TEXT",
    ] {
        if let Err(error) = connection.execute(
            &format!("ALTER TABLE release_attempts ADD COLUMN {column}"),
            [],
        ) {
            if !error.to_string().contains("duplicate column name") {
                return Err(db_error(error));
            }
        }
    }
    connection.execute("UPDATE release_attempts SET execution_status=CASE WHEN status='running' THEN 'executing' ELSE 'settled' END WHERE execution_status IS NULL OR execution_status='' OR (execution_status='executing' AND status!='running')", []).map_err(db_error)?;
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
            reconciliation: None,
        }),
    }
}

#[tauri::command]
pub fn release_reconcile_preview(
    project_id: String,
    version: String,
    notes: String,
) -> Result<ReleasePreviewRefresh, String> {
    let project = project(&project_id)?;
    let draft = inspect(&project, false)?;
    let config = draft
        .config
        .ok_or_else(|| "Release configuration is unavailable".to_string())?;
    let previous = draft
        .current_version
        .ok_or_else(|| "Current version is unavailable".to_string())?;
    let root = canonical_primary_checkout(&project.path)?;
    let head = repository_preflight(&root, &project.target_branch, None)?;
    let notes_path = write_notes("preview-user", &notes)?;
    let env = release_env(
        version.trim(),
        &previous,
        &root,
        &project.target_branch,
        &head,
        "preview",
        notes_path.to_string_lossy().as_ref(),
    );
    refresh_release_preview(&config, &root, &env, &notes_path, notes)
}

#[tauri::command]
pub fn release_history(
    app: AppHandle,
    registry: State<'_, Arc<ReleaseRegistry>>,
    project_id: String,
) -> Result<Vec<ReleaseOperation>, String> {
    recover_project_orphans(&app, registry.inner(), &project_id)?;
    kanban::with_read_connection(|connection| {
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
    let reconciliation = reconcile(&config, &root, &command_env)?;
    require_action(&reconciliation, &["start", "resume", "complete", "approve"])?;
    if reconciliation
        .as_ref()
        .map(|item| item.disposition.as_str())
        .unwrap_or("available")
        == "available"
    {
        if let Some(command) = config.validate_version.as_deref() {
            run_capture(command, &root, &command_env)?;
        }
        if let Some(command) = config.preflight.as_deref() {
            run_capture(command, &root, &command_env)?;
        }
    }
    let source_revision = reconciliation
        .as_ref()
        .and_then(|item| item.source_revision.clone())
        .unwrap_or_else(|| head.clone());
    let proven = reconciliation
        .as_ref()
        .map(|item| item.proven_stages.clone())
        .unwrap_or_default();
    let disposition = reconciliation
        .as_ref()
        .map(|item| item.disposition.as_str())
        .unwrap_or("available");
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
        initial_revision: source_revision,
        expected_revision: head,
        prepared_revision: reconciliation
            .as_ref()
            .and_then(|item| item.prepared_revision.clone()),
        prepared_parent: reconciliation
            .as_ref()
            .and_then(|item| item.prepared_parent.clone()),
        approved_paths: reconciliation
            .as_ref()
            .map(|item| item.approved_paths.clone())
            .unwrap_or_default(),
        reconciliation: reconciliation.clone(),
        identity_fingerprint: reconciliation
            .as_ref()
            .map(|item| identity_fingerprint(&config, item))
            .unwrap_or_default(),
        artifact_evidence: reconciliation
            .as_ref()
            .map(|item| item.artifact.clone())
            .unwrap_or(serde_json::Value::Null),
        release_url: reconciliation
            .as_ref()
            .and_then(|item| item.release.as_ref())
            .and_then(|release| release.url.clone()),
        adopted: disposition != "available",
        status: if disposition == "published" {
            "completed"
        } else if disposition == "resumableDraft" && proven.iter().any(|id| id == "draft") {
            "awaitingApproval"
        } else {
            "running"
        }
        .into(),
        stages: config
            .stages
            .iter()
            .map(|stage| ReleaseStageState {
                id: stage.id.clone(),
                name: stage.name.clone(),
                status: if proven.iter().any(|id| id == &stage.id) {
                    if stage.approval.is_some() && disposition != "published" {
                        "awaitingApproval"
                    } else {
                        "completed"
                    }
                } else {
                    "pending"
                }
                .into(),
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
        completed_at: if disposition == "published" {
            Some(created)
        } else {
            None
        },
        revision: 1,
    };
    persist_new(&operation)?;
    if operation.status == "running" {
        let index = operation
            .stages
            .iter()
            .position(|stage| stage.status == "pending")
            .ok_or_else(|| "Reconciliation did not identify a stage to resume".to_string())?;
        start_stage(
            &app,
            registry.inner().clone(),
            &mut operation,
            index,
            false,
            &notes_path,
        )?;
    }
    load_operation(&id)
}

#[tauri::command]
pub fn release_cancel(
    app: AppHandle,
    registry: State<'_, Arc<ReleaseRegistry>>,
    operation_id: String,
) -> Result<ReleaseOperation, String> {
    let operation = load_operation(&operation_id)?;
    let stage = operation
        .stages
        .iter()
        .find(|stage| stage.status == "running")
        .ok_or_else(|| "No release process is running".to_string())?;
    let token = stage
        .attempt_token
        .as_deref()
        .ok_or_else(|| "Running attempt has no token".to_string())?;
    if registry.kill(token)? {
        return Ok(operation);
    }
    recover_orphan(&app, registry.inner(), &operation_id)?;
    load_operation(&operation_id)
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
    if !matches!(
        operation.status.as_str(),
        "failed" | "cancelled" | "interrupted"
    ) {
        return Err("There is no failed, cancelled, or interrupted release to retry".into());
    }
    let root = Path::new(&operation.project_path);
    repository_preflight(root, &operation.target_branch, None)?;
    let notes_path = write_notes(&operation.id, &operation.notes)?;
    let env = release_env(
        &operation.version,
        &operation.previous_version,
        root,
        &operation.target_branch,
        &operation.initial_revision,
        &operation.id,
        notes_path.to_string_lossy().as_ref(),
    );
    let evidence = reconcile(&operation.config, root, &env)?;
    require_action(&evidence, &["retry", "resume", "approve", "complete"])?;
    if let Some(evidence) = evidence {
        validate_recovery_evidence(&operation, &evidence)?;
        apply_proven_evidence(&mut operation, &evidence);
        if evidence.disposition == "published" {
            operation.reconciliation = Some(evidence);
            complete_operation(&mut operation, "completed")?;
            return load_operation(&operation_id);
        }
        operation.reconciliation = Some(evidence);
    }
    if operation
        .stages
        .iter()
        .any(|stage| stage.status == "awaitingApproval")
    {
        operation.status = "awaitingApproval".into();
        update_operation(&mut operation, None)?;
        return load_operation(&operation_id);
    }
    let index = operation
        .stages
        .iter()
        .position(|stage| stage.status != "completed")
        .ok_or_else(|| "Reconciliation proved all stages complete".to_string())?;
    operation.status = "running".into();
    update_operation(&mut operation, None)?;
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
    let root = Path::new(&operation.project_path);
    repository_preflight(root, &operation.target_branch, None)?;
    let notes_path = write_notes(&operation.id, &operation.notes)?;
    let env = release_env(
        &operation.version,
        &operation.previous_version,
        root,
        &operation.target_branch,
        &operation.initial_revision,
        &operation.id,
        notes_path.to_string_lossy().as_ref(),
    );
    let evidence = reconcile(&operation.config, root, &env)?;
    require_action(&evidence, &["approve", "complete"])?;
    if let Some(evidence) = evidence {
        operation.release_url = evidence
            .release
            .as_ref()
            .and_then(|release| release.url.clone());
        operation.reconciliation = Some(evidence);
    }
    operation.stages[index].status = "completed".into();
    operation.stages[index].completed_at = Some(now());
    if index + 1 == operation.stages.len() {
        complete_operation(&mut operation, "completed")?;
    } else {
        operation.status = "running".into();
        update_operation(&mut operation, None)?;
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
pub fn release_refresh(operation_id: String) -> Result<ReleaseOperation, String> {
    let mut operation = load_operation(&operation_id)?;
    let root = Path::new(&operation.project_path);
    repository_preflight(root, &operation.target_branch, None)?;
    let notes_path = write_notes(&operation.id, &operation.notes)?;
    let env = release_env(
        &operation.version,
        &operation.previous_version,
        root,
        &operation.target_branch,
        &operation.initial_revision,
        &operation.id,
        notes_path.to_string_lossy().as_ref(),
    );
    let evidence = reconcile(&operation.config, root, &env)?
        .ok_or_else(|| "This release configuration has no reconciliation command".to_string())?;
    operation.release_url = evidence
        .release
        .as_ref()
        .and_then(|release| release.url.clone());
    operation.reconciliation = Some(evidence.clone());
    if evidence.disposition == "published" {
        complete_operation(&mut operation, "completed")?;
    } else {
        update_operation(&mut operation, None)?;
    }
    load_operation(&operation_id)
}

#[tauri::command]
pub fn release_recover_prepared(operation_id: String) -> Result<ReleaseOperation, String> {
    let mut operation = load_operation(&operation_id)?;
    if operation
        .stages
        .iter()
        .any(|stage| stage.status == "running")
    {
        return Err("Cancel the running process before recovery".into());
    }
    let root = PathBuf::from(&operation.project_path);
    let identity = PathBuf::from(&operation.repository_identity);
    repository_coordinator::global().coordinate(&identity, || {
        let head = repository_preflight(&root, &operation.target_branch, operation.prepared_revision.as_deref())?;
        let prepared = operation.prepared_revision.clone().ok_or_else(|| "No proven generated release commit is recorded".to_string())?;
        let parent = operation.prepared_parent.clone().ok_or_else(|| "No proven release parent is recorded".to_string())?;
        if parent != operation.initial_revision || git_output(&root, &["rev-parse", &format!("{prepared}^")])?.trim() != parent { return Err("The generated commit no longer directly follows the captured source revision".into()); }
        let changed = git_output(&root, &["diff", "--name-only", &parent, &prepared])?;
        let approved: HashSet<&str> = operation.approved_paths.iter().map(String::as_str).collect();
        let unexpected: Vec<&str> = changed.lines().filter(|path| !approved.contains(path)).collect();
        if unexpected.len() > 0 { return Err(format!("Generated commit changes unapproved paths: {}", unexpected.join(", "))); }
        let notes_path = write_notes(&operation.id, &operation.notes)?;
        let env = release_env(&operation.version, &operation.previous_version, &root, &operation.target_branch, &operation.initial_revision, &operation.id, notes_path.to_string_lossy().as_ref());
        let evidence = reconcile(&operation.config, &root, &env)?.ok_or_else(|| "Recovery requires reconciliation evidence".to_string())?;
        require_action(&Some(evidence.clone()), &["recover"])?;
        let refs = git_output(&root, &["ls-remote", "origin"])?;
        git_output(&root, &["fetch", "--prune", "origin"])?;
        for line in refs.lines() {
            let Some((revision, name)) = line.split_once(char::is_whitespace) else { continue; };
            if name.ends_with("^{}") { continue; }
            if git_output(&root, &["cat-file", "-e", &format!("{revision}^{{commit}}")]).is_err() { return Err(format!("Cannot resolve advertised remote ref {name}; recovery made no changes")); }
            let status = Command::new("git").arg("-C").arg(&root).args(["merge-base", "--is-ancestor", &prepared, revision]).status().map_err(|error| error.to_string())?;
            if status.success() { return Err(format!("Prepared commit is reachable from advertised remote ref {name}; cancel remote state manually, then refresh")); }
            if status.code() != Some(1) { return Err(format!("Could not prove ancestry for advertised remote ref {name}; recovery made no changes")); }
        }
        let tag = format!("v{}", operation.version); let local_tag = git_output(&root, &["rev-parse", "--verify", &format!("refs/tags/{tag}^{{commit}}")]).ok().map(|value| value.trim().to_string());
        if local_tag.as_deref().is_some_and(|revision| revision != prepared) { return Err(format!("Local tag {tag} points elsewhere; recovery made no changes")); }
        if evidence.remote_tag_revision.is_some() || evidence.release.is_some() { return Err("Remote tag or GitHub release still claims this version; recovery made no changes".into()); }
        // Every proof above is read-only. Mutations begin here and target only the proven identity.
        if local_tag.is_some() { git_output(&root, &["tag", "-d", &tag]).map_err(|error| format!("Recovery partially failed deleting {tag}: {error}; HEAD remains {head}"))?; }
        git_output(&root, &["reset", "--hard", &operation.initial_revision]).map_err(|error| format!("Recovery partially failed resetting the branch: {error}; inspect HEAD and local tag {tag}"))?;
        let artifacts = root.join("release-artifacts").join(&tag);
        if artifacts.exists() { fs::remove_dir_all(&artifacts).map_err(|error| format!("Branch reset succeeded but artifact cleanup failed at {}: {error}", artifacts.display()))?; }
        repository_preflight(&root, &operation.target_branch, Some(&operation.initial_revision))?;
        operation.reconciliation = Some(evidence); complete_operation(&mut operation, "abandoned")
    })?;
    load_operation(&operation_id)
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
    // Publish ownership before exposing a persisted running stage so history
    // polling cannot claim an attempt while its worker is being launched.
    registry.begin(token.clone())?;
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
    if let Err(error) = update_operation(operation, None) {
        registry.remove(&token);
        return Err(error);
    }
    if let Err(error) = kanban::with_write_connection(|connection| {
        connection.execute(
        "INSERT INTO release_attempts (token,operation_id,stage_id,kind,status,execution_status,log_path,started_at) VALUES (?1,?2,?3,?4,'running','executing',?5,?6)",
        params![token, operation.id, stage_config.id, if retry { "retry" } else { "run" }, log_path.to_string_lossy(), now],
    ).map(|_| ()).map_err(db_error)
    }) {
        registry.remove(&token);
        return Err(error);
    }
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
        let outcome = match &result {
            Ok(head) => ExecutionOutcome {
                head: Some(head.clone()),
                error: None,
            },
            Err(error) => ExecutionOutcome {
                head: None,
                error: Some(error.clone()),
            },
        };
        registry.execution_finished(&token, outcome.clone());
        let checkpoint_error = checkpoint_execution(&token, &outcome).err();
        if let Err(error) = settle_attempt(
            &app,
            registry.clone(),
            &op.id,
            index,
            &token,
            result,
            &notes_path,
        ) {
            let diagnostic = match checkpoint_error {
                Some(checkpoint) => format!("Persistence failed while checkpointing execution: {checkpoint}; settlement failed: {error}"),
                None => format!("Settlement failed: {error}"),
            };
            let _ = append_log(
                &log_path,
                format!("\r\n[Stacks: {diagnostic}]\r\n").as_bytes(),
            );
            registry.settlement_failed(&token, diagnostic.clone());
            let _ = record_settlement_failure(&token, &diagnostic);
            let _ = app.emit("release-operation-changed", &op.id);
        } else {
            registry.remove(&token);
        }
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
    let expected = if operation
        .reconciliation
        .as_ref()
        .and_then(|item| item.release.as_ref())
        .is_some()
    {
        None
    } else {
        Some(operation.expected_revision.as_str())
    };
    repository_preflight(root, &operation.target_branch, expected)?;
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
    let fresh = reconcile(&operation.config, root, &env)?;
    require_action(&fresh, &["start", "resume", "approve", "complete"])?;
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
                repository_preflight(root, &operation.target_branch, expected)?;
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
    registry.attach_process(
        token,
        LiveReleaseProcess {
            killer: child.clone_killer(),
            pid,
        },
    )?;
    if let Some(pid) = pid {
        kanban::with_write_connection(|connection| {
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
    let waited = child.wait().map_err(|error| error.to_string());
    registry.detach_process(token);
    let status = waited?;
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
    let result = result.and_then(|head| {
        let root = Path::new(&operation.project_path);
        let env = release_env(
            &operation.version,
            &operation.previous_version,
            root,
            &operation.target_branch,
            &operation.initial_revision,
            &operation.id,
            notes_path,
        );
        let evidence = reconcile(&operation.config, root, &env)
            .map_err(|error| format!("Post-stage reconciliation failed: {error}"))?
            .ok_or_else(|| "Post-stage reconciliation returned no evidence".to_string())?;
        validate_recovery_evidence(&operation, &evidence)
            .map_err(|error| format!("Post-stage verification failed: {error}"))?;
        apply_proven_evidence(&mut operation, &evidence);
        operation.reconciliation = Some(evidence);
        Ok(head)
    });
    match result {
        Ok(head) => {
            operation.expected_revision = head;
            if operation.config.stages[index].approval.is_some() {
                operation.stages[index].status = "awaitingApproval".into();
                operation.status = "awaitingApproval".into();
                persist_attempt_settlement(&mut operation, token, "awaitingApproval")?;
            } else {
                operation.stages[index].status = "completed".into();
                if index + 1 == operation.stages.len() {
                    operation.status = "completed".into();
                    operation.completed_at = Some(now());
                    persist_attempt_settlement(&mut operation, token, "completed")?;
                } else {
                    persist_attempt_settlement(&mut operation, token, "completed")?;
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
            let root = Path::new(&operation.project_path);
            let env = release_env(
                &operation.version,
                &operation.previous_version,
                root,
                &operation.target_branch,
                &operation.initial_revision,
                &operation.id,
                notes_path,
            );
            let mut diagnostic = if error.starts_with("Post-stage") {
                error.clone()
            } else {
                format!("Command execution failed: {error}")
            };
            match reconcile(&operation.config, root, &env) {
                Ok(Some(evidence)) => match validate_recovery_evidence(&operation, &evidence) {
                    Ok(()) => {
                        apply_proven_evidence(&mut operation, &evidence);
                        operation.reconciliation = Some(evidence);
                    }
                    Err(recovery) => diagnostic
                        .push_str(&format!("\nPost-stage verification failed: {recovery}")),
                },
                Ok(None) => diagnostic.push_str("\nPost-stage reconciliation returned no evidence"),
                Err(recovery) => {
                    diagnostic.push_str(&format!("\nPost-stage reconciliation failed: {recovery}"))
                }
            }
            let cancelled = registry
                .cancelled
                .lock()
                .map(|mut tokens| tokens.remove(token))
                .unwrap_or(false);
            operation.stages[index].status = if cancelled { "cancelled" } else { "failed" }.into();
            operation.stages[index].error = Some(diagnostic);
            operation.status = operation.stages[index].status.clone();
            let status = operation.status.clone();
            persist_attempt_settlement(&mut operation, token, &status)?;
        }
    }
    let _ = app.emit("release-operation-changed", operation_id);
    Ok(())
}

fn checkpoint_execution(token: &str, outcome: &ExecutionOutcome) -> Result<(), String> {
    kanban::with_write_connection(|connection| {
        connection.execute(
        "UPDATE release_attempts SET execution_status='completed',execution_head=?1,execution_error=?2 WHERE token=?3 AND status='running'",
        params![outcome.head, outcome.error, token],
    ).map(|_| ()).map_err(db_error)
    })
}

fn record_settlement_failure(token: &str, error: &str) -> Result<(), String> {
    kanban::with_write_connection(|connection| {
        connection.execute(
        "UPDATE release_attempts SET status='settlementFailed',execution_status='completed',settlement_error=?1 WHERE token=?2",
        params![error, token],
    ).map(|_| ()).map_err(db_error)
    })
}

fn persist_attempt_settlement(
    operation: &mut ReleaseOperation,
    token: &str,
    attempt_status: &str,
) -> Result<(), String> {
    persist_attempt_state(operation, token, attempt_status, None, true)
}

fn persist_attempt_state(
    operation: &mut ReleaseOperation,
    token: &str,
    attempt_status: &str,
    recovery_error: Option<&str>,
    clear_settlement_error: bool,
) -> Result<(), String> {
    kanban::with_write_connection(|connection| {
        persist_attempt_state_in_transaction(
            connection,
            operation,
            token,
            attempt_status,
            recovery_error,
            clear_settlement_error,
        )
    })
}

fn persist_attempt_state_in_transaction(
    connection: &Connection,
    operation: &mut ReleaseOperation,
    token: &str,
    attempt_status: &str,
    recovery_error: Option<&str>,
    clear_settlement_error: bool,
) -> Result<(), String> {
    let revision: i64 = connection
        .query_row(
            "SELECT revision FROM release_operations WHERE id=?1",
            [&operation.id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if revision != operation.revision {
        return Err(
            "Persistence failed: release operation changed before attempt settlement".into(),
        );
    }
    operation.revision += 1;
    operation.updated_at = now();
    let changed = connection.execute(
            "UPDATE release_operations SET status=?1,revision=?2,state_json=?3,updated_at=?4 WHERE id=?5 AND revision=?6",
            params![operation.status, operation.revision, serde_json::to_string(operation).map_err(|error| error.to_string())?, operation.updated_at, operation.id, revision],
        ).map_err(db_error)?;
    if changed != 1 {
        return Err("Persistence failed: attempt settlement lost its revision claim".into());
    }
    let changed = connection.execute(
            "UPDATE release_attempts SET status=?1,execution_status='settled',completed_at=?2,recovery_error=?4,settlement_error=CASE WHEN ?5 THEN NULL ELSE settlement_error END WHERE token=?3",
            params![attempt_status, now(), token, recovery_error, clear_settlement_error],
        ).map_err(db_error)?;
    if changed != 1 {
        return Err("Persistence failed: release attempt was not found during settlement".into());
    }
    Ok(())
}

fn persist_recovery_settlement(
    registry: &ReleaseRegistry,
    operation: &mut ReleaseOperation,
    token: &str,
    status: &str,
) -> Result<(), String> {
    let recovery_error = operation
        .stages
        .iter()
        .find(|stage| stage.attempt_token.as_deref() == Some(token))
        .and_then(|stage| stage.error.clone());
    persist_attempt_state(operation, token, status, recovery_error.as_deref(), false).map_err(
        |error| {
            let diagnostic = format!("Persistence failed during recovery settlement: {error}");
            registry.settlement_failed(token, diagnostic.clone());
            let _ = record_settlement_failure(token, &diagnostic);
            diagnostic
        },
    )
}

fn apply_proven_evidence(operation: &mut ReleaseOperation, evidence: &ReleaseReconciliation) {
    operation.prepared_revision = evidence
        .prepared_revision
        .clone()
        .or_else(|| operation.prepared_revision.clone());
    operation.prepared_parent = evidence
        .prepared_parent
        .clone()
        .or_else(|| operation.prepared_parent.clone());
    if operation.approved_paths.is_empty() {
        operation.approved_paths = evidence.approved_paths.clone();
    }
    if operation
        .artifact_evidence
        .get("valid")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
        && evidence
            .artifact
            .get("valid")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
    {
        // Capture the first proven artifact set; later reconciliation may only
        // validate it, never replace it.
        operation.artifact_evidence = evidence.artifact.clone();
    }
    operation.release_url = evidence
        .release
        .as_ref()
        .and_then(|release| release.url.clone())
        .or_else(|| operation.release_url.clone());
    for stage in &mut operation.stages {
        if evidence.proven_stages.iter().any(|id| id == &stage.id) {
            let approval = operation
                .config
                .stages
                .iter()
                .find(|item| item.id == stage.id)
                .is_some_and(|item| item.approval.is_some());
            stage.status = if approval && evidence.disposition != "published" {
                "awaitingApproval"
            } else {
                "completed"
            }
            .into();
            stage.completed_at.get_or_insert_with(now);
        }
    }
}

fn validate_recovery_evidence(
    operation: &ReleaseOperation,
    evidence: &ReleaseReconciliation,
) -> Result<(), String> {
    if evidence.requested_version != operation.version {
        return Err("Reconciliation version conflicts with the captured release".into());
    }
    if evidence
        .source_revision
        .as_deref()
        .is_some_and(|source| source != operation.initial_revision)
    {
        return Err(
            "Reconciliation source revision conflicts with the captured source revision".into(),
        );
    }
    if evidence
        .prepared_parent
        .as_deref()
        .is_some_and(|parent| parent != operation.initial_revision)
    {
        return Err(
            "Prepared revision does not directly follow the captured source revision".into(),
        );
    }
    let expected_tag = format!("v{}", operation.version);
    let expected_title = format!("Stacks {expected_tag}");
    let identity = &evidence.identity;
    for (field, expected) in [
        ("tag", expected_tag.as_str()),
        ("title", expected_title.as_str()),
        ("notes", operation.notes.as_str()),
        ("targetBranch", operation.target_branch.as_str()),
    ] {
        if identity.get(field).and_then(serde_json::Value::as_str) != Some(expected) {
            return Err(format!(
                "Reconciliation identity {field} conflicts with the captured release"
            ));
        }
    }
    if identity.get("draft").and_then(serde_json::Value::as_bool) != Some(true)
        || identity
            .get("prerelease")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
    {
        return Err(
            "Reconciliation draft/prerelease properties conflict with the captured release".into(),
        );
    }
    if let Some(release) = evidence.release.as_ref() {
        if release.tag != expected_tag
            || release.title != expected_title
            || release.notes != operation.notes
            || !release.draft
            || release.prerelease
        {
            return Err("Existing release identity conflicts with the captured release".into());
        }
        let intended = evidence
            .prepared_revision
            .as_deref()
            .unwrap_or(&operation.initial_revision);
        if release
            .revision
            .as_deref()
            .is_some_and(|revision| revision != intended)
            || (!release.target.is_empty() && release.target != intended)
        {
            return Err("Existing release revision conflicts with the captured release".into());
        }
    }
    if let Some(captured) = operation.reconciliation.as_ref() {
        let expected: HashSet<&str> = captured
            .expected_assets
            .iter()
            .map(String::as_str)
            .collect();
        let fresh: HashSet<&str> = evidence
            .expected_assets
            .iter()
            .map(String::as_str)
            .collect();
        if expected != fresh {
            return Err("Expected artifact set changed since the release was captured".into());
        }
        // Fingerprints created by this lifecycle use stable identity properties;
        // legacy fingerprints are deliberately tolerated and then constrained by
        // the explicit comparisons above.
        let captured_fingerprint = identity_fingerprint(&operation.config, captured);
        if operation.identity_fingerprint == captured_fingerprint
            && identity_fingerprint(&operation.config, evidence) != captured_fingerprint
        {
            return Err("Release identity fingerprint changed during reconciliation".into());
        }
    }
    if operation
        .artifact_evidence
        .get("valid")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
        && operation.artifact_evidence.get("assets") != evidence.artifact.get("assets")
    {
        return Err("Captured artifact evidence conflicts with fresh reconciliation".into());
    }
    let intended = evidence
        .prepared_revision
        .as_deref()
        .unwrap_or(&operation.initial_revision);
    if evidence
        .local_tag_revision
        .as_deref()
        .is_some_and(|revision| revision != intended)
        || evidence
            .remote_tag_revision
            .as_deref()
            .is_some_and(|revision| revision != intended)
    {
        return Err(
            "A release tag points to a revision other than the captured release revision".into(),
        );
    }
    if evidence.proven_stages.iter().any(|id| {
        operation
            .config
            .stages
            .iter()
            .find(|stage| &stage.id == id)
            .is_none()
    }) {
        return Err("Reconciliation claimed an unknown release stage".into());
    }
    Ok(())
}

fn recover_project_orphans(
    app: &AppHandle,
    registry: &Arc<ReleaseRegistry>,
    project_id: &str,
) -> Result<(), String> {
    let ids = kanban::with_read_connection(|connection| {
        let mut statement = connection
            .prepare("SELECT id FROM release_operations WHERE project_id=?1 AND status='running'")
            .map_err(db_error)?;
        let rows = statement
            .query_map([project_id], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    })?;
    for id in ids {
        recover_orphan(app, registry, &id)?;
    }
    Ok(())
}

fn recover_orphan(
    app: &AppHandle,
    registry: &Arc<ReleaseRegistry>,
    operation_id: &str,
) -> Result<(), String> {
    let mut operation = load_operation(operation_id)?;
    let Some(index) = operation
        .stages
        .iter()
        .position(|stage| stage.status == "running")
    else {
        return Ok(());
    };
    let token = operation.stages[index]
        .attempt_token
        .clone()
        .ok_or_else(|| "Running attempt has no token".to_string())?;
    if registry.actively_owned(&token) {
        return Ok(());
    }
    let Some((outcome, registry_error)) = registry.claim_recovery(&token)? else {
        return Ok(());
    };
    let journal = kanban::with_read_connection(|connection| {
        connection.query_row(
        "SELECT execution_head,execution_error,settlement_error FROM release_attempts WHERE token=?1", [&token],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?)),
    ).optional().map_err(db_error)
    })?;
    let mut diagnostics = Vec::new();
    if let Some(error) = registry_error {
        diagnostics.push(error);
    }
    if let Some(outcome) = outcome {
        if let Some(error) = outcome.error {
            diagnostics.push(format!("Command execution failed: {error}"));
        }
    }
    if let Some((_, execution_error, settlement_error)) = journal {
        if let Some(error) = execution_error {
            diagnostics.push(format!("Command execution failed: {error}"));
        }
        if let Some(error) = settlement_error {
            diagnostics.push(error);
        }
    }
    let notes_path = write_notes(&operation.id, &operation.notes)?;
    let env = release_env(
        &operation.version,
        &operation.previous_version,
        Path::new(&operation.project_path),
        &operation.target_branch,
        &operation.initial_revision,
        &operation.id,
        notes_path.to_string_lossy().as_ref(),
    );
    let recovered = reconcile(&operation.config, Path::new(&operation.project_path), &env)
        .map_err(|error| format!("Recovery reconciliation failed: {error}"))
        .and_then(|evidence| {
            evidence.ok_or_else(|| "Recovery reconciliation returned no evidence".into())
        })
        .and_then(|evidence| {
            validate_recovery_evidence(&operation, &evidence)?;
            Ok(evidence)
        });
    match recovered {
        Ok(evidence) => {
            apply_proven_evidence(&mut operation, &evidence);
            operation.reconciliation = Some(evidence.clone());
            let approval_proven = operation
                .config
                .stages
                .iter()
                .filter(|stage| stage.approval.is_some())
                .any(|stage| evidence.proven_stages.contains(&stage.id));
            let expected_assets: HashSet<&str> = evidence
                .expected_assets
                .iter()
                .map(String::as_str)
                .collect();
            let existing_assets: HashSet<&str> = evidence
                .existing_assets
                .iter()
                .map(|asset| asset.name.as_str())
                .collect();
            let exact_assets = evidence.missing_assets.is_empty()
                && evidence.extra_assets.is_empty()
                && evidence.conflicting_assets.is_empty()
                && expected_assets == existing_assets
                && evidence.expected_assets.len() == evidence.existing_assets.len();
            if evidence.disposition == "resumableDraft" && approval_proven && exact_assets {
                operation.status = "awaitingApproval".into();
                operation.stages[index].error = if diagnostics.is_empty() {
                    None
                } else {
                    Some(diagnostics.join("\n"))
                };
                persist_recovery_settlement(registry, &mut operation, &token, "recovered")?;
            } else {
                diagnostics.push(format!(
                    "Recovery reconciliation was inconclusive (disposition {})",
                    evidence.disposition
                ));
                operation.status = "failed".into();
                if operation.stages[index].status == "running" {
                    operation.stages[index].status = "failed".into();
                }
                operation.stages[index].error = Some(diagnostics.join("\n"));
                persist_recovery_settlement(registry, &mut operation, &token, "failed")?;
            }
        }
        Err(error) => {
            diagnostics.push(error);
            operation.status = "failed".into();
            operation.stages[index].status = "failed".into();
            operation.stages[index].completed_at = Some(now());
            operation.stages[index].error = Some(diagnostics.join("\n"));
            persist_recovery_settlement(registry, &mut operation, &token, "failed")?;
        }
    }
    registry.remove(&token);
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
    let mut notes = if generate_notes {
        config
            .generate_notes
            .as_deref()
            .map(|command| run_capture(command, &root, &env))
            .transpose()?
    } else {
        None
    };
    let reconciliation = if generate_notes {
        if let Some(version) = suggested.as_deref().filter(|value| !value.is_empty()) {
            let notes_path = write_notes("preview", notes.as_deref().unwrap_or(""))?;
            let reconciliation_env = release_env(
                version,
                &current,
                &root,
                &project.target_branch,
                &head,
                "inspection",
                notes_path.to_string_lossy().as_ref(),
            );
            reconcile(&config, &root, &reconciliation_env)?
        } else {
            None
        }
    } else {
        None
    };
    if let Some(evidence) = reconciliation
        .as_ref()
        .filter(|item| item.disposition != "available")
    {
        if let Some(approved) = evidence
            .identity
            .get("notes")
            .and_then(serde_json::Value::as_str)
        {
            notes = Some(approved.to_string());
        }
    }
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
        reconciliation,
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
    let reconciliation = config.reconciliation.as_ref().ok_or_else(|| {
        "Release configuration requires a versioned reconciliation command".to_string()
    })?;
    if reconciliation.protocol_version != 1 {
        return Err("Only release reconciliation protocol version 1 is supported".into());
    }
    command_present("reconciliation", &reconciliation.command)?;
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
    kanban::with_read_connection(|connection| {
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

fn reconcile(
    config: &ReleaseConfig,
    cwd: &Path,
    env: &[(String, String)],
) -> Result<Option<ReleaseReconciliation>, String> {
    let Some(contract) = config.reconciliation.as_ref() else {
        return Ok(None);
    };
    if contract.protocol_version != 1 {
        return Err(format!(
            "Unsupported release reconciliation protocol {}",
            contract.protocol_version
        ));
    }
    let output = run_capture(&contract.command, cwd, env)?;
    let evidence: ReleaseReconciliation = serde_json::from_str(output.trim())
        .map_err(|error| format!("Reconciliation command returned invalid JSON: {error}"))?;
    if evidence.protocol_version != contract.protocol_version {
        return Err(
            "Reconciliation protocol version does not match the configured contract".into(),
        );
    }
    if evidence.requested_version
        != env
            .iter()
            .find(|(key, _)| key == "STACKS_RELEASE_VERSION")
            .map(|(_, value)| value.as_str())
            .unwrap_or("")
    {
        return Err("Reconciliation evidence describes a different release version".into());
    }
    Ok(Some(evidence))
}

fn refresh_release_preview(
    config: &ReleaseConfig,
    cwd: &Path,
    env: &[(String, String)],
    notes_path: &Path,
    submitted_notes: String,
) -> Result<ReleasePreviewRefresh, String> {
    let notes = match config.generate_notes.as_deref() {
        Some(command) => run_capture(command, cwd, env)?,
        None => submitted_notes,
    };
    fs::write(notes_path, &notes).map_err(|error| error.to_string())?;
    let reconciliation = reconcile(config, cwd, env)?
        .ok_or_else(|| "This release configuration has no reconciliation command".to_string())?;
    if reconciliation.disposition == "available" {
        if let Some(command) = config.validate_version.as_deref() {
            run_capture(command, cwd, env)?;
        }
    }
    Ok(ReleasePreviewRefresh {
        notes,
        reconciliation,
    })
}

fn require_action(
    evidence: &Option<ReleaseReconciliation>,
    actions: &[&str],
) -> Result<(), String> {
    let Some(evidence) = evidence else {
        return Err("Release action requires fresh structured reconciliation evidence; refresh or recover this legacy operation manually".into());
    };
    if actions.iter().any(|action| {
        evidence
            .permitted_actions
            .iter()
            .any(|allowed| allowed == action)
    }) {
        return Ok(());
    }
    let detail = if evidence.issues.is_empty() {
        format!("Disposition is {}", evidence.disposition)
    } else {
        evidence.issues.join("\n")
    };
    Err(format!(
        "Release reconciliation blocked this action: {detail}"
    ))
}

fn identity_fingerprint(config: &ReleaseConfig, evidence: &ReleaseReconciliation) -> String {
    let identity = &evidence.identity;
    fingerprint(&serde_json::json!({
        "config": config,
        "tag": identity.get("tag"),
        "title": identity.get("title"),
        "notes": identity.get("notes"),
        "targetBranch": identity.get("targetBranch"),
        "draft": identity.get("draft"),
        "prerelease": identity.get("prerelease"),
        "expectedAssets": evidence.expected_assets,
    }))
}
fn fingerprint(value: &serde_json::Value) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.to_string().bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
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
    kanban::with_write_connection(|connection| {
        connection.execute("INSERT INTO release_operations (id,project_id,repository_identity,status,revision,state_json,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", params![operation.id,operation.project_id,operation.repository_identity,operation.status,operation.revision,serde_json::to_string(operation).unwrap(),operation.created_at,operation.updated_at]).map(|_| ()).map_err(db_error)
    })
}
fn update_operation(
    operation: &mut ReleaseOperation,
    attempt_token: Option<&str>,
) -> Result<(), String> {
    kanban::with_write_connection(|connection| {
        let transaction = connection.savepoint().map_err(db_error)?;
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
    kanban::with_read_connection(|connection| {
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
    kanban::with_read_connection(|connection| {
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
fn sanitize_log(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while index < chars.len() {
        let character = chars[index];
        if character == '\u{1b}' {
            if chars.get(index + 1) == Some(&'[') {
                index += 2;
                while index < chars.len() {
                    let end = chars[index];
                    index += 1;
                    if ('@'..='~').contains(&end) {
                        break;
                    }
                }
                continue;
            }
            if chars.get(index + 1) == Some(&']') {
                index += 2;
                while index < chars.len() {
                    if chars[index] == '\u{7}' {
                        index += 1;
                        break;
                    }
                    if chars[index] == '\u{1b}' && chars.get(index + 1) == Some(&'\\') {
                        index += 2;
                        break;
                    }
                    index += 1;
                }
                continue;
            }
            index += 2;
            continue;
        }
        if character == '\r' {
            output.push('\n');
            if chars.get(index + 1) == Some(&'\n') {
                index += 1;
            }
        } else if character == '\n' || character == '\t' || !character.is_control() {
            output.push(character);
        }
        index += 1;
    }
    output
}
fn read_log(path: &Path) -> (String, bool) {
    let bytes = fs::read(path).unwrap_or_default();
    let text = sanitize_log(&String::from_utf8_lossy(&bytes));
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
            reconciliation: Some(ReleaseReconciliationConfig {
                protocol_version: 1,
                command: "true".into(),
            }),
            stages: vec![],
        };
        assert!(validate_config(&config).is_err());
        config.stages = vec![stage("same"), stage("same")];
        assert!(validate_config(&config).unwrap_err().contains("Duplicate"));
    }
    #[test]
    fn repository_release_config_matches_the_generic_runner_contract() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.stacks/release.json");
        let config: ReleaseConfig = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        validate_config(&config).unwrap();
        assert_eq!(config.reconciliation.as_ref().unwrap().protocol_version, 1);
        assert_eq!(
            config
                .stages
                .iter()
                .filter(|stage| stage.approval.is_some())
                .count(),
            1
        );
        assert_eq!(
            config
                .stages
                .iter()
                .find(|stage| stage.approval.is_some())
                .unwrap()
                .id,
            "draft"
        );
        assert_eq!(
            config
                .stages
                .iter()
                .find(|stage| stage.id == "prepare")
                .unwrap()
                .repository_access,
            RepositoryAccess::Exclusive
        );
        assert_eq!(
            config
                .stages
                .iter()
                .find(|stage| stage.id == "draft")
                .unwrap()
                .repository_access,
            RepositoryAccess::Exclusive
        );
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
    fn displayed_logs_remove_terminal_controls_and_preserve_progress_lines() {
        let input = "plain\r\n\u{1b}[31mred\u{1b}[0m\rprogress 1\rprogress 2\n\u{1b}]0;unsafe title\u{7}done\u{8}\u{0}";
        assert_eq!(
            sanitize_log(input),
            "plain\nred\nprogress 1\nprogress 2\ndone"
        );
        assert_eq!(
            sanitize_log("before\u{1b}[2J\u{1b}[Hafter\tvalue"),
            "beforeafter\tvalue"
        );
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

    #[test]
    fn preview_refresh_generates_notes_and_reconciles_the_generated_value() {
        let root =
            std::env::temp_dir().join(format!("stacks-release-preview-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let notes_path = root.join("notes.txt");
        fs::write(&notes_path, "edited notes").unwrap();
        let mut config = test_config();
        config.generate_notes = Some("printf 'generated notes'".into());
        config.reconciliation.as_mut().unwrap().command = "test \"$(cat \"$STACKS_RELEASE_NOTES_FILE\")\" = 'generated notes' && printf '{\"protocolVersion\":1,\"disposition\":\"available\",\"requestedVersion\":\"%s\"}' \"$STACKS_RELEASE_VERSION\"".into();
        let env = release_env(
            "2.0.0",
            "1.0.0",
            &root,
            "main",
            "abc",
            "preview",
            notes_path.to_str().unwrap(),
        );

        let refreshed =
            refresh_release_preview(&config, &root, &env, &notes_path, "edited notes".into())
                .unwrap();

        assert_eq!(refreshed.notes, "generated notes");
        assert_eq!(fs::read_to_string(&notes_path).unwrap(), refreshed.notes);
        assert_eq!(refreshed.reconciliation.requested_version, "2.0.0");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preview_refresh_without_generator_reconciles_submitted_notes() {
        let root =
            std::env::temp_dir().join(format!("stacks-release-preview-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let notes_path = root.join("notes.txt");
        let mut config = test_config();
        config.reconciliation.as_mut().unwrap().command = "test \"$(cat \"$STACKS_RELEASE_NOTES_FILE\")\" = 'supplied notes' && printf '{\"protocolVersion\":1,\"disposition\":\"available\",\"requestedVersion\":\"%s\"}' \"$STACKS_RELEASE_VERSION\"".into();
        let env = release_env(
            "2.0.0",
            "1.0.0",
            &root,
            "main",
            "abc",
            "preview",
            notes_path.to_str().unwrap(),
        );

        let refreshed =
            refresh_release_preview(&config, &root, &env, &notes_path, "supplied notes".into())
                .unwrap();

        assert_eq!(refreshed.notes, "supplied notes");
        assert_eq!(fs::read_to_string(&notes_path).unwrap(), refreshed.notes);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn registry_ownership_and_recovery_claims_are_token_exact_and_idempotent() {
        let registry = ReleaseRegistry::default();
        registry.begin("owned".into()).unwrap();
        assert!(registry.actively_owned("owned"));
        assert!(registry.claim_recovery("owned").unwrap().is_none());
        assert!(!registry.kill("unrelated").unwrap());

        registry.execution_finished(
            "owned",
            ExecutionOutcome {
                head: Some("abc".into()),
                error: None,
            },
        );
        assert!(registry.claim_recovery("owned").unwrap().is_none());
        registry.settlement_failed("owned", "database unavailable".into());
        assert!(registry.claim_recovery("owned").unwrap().is_some());
        assert!(registry.claim_recovery("owned").unwrap().is_none());
        assert!(registry
            .claim_recovery("orphan-with-persisted-pid-only")
            .unwrap()
            .is_some());
    }

    #[test]
    fn recovery_evidence_preserves_identity_and_marks_only_proven_stages() {
        let mut operation = test_operation();
        let evidence = test_evidence();
        operation.identity_fingerprint = identity_fingerprint(
            &operation.config,
            operation.reconciliation.as_ref().unwrap(),
        );
        validate_recovery_evidence(&operation, &evidence).unwrap();
        apply_proven_evidence(&mut operation, &evidence);
        assert_eq!(operation.stages[0].status, "completed");
        assert_eq!(operation.stages[1].status, "awaitingApproval");
        assert_eq!(operation.stages[2].status, "pending");

        for (name, mutate) in [
            // Non-capturing closures intentionally coerce to function pointers.
            ("notes", |item: &mut ReleaseReconciliation| {
                item.identity["notes"] = serde_json::json!("changed")
            }),
            ("revision", |item: &mut ReleaseReconciliation| {
                item.remote_tag_revision = Some("wrong".into())
            }),
            ("artifacts", |item: &mut ReleaseReconciliation| {
                item.expected_assets.push("extra".into())
            }),
        ] as [(&str, fn(&mut ReleaseReconciliation)); 3]
        {
            let mut conflicting = test_evidence();
            mutate(&mut conflicting);
            assert!(
                validate_recovery_evidence(&test_operation(), &conflicting).is_err(),
                "{name} conflict was accepted"
            );
        }
    }

    #[test]
    fn migrates_legacy_attempt_journal_rows_conservatively() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE release_operations (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,repository_identity TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,state_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL); CREATE TABLE release_attempts (token TEXT PRIMARY KEY,operation_id TEXT NOT NULL,stage_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,log_path TEXT NOT NULL,started_at INTEGER NOT NULL,completed_at INTEGER); INSERT INTO release_attempts VALUES ('old','op','draft','run','failed',4242,'/tmp/log',1,2);").unwrap();
        migrate(&connection).unwrap();
        let state: String = connection
            .query_row(
                "SELECT execution_status FROM release_attempts WHERE token='old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "settled");
        let columns: HashSet<String> = connection
            .prepare("PRAGMA table_info(release_attempts)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(
            columns.contains("execution_head")
                && columns.contains("settlement_error")
                && columns.contains("recovery_error")
        );
    }

    #[test]
    fn attempt_settlement_uses_the_callers_existing_transaction() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        let mut operation = test_operation();
        let state = serde_json::to_string(&operation).unwrap();
        connection.execute(
            "INSERT INTO release_operations(id,project_id,repository_identity,status,revision,state_json,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,1,1)",
            params![operation.id, operation.project_id, operation.repository_identity, operation.status, operation.revision, state],
        ).unwrap();
        connection.execute(
            "INSERT INTO release_attempts(token,operation_id,stage_id,kind,status,execution_status,log_path,started_at) VALUES ('attempt',?1,'prepare','run','running','completed','/tmp/log',1)",
            [&operation.id],
        ).unwrap();

        connection.execute_batch("BEGIN").unwrap();
        persist_attempt_state_in_transaction(
            &connection,
            &mut operation,
            "attempt",
            "completed",
            None,
            true,
        )
        .unwrap();
        connection.execute_batch("COMMIT").unwrap();

        let stored: (String, i64, String, String) = connection.query_row(
            "SELECT o.status,o.revision,a.status,a.execution_status FROM release_operations o JOIN release_attempts a ON a.operation_id=o.id WHERE o.id=?1",
            [&operation.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
        assert_eq!(
            stored,
            ("running".into(), 2, "completed".into(), "settled".into())
        );
    }

    fn test_operation() -> ReleaseOperation {
        let mut config = test_config();
        config.stages = vec![
            stage("prepare"),
            ReleaseStageConfig {
                approval: Some(ReleaseApproval { instructions: None }),
                ..stage("draft")
            },
            stage("publish"),
        ];
        let evidence = test_evidence();
        ReleaseOperation {
            id: "operation".into(),
            project_id: "project".into(),
            project_path: "/repo".into(),
            repository_identity: "/repo/.git".into(),
            config_path: ".stacks/release.json".into(),
            config,
            previous_version: "1.0.0".into(),
            version: "1.1.0".into(),
            notes: "approved notes".into(),
            target_branch: "main".into(),
            initial_revision: "source".into(),
            expected_revision: "source".into(),
            prepared_revision: None,
            prepared_parent: None,
            approved_paths: vec![],
            reconciliation: Some(evidence.clone()),
            identity_fingerprint: String::new(),
            artifact_evidence: serde_json::Value::Null,
            release_url: None,
            adopted: false,
            status: "running".into(),
            stages: ["prepare", "draft", "publish"]
                .into_iter()
                .map(|id| ReleaseStageState {
                    id: id.into(),
                    name: id.into(),
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
            created_at: 1,
            updated_at: 1,
            completed_at: None,
            revision: 1,
        }
    }

    fn test_evidence() -> ReleaseReconciliation {
        ReleaseReconciliation {
            protocol_version: 1,
            disposition: "resumableDraft".into(),
            requested_version: "1.1.0".into(),
            source_revision: Some("source".into()),
            prepared_revision: Some("prepared".into()),
            prepared_parent: Some("source".into()),
            remote_tag_revision: Some("prepared".into()),
            expected_assets: vec!["app.zip".into()],
            existing_assets: vec![ArtifactEvidence {
                name: "app.zip".into(),
                size: Some(1),
                digest: Some("sha256:x".into()),
            }],
            release: Some(ReleaseIdentity {
                id: serde_json::json!(1),
                tag: "v1.1.0".into(),
                revision: Some("prepared".into()),
                title: "Stacks v1.1.0".into(),
                notes: "approved notes".into(),
                target: "prepared".into(),
                draft: true,
                prerelease: false,
                url: None,
            }),
            identity: serde_json::json!({ "tag": "v1.1.0", "revision": "prepared", "title": "Stacks v1.1.0", "notes": "approved notes", "targetBranch": "main", "draft": true, "prerelease": false }),
            proven_stages: vec!["prepare".into(), "draft".into()],
            permitted_actions: vec!["approve".into()],
            artifact: serde_json::json!({ "valid": true, "assets": [{ "name": "app.zip", "size": 1, "digest": "sha256:x" }] }),
            ..ReleaseReconciliation::default()
        }
    }

    fn test_config() -> ReleaseConfig {
        ReleaseConfig {
            current_version: "echo 1".into(),
            suggested_version: None,
            validate_version: None,
            generate_notes: None,
            preflight: None,
            reconciliation: Some(ReleaseReconciliationConfig {
                protocol_version: 1,
                command: "true".into(),
            }),
            stages: vec![stage("release")],
        }
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
