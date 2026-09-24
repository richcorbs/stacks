use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    env,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{path::BaseDirectory, Emitter, Manager, State, Window};

use crate::{fs_paths::app_data_dir, process_group};

static TRUST_FILE_LOCK: Mutex<()> = Mutex::new(());
static LEGACY_EXTENSION_LOCK: Mutex<()> = Mutex::new(());

pub struct PiRpcHandle {
    stdin: Arc<Mutex<ChildStdin>>,
    generation: String,
    stop_tx: mpsc::Sender<mpsc::Sender<()>>,
    alive: Arc<AtomicBool>,
    cwd: String,
    project_id: String,
    approve_project: bool,
    lifecycle: Arc<Mutex<PiLifecycleTracker>>,
}

impl PiRpcHandle {
    fn stop(&self) -> Result<(), String> {
        if !self.alive.load(Ordering::Acquire) {
            return Ok(());
        }
        let (finished_tx, finished_rx) = mpsc::channel();
        self.stop_tx
            .send(finished_tx)
            .map_err(|_| "Pi process shutdown channel is unavailable".to_string())?;
        finished_rx
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| "Timed out waiting for the Pi process to stop".to_string())
    }
}

pub(crate) fn card_pi_runtime_ids(
    registry: &Mutex<PiRpcRegistry>,
    card_id: &str,
) -> Result<Vec<String>, String> {
    let guard = registry
        .lock()
        .map_err(|_| "Pi session registry lock poisoned".to_string())?;
    Ok(guard
        .sessions
        .keys()
        .chain(guard.starting.iter())
        .filter(|id| crate::kanban::card_pi_owner(id).as_deref() == Some(card_id))
        .cloned()
        .collect())
}

#[derive(Default)]
pub struct PiRpcRegistry {
    sessions: HashMap<String, PiRpcHandle>,
    starting: HashSet<String>,
    cancelled: HashSet<String>,
}

impl Drop for PiRpcRegistry {
    fn drop(&mut self) {
        for handle in self.sessions.values() {
            let _ = handle.stop();
        }
    }
}

#[derive(Clone, Serialize)]
struct PiRpcEvent {
    pane_id: String,
    generation: String,
    event_id: String,
    event_order: u64,
    event: Value,
}

const SETTLEMENT_WATCHDOG_DELAY: Duration = Duration::from_millis(1_000);
const SETTLEMENT_PROBE_PREFIX: &str = "stacks-lifecycle-probe-";

#[derive(Default)]
struct PiLifecycleTracker {
    epoch: u64,
    active_run: bool,
    retrying: bool,
    compacting: bool,
    active_tools: HashSet<String>,
    pending_ui: HashSet<String>,
    queued: bool,
    armed: Option<u64>,
    probe: Option<(String, u64)>,
}

impl PiLifecycleTracker {
    fn cancel_recovery(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.armed = None;
        self.probe = None;
    }

    fn observe_command(&mut self, command: &Value) {
        let kind = command.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(
            kind,
            "prompt"
                | "steer"
                | "follow_up"
                | "compact"
                | "new_session"
                | "abort"
                | "clear_queue"
                | "extension_ui_response"
        ) {
            self.cancel_recovery();
        }
        if kind == "compact" {
            self.compacting = true;
        }
        if kind == "extension_ui_response" {
            if let Some(id) = command.get("id").and_then(Value::as_str) {
                self.pending_ui.remove(id);
            }
        }
    }

    fn observe_event(&mut self, event: &Value) -> Option<u64> {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "agent_start" => {
                self.cancel_recovery();
                self.active_run = true;
                self.retrying = false;
                self.active_tools.clear();
            }
            "agent_settled" => {
                self.cancel_recovery();
                self.active_run = false;
                self.retrying = false;
                self.compacting = false;
                self.active_tools.clear();
                self.pending_ui.clear();
                self.queued = false;
            }
            "retry_scheduled" | "retry_start" => {
                self.cancel_recovery();
                self.retrying = true;
            }
            "retry_end" => {
                self.cancel_recovery();
                self.retrying = false;
            }
            "auto_compaction_start" | "compaction_start" => {
                self.cancel_recovery();
                self.compacting = true;
            }
            "auto_compaction_end" | "compaction_end" => {
                self.cancel_recovery();
                self.compacting = false;
            }
            "tool_execution_start" => {
                self.cancel_recovery();
                if let Some(id) = event.get("toolCallId").and_then(Value::as_str) {
                    self.active_tools.insert(id.to_string());
                }
            }
            "tool_execution_update" => self.cancel_recovery(),
            "tool_execution_end" => {
                self.cancel_recovery();
                if let Some(id) = event.get("toolCallId").and_then(Value::as_str) {
                    self.active_tools.remove(id);
                }
            }
            "queue_update" => {
                self.cancel_recovery();
                self.queued = ["steering", "followUp"].iter().any(|key| {
                    event
                        .get(key)
                        .and_then(Value::as_array)
                        .is_some_and(|items| !items.is_empty())
                });
            }
            "extension_ui_request" => {
                let method = event.get("method").and_then(Value::as_str).unwrap_or("");
                if matches!(method, "confirm" | "input" | "editor" | "select") {
                    self.cancel_recovery();
                    if let Some(id) = event.get("id").and_then(Value::as_str) {
                        self.pending_ui.insert(id.to_string());
                    }
                }
            }
            "message_start" | "message_update" | "message_end" => self.cancel_recovery(),
            "agent_end" => {
                let terminal_run = self.active_run;
                self.active_run = false;
                if terminal_run && self.eligible() {
                    self.epoch = self.epoch.wrapping_add(1);
                    self.armed = Some(self.epoch);
                    return self.armed;
                }
                self.cancel_recovery();
            }
            _ => {}
        }
        None
    }

    fn eligible(&self) -> bool {
        !self.active_run
            && !self.retrying
            && !self.compacting
            && self.active_tools.is_empty()
            && self.pending_ui.is_empty()
            && !self.queued
    }

    fn begin_probe(&mut self, token: u64, id: String) -> bool {
        if self.armed != Some(token) || !self.eligible() {
            return false;
        }
        self.probe = Some((id, token));
        true
    }

    fn accept_probe(&mut self, event: &Value) -> bool {
        let Some(id) = event.get("id").and_then(Value::as_str) else {
            return false;
        };
        let Some((expected, token)) = self.probe.as_ref() else {
            return false;
        };
        if id != expected || self.armed != Some(*token) {
            return false;
        }
        let idle = event.get("type").and_then(Value::as_str) == Some("response")
            && event.get("success").and_then(Value::as_bool) == Some(true)
            && event.pointer("/data/isStreaming").and_then(Value::as_bool) == Some(false)
            && event.pointer("/data/isCompacting").and_then(Value::as_bool) != Some(true)
            && event
                .pointer("/data/pendingMessageCount")
                .and_then(Value::as_u64)
                == Some(0)
            && self.eligible();
        self.probe = None;
        self.armed = None;
        idle
    }
}

#[tauri::command]
pub async fn start_pi_session(
    window: Window,
    pane_id: String,
    cwd: String,
    project_path: Option<String>,
    project_id: String,
) -> Result<String, String> {
    let app = window.app_handle().clone();
    run_pi_start_worker(move || {
        start_pi_session_operation(
            window, app.state::<Mutex<PiRpcRegistry>>(), pane_id, cwd, project_path, project_id,
        )
    }).await
}

async fn run_pi_start_worker<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("Pi session startup worker failed: {error}"))?
}

fn start_pi_session_operation(
    window: Window,
    registry: State<'_, Mutex<PiRpcRegistry>>,
    pane_id: String,
    cwd: String,
    project_path: Option<String>,
    project_id: String,
) -> Result<String, String> {
    if pane_id.trim().is_empty() {
        return Err("Pi pane ID is required".to_string());
    }
    let cwd = canonical_project_path(&cwd)?;
    let project_path = project_path
        .as_deref()
        .map(canonical_project_path)
        .transpose()?;
    let project = crate::store::pi_project_scope(&project_id)?;
    if let Some(owner) = crate::kanban::card_pi_session(&pane_id)? {
        let card_project_id = crate::kanban::card_project_id(&owner.card_id)?.ok_or_else(|| {
            "The card-scoped Pi session's owning project was not found".to_string()
        })?;
        if card_project_id != project.id {
            return Err(
                "The card-scoped Pi session does not belong to the supplied Stacks project"
                    .to_string(),
            );
        }
        crate::kanban::validate_card_pi_start(&owner.card_id, &owner.thread, &cwd, &project.id)?;
    }
    if let Some(owner_project_id) = crate::project_direct::project_direct_owner(&pane_id) {
        if owner_project_id != project.id {
            return Err(
                "The Project Workspace Pi session does not belong to the supplied Stacks project"
                    .to_string(),
            );
        }
    }
    let trusted_projects = read_trusted_projects()?;
    let approve_project = is_project_trusted(&trusted_projects, &cwd, project_path.as_deref());

    // React panes can remount while their first start is still in flight. Treat
    // concurrent starts as idempotent and wait for the owner instead of leaving
    // the remounted pane in an error state.
    let wait_started = Instant::now();
    let replaced_handle = loop {
        let mut guard = registry
            .lock()
            .map_err(|_| "Pi session registry lock poisoned".to_string())?;
        if let Some(handle) = guard.sessions.get(&pane_id) {
            if handle.alive.load(Ordering::Acquire)
                && handle.cwd == cwd
                && handle.project_id == project.id
                && handle.approve_project == approve_project
            {
                return Ok(handle.generation.clone());
            }
        }
        if guard.starting.contains(&pane_id) {
            drop(guard);
            if wait_started.elapsed() >= Duration::from_secs(30) {
                return Err("Timed out waiting for Pi session startup".to_string());
            }
            std::thread::sleep(Duration::from_millis(25));
            continue;
        }
        let replaced_handle = guard.sessions.remove(&pane_id);
        guard.cancelled.remove(&pane_id);
        guard.starting.insert(pane_id.clone());
        break replaced_handle;
    };
    if let Some(handle) = replaced_handle {
        handle.stop()?;
    }

    let result = spawn_pi_session(&window, &pane_id, &cwd, &project, approve_project);
    let mut guard = registry
        .lock()
        .map_err(|_| "Pi session registry lock poisoned".to_string())?;
    guard.starting.remove(&pane_id);

    match result {
        Ok(handle) => {
            if guard.cancelled.remove(&pane_id) {
                drop(guard);
                handle.stop()?;
                return Err("Pi session start was cancelled".to_string());
            }
            let generation = handle.generation.clone();
            guard.sessions.insert(pane_id, handle);
            Ok(generation)
        }
        Err(error) => Err(error),
    }
}

fn spawn_pi_session(
    window: &Window,
    pane_id: &str,
    cwd: &str,
    project: &crate::store::PiProjectScope,
    approve_project: bool,
) -> Result<PiRpcHandle, String> {
    let pi =
        find_pi().ok_or_else(|| "Pi CLI not found. Install `pi` or set PI_PATH.".to_string())?;
    let runtime_path = pi_runtime_path(&pi);
    let session_dir = session_dir(pane_id)?;
    std::fs::create_dir_all(&session_dir).map_err(|error| error.to_string())?;
    migrate_legacy_stacks_extension()?;
    let extension_path = stacks_extension_path(window)?;

    let generation = uuid::Uuid::new_v4().to_string();
    let trust_flag = project_trust_flag(approve_project);
    let mut pi_command = Command::new(pi);
    pi_command
        .current_dir(cwd)
        .args([
            "--mode",
            "rpc",
            trust_flag,
            "--no-extensions",
            "--extension",
            extension_path
                .to_str()
                .ok_or_else(|| "Bundled Stacks Pi extension path is invalid".to_string())?,
            "--session-dir",
            session_dir
                .to_str()
                .ok_or_else(|| "Pi session path is invalid".to_string())?,
            "--continue",
            "--name",
            "Stacks Pi GUI",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = runtime_path {
        pi_command.env("PATH", path);
    }
    pi_command
        .env("STACKS_PROJECT_ID", &project.id)
        .env("STACKS_PROJECT_NAME", &project.name)
        .env("STACKS_KANBAN_SOURCE", &project.kanban_source)
        .env(
            "STACKS_AUTOMATION_SOCKET",
            crate::automation::socket_path()?,
        );
    if let Some(owner) = crate::kanban::card_pi_session(pane_id)? {
        pi_command
            .env("STACKS_CARD_ID", owner.card_id)
            .env("STACKS_CARD_THREAD", owner.thread);
        if let Some(name) = project.superthread_token_env_var.as_deref() {
            // Resolve only in the backend at launch time. The token is inherited by
            // Pi as ST_TOKEN and never crosses RPC/frontend/session persistence.
            pi_command.env("ST_TOKEN", crate::superthread::resolve_api_token(name)?);
        }
    }
    process_group::configure(&mut pi_command);
    let mut child = pi_command
        .spawn()
        .map_err(|error| format!("Could not start Pi: {error}"))?;

    let pipes = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let (stdin, stdout, stderr) = match pipes {
        (Some(stdin), Some(stdout), Some(stderr)) => (stdin, stdout, stderr),
        _ => {
            process_group::terminate(&mut child, Duration::from_millis(500));
            return Err("Could not open Pi process streams".to_string());
        }
    };

    // Registration must precede every stdout/stderr/process projection. Pi may
    // emit immediately after spawn, so registering after this function returns
    // leaves a real race where the first lifecycle event is rejected.
    if let Err(error) = crate::kanban::register_pi_lifecycle_generation(pane_id, &generation) {
        process_group::terminate(&mut child, Duration::from_millis(500));
        return Err(error);
    }

    let stdin = Arc::new(Mutex::new(stdin));
    let lifecycle = Arc::new(Mutex::new(PiLifecycleTracker::default()));
    let emission_lock = Arc::new(Mutex::new(()));
    let alive = Arc::new(AtomicBool::new(true));
    let event_order = Arc::new(AtomicU64::new(0));
    let (stop_tx, stop_rx) = mpsc::channel::<mpsc::Sender<()>>();

    let output_window = window.clone();
    let output_pane_id = pane_id.to_string();
    let output_generation = generation.clone();
    let output_event_order = event_order.clone();
    let output_lifecycle = lifecycle.clone();
    let output_stdin = stdin.clone();
    let output_alive = alive.clone();
    let output_emission_lock = emission_lock.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            match reader.read_until(b'\n', &mut bytes) {
                Ok(0) => break,
                Ok(_) => {
                    if bytes.last() == Some(&b'\n') {
                        bytes.pop();
                    }
                    if bytes.last() == Some(&b'\r') {
                        bytes.pop();
                    }
                    if bytes.is_empty() {
                        continue;
                    }
                    let event = serde_json::from_slice(&bytes).unwrap_or_else(
                        |error| json!({"type":"pi_protocol_error","message":error.to_string()}),
                    );
                    process_raw_event(
                        &output_window,
                        &output_pane_id,
                        &output_generation,
                        &output_event_order,
                        &output_emission_lock,
                        &output_lifecycle,
                        &output_stdin,
                        &output_alive,
                        event,
                    );
                }
                Err(error) => {
                    emit_event(
                        &output_window,
                        &output_pane_id,
                        &output_generation,
                        &output_event_order,
                        &output_emission_lock,
                        json!({"type":"pi_protocol_error","message":error.to_string()}),
                        "native",
                    );
                    break;
                }
            }
        }
    });

    let error_window = window.clone();
    let error_pane_id = pane_id.to_string();
    let error_generation = generation.clone();
    let error_event_order = event_order.clone();
    let error_emission_lock = emission_lock.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            emit_event(
                &error_window,
                &error_pane_id,
                &error_generation,
                &error_event_order,
                &error_emission_lock,
                json!({"type":"pi_stderr","message":line}),
                "native",
            );
        }
    });

    let process_window = window.clone();
    let process_pane_id = pane_id.to_string();
    let process_generation = generation.clone();
    let process_alive = alive.clone();
    let process_event_order = event_order;
    let process_emission_lock = emission_lock;
    std::thread::spawn(move || {
        let mut expected_exit = false;
        loop {
            if let Ok(finished_tx) = stop_rx.try_recv() {
                expected_exit = true;
                process_group::terminate(&mut child, Duration::from_millis(750));
                let _ = finished_tx.send(());
                break;
            }
            match child.try_wait() {
                Ok(Some(_)) => {
                    // Pi can exit while a tool subprocess is still alive.
                    process_group::terminate(&mut child, Duration::from_millis(250));
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => {
                    process_group::terminate(&mut child, Duration::from_millis(500));
                    break;
                }
            }
        }
        process_alive.store(false, Ordering::Release);
        emit_event(
            &process_window,
            &process_pane_id,
            &process_generation,
            &process_event_order,
            &process_emission_lock,
            json!({"type":"pi_process_exit","expected":expected_exit}),
            "native",
        );
    });

    Ok(PiRpcHandle {
        stdin,
        generation,
        stop_tx,
        alive,
        cwd: cwd.to_string(),
        project_id: project.id.clone(),
        approve_project,
        lifecycle,
    })
}

#[tauri::command]
pub fn send_pi_rpc(
    registry: State<'_, Mutex<PiRpcRegistry>>,
    pane_id: String,
    command: Value,
) -> Result<(), String> {
    let mut guard = registry
        .lock()
        .map_err(|_| "Pi session registry lock poisoned".to_string())?;
    let handle = guard
        .sessions
        .get_mut(&pane_id)
        .ok_or_else(|| "Pi session is not running".to_string())?;
    if !handle.alive.load(Ordering::Acquire) {
        return Err("Pi session has exited".to_string());
    }
    if let Ok(mut lifecycle) = handle.lifecycle.lock() {
        lifecycle.observe_command(&command);
    }
    let mut stdin = handle
        .stdin
        .lock()
        .map_err(|_| "Pi stdin lock poisoned".to_string())?;
    send_json(&mut stdin, &command)
}

#[tauri::command]
pub fn stop_pi_session(
    registry: State<'_, Mutex<PiRpcRegistry>>,
    pane_id: String,
) -> Result<(), String> {
    stop_pi_session_impl(registry.inner(), &pane_id)
}

#[tauri::command]
pub fn delete_pi_session(
    registry: State<'_, Mutex<PiRpcRegistry>>,
    pane_id: String,
) -> Result<(), String> {
    delete_pi_session_impl(registry.inner(), &pane_id)
}

pub(crate) fn stop_pi_session_impl(
    registry: &Mutex<PiRpcRegistry>,
    pane_id: &str,
) -> Result<(), String> {
    let handle = {
        let mut guard = registry
            .lock()
            .map_err(|_| "Pi session registry lock poisoned".to_string())?;
        if guard.starting.contains(pane_id) {
            guard.cancelled.insert(pane_id.to_string());
        }
        guard.sessions.remove(pane_id)
    };
    if let Some(handle) = handle {
        if let Err(error) = handle.stop() {
            registry
                .lock()
                .map_err(|_| "Pi session registry lock poisoned".to_string())?
                .sessions
                .insert(pane_id.to_string(), handle);
            return Err(error);
        }
    }
    Ok(())
}

pub(crate) fn delete_pi_session_directory(pane_id: &str) -> Result<(), String> {
    let directory = session_dir(pane_id)?;
    if directory.exists() {
        std::fs::remove_dir_all(directory)
            .map_err(|error| format!("Could not delete persisted Pi conversation: {error}"))?;
    }
    Ok(())
}

pub(crate) fn delete_pi_session_impl(
    registry: &Mutex<PiRpcRegistry>,
    pane_id: &str,
) -> Result<(), String> {
    stop_pi_session_impl(registry, pane_id)?;

    // A delete can race an in-flight start. Wait for that start to observe the
    // cancellation before removing the directory it may still be creating.
    for _ in 0..100 {
        let starting = registry
            .lock()
            .map_err(|_| "Pi session registry lock poisoned".to_string())?
            .starting
            .contains(pane_id);
        if !starting {
            return delete_pi_session_directory(pane_id);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Err("Timed out while deleting a starting Pi session".to_string())
}

fn send_json(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *stdin, value).map_err(|error| error.to_string())?;
    stdin.write_all(b"\n").map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

fn process_raw_event(
    window: &Window,
    pane_id: &str,
    generation: &str,
    sequence: &Arc<AtomicU64>,
    emission_lock: &Arc<Mutex<()>>,
    lifecycle: &Arc<Mutex<PiLifecycleTracker>>,
    stdin: &Arc<Mutex<ChildStdin>>,
    alive: &Arc<AtomicBool>,
    event: Value,
) {
    let (watchdog, synthetic) = lifecycle
        .lock()
        .map(|mut tracker| {
            let synthetic = tracker.accept_probe(&event);
            (tracker.observe_event(&event), synthetic)
        })
        .unwrap_or((None, false));
    emit_event(
        window,
        pane_id,
        generation,
        sequence,
        emission_lock,
        event,
        "native",
    );
    if synthetic {
        emit_event(
            window,
            pane_id,
            generation,
            sequence,
            emission_lock,
            json!({"type":"agent_settled","source":"stacks_watchdog"}),
            "synthetic",
        );
    }
    if let Some(token) = watchdog {
        schedule_settlement_probe(
            pane_id.to_string(),
            generation.to_string(),
            lifecycle.clone(),
            stdin.clone(),
            alive.clone(),
            token,
        );
    }
}

fn schedule_settlement_probe(
    pane_id: String,
    generation: String,
    lifecycle: Arc<Mutex<PiLifecycleTracker>>,
    stdin: Arc<Mutex<ChildStdin>>,
    alive: Arc<AtomicBool>,
    token: u64,
) {
    std::thread::spawn(move || {
        std::thread::sleep(SETTLEMENT_WATCHDOG_DELAY);
        if !alive.load(Ordering::Acquire) {
            return;
        }
        let id = format!("{SETTLEMENT_PROBE_PREFIX}{generation}-{token}");
        let armed = lifecycle
            .lock()
            .map(|mut tracker| tracker.begin_probe(token, id.clone()))
            .unwrap_or(false);
        if !armed {
            return;
        }
        let sent = stdin
            .lock()
            .map_err(|_| ())
            .and_then(|mut writer| {
                send_json(&mut writer, &json!({"type":"get_state","id":id})).map_err(|_| ())
            })
            .is_ok();
        if !sent {
            if let Ok(mut tracker) = lifecycle.lock() {
                tracker.cancel_recovery();
            }
            eprintln!(
                "[pi-lifecycle] {}",
                json!({"stage":"backend_recovery","pane":pane_id,"generation":generation,"source":"watchdog","result":"probe_write_failed"})
            );
        } else {
            eprintln!(
                "[pi-lifecycle] {}",
                json!({"stage":"backend_recovery","pane":pane_id,"generation":generation,"source":"watchdog","result":"idle_probe_sent"})
            );
        }
    });
}

fn emit_event(
    window: &Window,
    pane_id: &str,
    generation: &str,
    sequence: &AtomicU64,
    emission_lock: &Mutex<()>,
    event: Value,
    source: &str,
) {
    let _guard = emission_lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let event_order = sequence.fetch_add(1, Ordering::SeqCst);
    let event_id = format!("{generation}:{event_order}");
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if matches!(
        event_type,
        "agent_start"
            | "agent_end"
            | "agent_settled"
            | "pi_protocol_error"
            | "pi_process_exit"
            | "retry_scheduled"
            | "retry_start"
            | "retry_end"
            | "auto_compaction_start"
            | "auto_compaction_end"
            | "compaction_start"
            | "compaction_end"
            | "queue_update"
            | "extension_ui_request"
    ) {
        eprintln!(
            "[pi-lifecycle] {}",
            json!({"stage":"raw_event","pane":pane_id,"generation":generation,"event_id":event_id,"event_order":event_order,"event_type":event_type,"source":source})
        );
    }
    if let Err(error) = crate::kanban::project_pi_lifecycle_event(
        pane_id,
        generation,
        &event_id,
        event_order,
        &event,
        source,
    ) {
        eprintln!(
            "[pi-lifecycle] {}",
            json!({"stage":"backend_projection","pane":pane_id,"generation":generation,"event_id":event_id,"event_order":event_order,"event_type":event_type,"source":source,"result":"error","reason":error})
        );
    }
    let _ = window.emit(
        "pi-rpc-event",
        PiRpcEvent {
            pane_id: pane_id.to_string(),
            generation: generation.to_string(),
            event_id,
            event_order,
            event,
        },
    );
}

fn session_dir(pane_id: &str) -> Result<PathBuf, String> {
    if let Some(owner) = crate::kanban::card_pi_session(pane_id)? {
        return Ok(owner.directory);
    }
    let mut directory = app_data_dir()?;
    directory.push("pi-sessions");
    directory.push(safe_session_key(pane_id));
    Ok(directory)
}

#[tauri::command]
pub fn pi_session_exists(pane_id: String) -> Result<bool, String> {
    let directory = session_dir(&pane_id)?;
    if !directory.is_dir() {
        return Ok(false);
    }
    Ok(std::fs::read_dir(directory)
        .map_err(|error| format!("Could not inspect persisted Pi conversation: {error}"))?
        .next()
        .transpose()
        .map_err(|error| format!("Could not inspect persisted Pi conversation: {error}"))?
        .is_some())
}

#[tauri::command]
pub fn pi_project_trusted(cwd: String, project_path: Option<String>) -> Result<bool, String> {
    let cwd = canonical_project_path(&cwd)?;
    let project_path = project_path
        .as_deref()
        .map(canonical_project_path)
        .transpose()?;
    let trusted_projects = read_trusted_projects()?;
    Ok(is_project_trusted(
        &trusted_projects,
        &cwd,
        project_path.as_deref(),
    ))
}

#[tauri::command]
pub fn set_pi_project_trusted(
    cwd: String,
    project_path: Option<String>,
    trusted: bool,
) -> Result<(), String> {
    let cwd = canonical_project_path(&cwd)?;
    let project_path = project_path
        .as_deref()
        .map(canonical_project_path)
        .transpose()?;
    let trust_path = project_path.unwrap_or_else(|| cwd.clone());
    let _guard = TRUST_FILE_LOCK
        .lock()
        .map_err(|_| "Pi trust lock poisoned".to_string())?;
    let mut projects = read_trusted_projects_unlocked()?;
    if trusted {
        projects.insert(trust_path);
    } else {
        projects.remove(&trust_path);
        projects.remove(&cwd);
    }
    let mut path = app_data_dir()?;
    path.push("pi-trusted-projects.json");
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&projects).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn canonical_project_path(cwd: &str) -> Result<String, String> {
    std::fs::canonicalize(cwd)
        .map_err(|error| format!("Could not resolve Pi working directory: {error}"))?
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "Pi working directory is not valid UTF-8".to_string())
}

fn is_project_trusted(
    trusted_projects: &HashSet<String>,
    cwd: &str,
    project_path: Option<&str>,
) -> bool {
    trusted_projects.contains(cwd)
        || project_path.is_some_and(|project_path| {
            trusted_projects.contains(project_path)
                && workspace_belongs_to_project(cwd, project_path)
        })
}

fn workspace_belongs_to_project(cwd: &str, project_path: &str) -> bool {
    if Path::new(cwd).starts_with(project_path) {
        return true;
    }
    match (
        git_common_directory(cwd),
        git_common_directory(project_path),
    ) {
        (Some(cwd_git_dir), Some(project_git_dir)) => cwd_git_dir == project_git_dir,
        _ => false,
    }
}

fn git_common_directory(path: &str) -> Option<PathBuf> {
    let output = Command::new("git")
        .args([
            "-C",
            path,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    std::fs::canonicalize(path).ok()
}

fn read_trusted_projects() -> Result<HashSet<String>, String> {
    let _guard = TRUST_FILE_LOCK
        .lock()
        .map_err(|_| "Pi trust lock poisoned".to_string())?;
    read_trusted_projects_unlocked()
}

fn read_trusted_projects_unlocked() -> Result<HashSet<String>, String> {
    let mut path = app_data_dir()?;
    path.push("pi-trusted-projects.json");
    if !path.exists() {
        return Ok(HashSet::new());
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not read trusted Pi projects: {error}"))
}

fn project_trust_flag(approved: bool) -> &'static str {
    if approved {
        "--approve"
    } else {
        "--no-approve"
    }
}

fn safe_session_key(pane_id: &str) -> String {
    pane_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn stacks_extension_path(window: &Window) -> Result<PathBuf, String> {
    let bundled = window
        .app_handle()
        .path()
        .resolve("stacks-cards.ts", BaseDirectory::Resource)
        .map_err(|error| format!("Could not resolve the bundled Stacks Pi extension: {error}"))?;
    if bundled.is_file() {
        return Ok(bundled);
    }
    #[cfg(debug_assertions)]
    {
        let development =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/stacks-cards.ts");
        if development.is_file() {
            return Ok(development);
        }
    }
    Err(format!(
        "The bundled Stacks Pi extension is missing at {}. Rebuild or reinstall Stacks.",
        bundled.display()
    ))
}

fn migrate_legacy_stacks_extension() -> Result<(), String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(());
    };
    migrate_legacy_stacks_extension_at(
        &home.join(".pi/agent/extensions/stacks-cards.ts"),
        &home.join(".pi/agent/extensions/stacks-cards.ts.stacks-backup"),
    )
}

fn migrate_legacy_stacks_extension_at(source: &Path, backup: &Path) -> Result<(), String> {
    let _guard = LEGACY_EXTENSION_LOCK
        .lock()
        .map_err(|_| "Legacy Stacks Pi extension migration lock poisoned".to_string())?;
    if !source.exists() {
        return Ok(());
    }
    if backup.exists() {
        return Err(format!(
            "Cannot migrate legacy Stacks Pi extension because backup already exists at {}. Move or remove one file, then retry.",
            backup.display()
        ));
    }
    let source_text = std::fs::read_to_string(source).map_err(|error| {
        format!(
            "Could not inspect legacy Stacks Pi extension at {}: {error}",
            source.display()
        )
    })?;
    if !is_recognized_legacy_stacks_extension(&source_text) {
        return Err(format!(
            "A customized or unrecognized Stacks Pi extension exists at {}. Move it out of the Pi extensions directory, then retry so Stacks does not load duplicate tools.",
            source.display()
        ));
    }
    std::fs::rename(source, backup).map_err(|error| {
        format!(
            "Could not preserve the legacy Stacks Pi extension as {}: {error}. Move it manually, then retry.",
            backup.display()
        )
    })
}

fn is_recognized_legacy_stacks_extension(source: &str) -> bool {
    source.as_bytes() == include_bytes!("../migrations/stacks-cards.legacy.ts.txt")
}

fn pi_runtime_path(pi: &std::path::Path) -> Option<std::ffi::OsString> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let login_path = Command::new(shell)
        .args(["-lic", "printf %s \"$PATH\""])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|path| !path.is_empty());
    if let Some(path) = login_path {
        return Some(path.into());
    }

    let executable_dir = pi.parent()?;
    let mut paths = vec![executable_dir.to_path_buf()];
    paths.extend(
        env::var_os("PATH")
            .as_deref()
            .map(env::split_paths)
            .into_iter()
            .flatten(),
    );
    env::join_paths(paths).ok()
}

fn find_pi() -> Option<PathBuf> {
    if let Some(path) = env::var_os("PI_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    if let Some(path) = env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".local/bin/pi"))
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    for path in ["/opt/homebrew/bin/pi", "/usr/local/bin/pi", "/usr/bin/pi"] {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = Command::new(shell)
        .args(["-lic", "command -v pi"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    path.is_file().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::{
        is_project_trusted, migrate_legacy_stacks_extension_at, project_trust_flag,
        run_pi_start_worker, safe_session_key, PiLifecycleTracker,
    };
    use serde_json::json;
    use std::{collections::HashSet, fs};

    #[test]
    fn pi_startup_does_not_run_on_the_calling_thread() {
        let calling_thread = std::thread::current().id();
        let worker_thread = tauri::async_runtime::block_on(run_pi_start_worker(|| {
            Ok(std::thread::current().id())
        })).unwrap();
        assert_ne!(worker_thread, calling_thread);
    }

    #[test]
    fn creates_safe_session_directory_names() {
        assert_eq!(safe_session_key("workspace:123"), "workspace_123");
    }

    #[test]
    fn workspace_directories_inherit_project_trust_only_when_related() {
        let trusted = HashSet::from(["/repo".to_string()]);
        assert!(is_project_trusted(
            &trusted,
            "/repo/workspaces/one",
            Some("/repo")
        ));
        assert!(!is_project_trusted(&trusted, "/unrelated", Some("/repo")));
    }

    #[test]
    fn does_not_trust_projects_without_explicit_approval() {
        assert_eq!(project_trust_flag(false), "--no-approve");
        assert_eq!(project_trust_flag(true), "--approve");
    }

    fn legacy_extension_text() -> &'static str {
        include_str!("../migrations/stacks-cards.legacy.ts.txt")
    }

    #[test]
    fn reversibly_renames_the_recognized_legacy_extension() {
        let directory =
            std::env::temp_dir().join(format!("stacks-extension-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("stacks-cards.ts");
        let backup = directory.join("stacks-cards.ts.stacks-backup");
        fs::write(&source, legacy_extension_text()).unwrap();

        migrate_legacy_stacks_extension_at(&source, &backup).unwrap();

        assert!(!source.exists());
        assert_eq!(
            fs::read_to_string(&backup).unwrap(),
            legacy_extension_text()
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn refuses_to_overwrite_a_legacy_extension_backup() {
        let directory =
            std::env::temp_dir().join(format!("stacks-extension-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("stacks-cards.ts");
        let backup = directory.join("stacks-cards.ts.stacks-backup");
        fs::write(&source, legacy_extension_text()).unwrap();
        fs::write(&backup, "existing backup").unwrap();

        let error = migrate_legacy_stacks_extension_at(&source, &backup).unwrap_err();

        assert!(error.contains("backup already exists"));
        assert!(source.exists());
        assert_eq!(fs::read_to_string(&backup).unwrap(), "existing backup");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn settlement_watchdog_requires_a_terminal_end_and_confirmed_idle_state() {
        let mut tracker = PiLifecycleTracker::default();
        assert_eq!(tracker.observe_event(&json!({"type":"agent_start"})), None);
        let token = tracker.observe_event(&json!({"type":"agent_end"})).unwrap();
        assert!(tracker.begin_probe(token, "probe".into()));
        assert!(!tracker.accept_probe(&json!({"type":"response","id":"probe","success":true,"data":{"isStreaming":true,"isCompacting":false,"pendingMessageCount":0}})));

        tracker.observe_event(&json!({"type":"agent_start"}));
        let token = tracker.observe_event(&json!({"type":"agent_end"})).unwrap();
        assert!(tracker.begin_probe(token, "probe-2".into()));
        assert!(tracker.accept_probe(&json!({"type":"response","id":"probe-2","success":true,"data":{"isStreaming":false,"isCompacting":false,"pendingMessageCount":0}})));
        assert_eq!(tracker.observe_event(&json!({"type":"agent_end"})), None);
    }

    #[test]
    fn recovery_is_cancelled_by_continuations_retry_compaction_tools_and_ui() {
        let blockers = [
            json!({"type":"queue_update","followUp":["continue"],"steering":[]}),
            json!({"type":"retry_scheduled"}),
            json!({"type":"auto_compaction_start"}),
            json!({"type":"tool_execution_start","toolCallId":"tool"}),
            json!({"type":"extension_ui_request","method":"confirm","id":"ui"}),
            json!({"type":"message_update"}),
        ];
        for blocker in blockers {
            let mut tracker = PiLifecycleTracker::default();
            tracker.observe_event(&json!({"type":"agent_start"}));
            let token = tracker.observe_event(&json!({"type":"agent_end"})).unwrap();
            tracker.observe_event(&blocker);
            assert!(
                !tracker.begin_probe(token, "probe".into()),
                "blocker: {blocker}"
            );
        }
    }

    #[test]
    fn idle_probe_rejects_pending_follow_ups_and_late_native_settle_cancels_recovery() {
        let mut tracker = PiLifecycleTracker::default();
        tracker.observe_event(&json!({"type":"agent_start"}));
        let token = tracker.observe_event(&json!({"type":"agent_end"})).unwrap();
        assert!(tracker.begin_probe(token, "probe".into()));
        assert!(!tracker.accept_probe(&json!({"type":"response","id":"probe","success":true,"data":{"isStreaming":false,"isCompacting":false,"pendingMessageCount":1}})));

        tracker.observe_event(&json!({"type":"agent_start"}));
        let token = tracker.observe_event(&json!({"type":"agent_end"})).unwrap();
        tracker.observe_event(&json!({"type":"agent_settled"}));
        assert!(!tracker.begin_probe(token, "late".into()));
    }

    #[test]
    fn refuses_to_disable_an_unrecognized_global_extension() {
        let directory =
            std::env::temp_dir().join(format!("stacks-extension-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("stacks-cards.ts");
        let backup = directory.join("stacks-cards.ts.stacks-backup");
        fs::write(&source, "export default function customized() {}").unwrap();

        let error = migrate_legacy_stacks_extension_at(&source, &backup).unwrap_err();

        assert!(error.contains("customized or unrecognized"));
        assert!(source.exists());
        assert!(!backup.exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
