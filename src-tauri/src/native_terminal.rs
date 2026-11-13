//! Card #319 spike: launch the native GPUI global terminal as an adjacent
//! helper process and route Stacks' global-terminal commands to it.
//!
//! This module is inert unless `STACKS_NATIVE_GLOBAL_TERMINAL=1` is set in the
//! environment that launches Stacks. With the flag off, nothing here spawns a
//! process, opens a socket, or touches the xterm.js global terminal.
//!
//! The helper (`spikes/gpui-terminal`) owns its own PTYs, tabs, panes, search,
//! clipboard and persistence. Stacks owns activation, the quit flow, and the
//! user's Cmd+T intent while Stacks is focused. The two apps talk over a Unix
//! domain socket with newline-delimited JSON; see
//! `spikes/gpui-terminal/src/host_ipc.rs` for the canonical protocol.

use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::{UnixListener, UnixStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

pub const ENABLE_ENV: &str = "STACKS_NATIVE_GLOBAL_TERMINAL";
pub const BIN_ENV: &str = "STACKS_NATIVE_GLOBAL_TERMINAL_BIN";
pub const EVENT_NAME: &str = "native-terminal-event";
const HELPER_EXECUTABLE: &str = "StacksNativeTerminal";
const HELPER_CRATE_NAME: &str = "stacks-gpui-terminal-spike";

/// Temporary diagnostics for the adjacent-window seam, enabled with
/// `STACKS_NATIVE_TERMINAL_DEBUG=1`.
macro_rules! native_debug {
    ($($arg:tt)*) => {
        if std::env::var_os("STACKS_NATIVE_TERMINAL_DEBUG").is_some() {
            eprintln!($($arg)*);
        }
    };
}

#[derive(Clone, Default)]
pub struct NativeTerminalState {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    socket_path: Option<PathBuf>,
    child: Option<Child>,
    writer: Option<UnixStream>,
    last_error: Option<String>,
    ready: bool,
    visible: bool,
    launch_attempted: bool,
    /// Guards against the same physical Cmd+T being dispatched twice (native
    /// menu accelerator plus webview keydown, or a focus hand-off replay).
    last_toggle_at: Option<Instant>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NativeTerminalStatus {
    enabled: bool,
    running: bool,
    ready: bool,
    visible: bool,
    helper_path: Option<String>,
    socket_path: Option<String>,
    last_error: Option<String>,
}

/// The flag is intentionally environment-only: this is a spike, not a product
/// setting, so it cannot be toggled from shipped UI or persisted in settings.
pub fn enabled() -> bool {
    cfg!(target_os = "macos")
        && matches!(
            std::env::var(ENABLE_ENV).as_deref(),
            Ok("1") | Ok("true") | Ok("yes")
        )
}

fn set_error(inner: &mut Inner, error: impl Into<String>) {
    let error = error.into();
    eprintln!("native terminal: {error}");
    inner.last_error = Some(error);
}

/// Resolve the helper executable.
///
/// 1. `STACKS_NATIVE_GLOBAL_TERMINAL_BIN` (absolute path to the executable).
/// 2. Bundled nested helper app inside `Stacks.app/Contents/Resources`.
/// 3. Debug builds: the spike crate's own `target/{release,debug}` output.
pub fn helper_path(app: &AppHandle) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(BIN_ENV).map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir
            .join("native-terminal")
            .join(format!("{HELPER_EXECUTABLE}.app"))
            .join("Contents")
            .join("MacOS")
            .join(HELPER_EXECUTABLE);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    if cfg!(debug_assertions) {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        for profile in ["release", "debug"] {
            let candidate = manifest
                .join("..")
                .join("spikes")
                .join("gpui-terminal")
                .join("target")
                .join(profile)
                .join(HELPER_CRATE_NAME);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn status_of(state: &NativeTerminalState, app: &AppHandle) -> NativeTerminalStatus {
    let inner = state.inner.lock().unwrap_or_else(|poison| poison.into_inner());
    NativeTerminalStatus {
        enabled: enabled(),
        running: inner.child.is_some(),
        ready: inner.ready,
        visible: inner.visible,
        helper_path: helper_path(app).map(|path| path.to_string_lossy().into_owned()),
        socket_path: inner
            .socket_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        last_error: inner.last_error.clone(),
    }
}

#[tauri::command]
pub fn native_terminal_status(
    app: AppHandle,
    state: State<'_, NativeTerminalState>,
) -> NativeTerminalStatus {
    status_of(&state, &app)
}

#[tauri::command]
pub async fn native_terminal_launch(
    app: AppHandle,
    state: State<'_, NativeTerminalState>,
) -> Result<NativeTerminalStatus, String> {
    // Helper startup blocks on the socket handshake, so keep it off the IPC
    // thread that other commands share.
    let state = state.inner().clone();
    let app_for_launch = app.clone();
    let launch_state = state.clone();
    tauri::async_runtime::spawn_blocking(move || ensure_started(&app_for_launch, &launch_state))
        .await
        .map_err(|error| error.to_string())??;
    Ok(status_of(&state, &app))
}

#[tauri::command]
pub async fn native_terminal_command(
    app: AppHandle,
    state: State<'_, NativeTerminalState>,
    command: String,
    index: Option<usize>,
) -> Result<(), String> {
    if !enabled() {
        return Err("Native global terminal is disabled".into());
    }
    let state = state.inner().clone();
    if command == "toggle" {
        let mut inner = state.inner.lock().unwrap_or_else(|poison| poison.into_inner());
        if inner
            .last_toggle_at
            .is_some_and(|at| at.elapsed() < Duration::from_millis(250))
        {
            if std::env::var_os("STACKS_NATIVE_TERMINAL_DEBUG").is_some() {
                eprintln!("native terminal: ignored duplicate toggle");
            }
            return Ok(());
        }
        inner.last_toggle_at = Some(Instant::now());
    }
    let app_for_launch = app.clone();
    let launch_state = state.clone();
    tauri::async_runtime::spawn_blocking(move || ensure_started(&app_for_launch, &launch_state))
        .await
        .map_err(|error| error.to_string())??;
    send_command(&state, &command, index)
}

/// Shared command path for the Tauri command and debug automation.
pub fn send_command(
    state: &NativeTerminalState,
    command: &str,
    index: Option<usize>,
) -> Result<(), String> {
    let payload = match command {
        "select-tab" => serde_json::json!({
            "command": "select-tab",
            "index": index.unwrap_or(1).saturating_sub(1),
        }),
        other => serde_json::json!({ "command": other }),
    };
    native_debug!("native terminal -> {payload}");
    send(state, &payload)
}

/// Explicit stop, used by manual tests and by future teardown hooks. Normal
/// shutdown is implicit: when Stacks exits, the helper's socket hits EOF and
/// the helper quits, taking its PTYs with it.
#[tauri::command]
pub fn native_terminal_stop(
    app: AppHandle,
    state: State<'_, NativeTerminalState>,
) -> NativeTerminalStatus {
    stop(&state);
    status_of(&state, &app)
}

pub fn ensure_started(
    app: &AppHandle,
    state: &NativeTerminalState,
) -> Result<(), String> {
    if !enabled() {
        return Ok(());
    }
    let mut inner = state.inner.lock().unwrap_or_else(|poison| poison.into_inner());
    if inner.child.is_some() {
        return Ok(());
    }
    // A helper that already failed gets one relaunch per Stacks process, not an
    // unbounded spawn loop on every Cmd+T.
    if inner.launch_attempted {
        return Err(inner
            .last_error
            .clone()
            .unwrap_or_else(|| "Native terminal helper is not running".into()));
    }
    inner.launch_attempted = true;
    drop(inner);
    launch(app, state).map_err(|error| {
        let mut inner = state.inner.lock().unwrap_or_else(|poison| poison.into_inner());
        set_error(&mut inner, error.to_string());
        error
    })
}

/// Remove socket files left behind by Stacks processes that were killed before
/// their helper could clean up. The socket name carries the owner pid.
fn cleanup_stale_sockets() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(pid) = name
            .strip_prefix("stacks-native-terminal-")
            .and_then(|rest| rest.strip_suffix(".sock"))
            .and_then(|pid| pid.parse::<i32>().ok())
        else {
            continue;
        };
        if pid == std::process::id() as i32 {
            continue;
        }
        let alive = unsafe { libc::kill(pid, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        if !alive {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn launch(app: &AppHandle, state: &NativeTerminalState) -> Result<(), String> {
    cleanup_stale_sockets();
    let Some(helper) = helper_path(app) else {
        return Err(format!(
            "Native terminal helper not found. Build it with `npm run native-terminal:build` \
             or set {BIN_ENV}."
        ));
    };
    let socket_path = std::env::temp_dir().join(format!(
        "stacks-native-terminal-{}.sock",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path)
        .map_err(|error| format!("Could not bind native terminal socket: {error}"))?;

    let mut child = Command::new(&helper)
        .env("STACKS_NATIVE_TERMINAL_SOCKET", &socket_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("Could not start native terminal helper: {error}"))?;

    // Wait for the helper to connect. GUI startup is fast but not instant.
    let accept_deadline = Instant::now() + Duration::from_secs(10);
    if listener.set_nonblocking(true).is_err() {
        let _ = child.kill();
        return Err("Could not configure native terminal socket".into());
    }
    let stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break Some(stream),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= accept_deadline {
                    break None;
                }
                if let Ok(Some(status)) = child.try_wait() {
                    let _ = std::fs::remove_file(&socket_path);
                    return Err(format!(
                        "Native terminal helper exited during startup ({status})"
                    ));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = std::fs::remove_file(&socket_path);
                return Err(format!("Native terminal socket error: {error}"));
            }
        }
    };
    let Some(stream) = stream else {
        let _ = child.kill();
        let _ = std::fs::remove_file(&socket_path);
        return Err("Native terminal helper did not connect to Stacks".into());
    };
    // On macOS/BSD an accepted socket inherits the listener's O_NONBLOCK flag.
    // The listener is polled non-blocking, so clear it on the connection or the
    // event reader would immediately fail with EWOULDBLOCK and tear the bridge
    // down right after the first command.
    if let Err(error) = stream.set_nonblocking(false) {
        let _ = child.kill();
        let _ = std::fs::remove_file(&socket_path);
        return Err(format!("Could not configure native terminal socket: {error}"));
    }
    native_debug!("native terminal: helper connected");
    let writer = stream
        .try_clone()
        .map_err(|error| format!("Could not clone native terminal socket: {error}"))?;
    {
        let mut inner = state.inner.lock().unwrap_or_else(|poison| poison.into_inner());
        inner.socket_path = Some(socket_path.clone());
        inner.child = Some(child);
        inner.writer = Some(writer);
        inner.ready = true;
        inner.visible = false;
        inner.last_error = None;
        // A successful launch re-arms the lazy relaunch path used after the
        // helper window/app exits.
        inner.launch_attempted = false;
    }
    let state_for_thread = state.clone();
    let app_for_thread = app.clone();
    std::thread::Builder::new()
        .name("stacks-native-terminal-events".into())
        .spawn(move || read_events(app_for_thread, state_for_thread, stream))
        .map_err(|error| format!("Could not start native terminal event reader: {error}"))?;
    Ok(())
}

fn read_events(app: AppHandle, state: NativeTerminalState, stream: UnixStream) {
    native_debug!("native terminal: event reader started");
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                native_debug!("native terminal <- {}", line.trim_end());
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(event) = serde_json::from_str::<Value>(&line) else {
                    native_debug!("native terminal: unparsable event {line:?}");
                    continue;
                };
                handle_event(&app, &state, &event);
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::Interrupted =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => {
                eprintln!("native terminal: event read error: {error}");
                break;
            }
        }
    }
    native_debug!("native terminal: event stream closed");
    let mut inner = state.inner.lock().unwrap_or_else(|poison| poison.into_inner());
    inner.ready = false;
    inner.visible = false;
    inner.writer = None;
    if let Some(mut child) = inner.child.take() {
        let _ = child.try_wait();
    }
    if let Some(path) = inner.socket_path.take() {
        let _ = std::fs::remove_file(path);
    }
    drop(inner);
    let _ = app.emit(EVENT_NAME, serde_json::json!({ "event": "exit" }));
}

fn handle_event(app: &AppHandle, state: &NativeTerminalState, event: &Value) {
    native_debug!("native terminal: event {event}");
    let Some(kind) = event.get("event").and_then(Value::as_str) else {
        return;
    };
    match kind {
        "visibility" => {
            let visible = event
                .get("visible")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            {
                let mut inner = state.inner.lock().unwrap_or_else(|poison| poison.into_inner());
                inner.visible = visible;
            }
            if !visible {
                activate_stacks(app);
            }
        }
        "ready" => {
            let mut inner = state.inner.lock().unwrap_or_else(|poison| poison.into_inner());
            inner.ready = true;
        }
        _ => {}
    }
    let _ = app.emit(EVENT_NAME, event.clone());
}

/// Give keyboard focus back to Stacks when the native terminal hides. This is
/// the other half of the focus hand-off: the helper activates itself on show.
fn activate_stacks(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn send(state: &NativeTerminalState, payload: &Value) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap_or_else(|poison| poison.into_inner());
    let Some(stream) = inner.writer.as_mut() else {
        set_error(&mut inner, "Native terminal is not running");
        return Err("Native terminal is not running".into());
    };
    let line = format!("{payload}\n");
    native_debug!("native terminal: writing {line}");
    if let Err(error) = stream
        .write_all(line.as_bytes())
        .and_then(|()| stream.flush())
    {
        inner.writer = None;
        inner.ready = false;
        set_error(&mut inner, format!("Native terminal write failed: {error}"));
        return Err(error.to_string());
    }
    Ok(())
}

pub fn stop(state: &NativeTerminalState) {
    eprintln!("native terminal: stop requested");
    let mut inner = state.inner.lock().unwrap_or_else(|poison| poison.into_inner());
    if let Some(stream) = inner.writer.as_mut() {
        let _ = stream.write_all(b"{\"command\":\"quit\"}\n");
        let _ = stream.flush();
    }
    let Some(mut child) = inner.child.take() else {
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    inner.writer = None;
    inner.ready = false;
    inner.visible = false;
    if let Some(path) = inner.socket_path.take() {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_requires_an_explicit_yes() {
        unsafe { std::env::remove_var(ENABLE_ENV) };
        assert!(!enabled());
        unsafe { std::env::set_var(ENABLE_ENV, "0") };
        assert!(!enabled());
        unsafe { std::env::set_var(ENABLE_ENV, "1") };
        assert_eq!(enabled(), cfg!(target_os = "macos"));
        unsafe { std::env::remove_var(ENABLE_ENV) };
    }
}
