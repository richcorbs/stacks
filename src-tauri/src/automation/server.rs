use std::{
    io::{BufRead, BufReader, Read, Write},
    sync::mpsc,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

#[cfg(unix)]
use std::os::unix::{
    fs::PermissionsExt,
    net::{UnixListener, UnixStream},
};

use super::{
    protocol::{AutomationRequest, AutomationResponse, ClientRequest},
    socket_path,
    state::AutomationState,
    AUTOMATION_EVENT, MAX_REQUEST_BYTES, RESPONSE_TIMEOUT,
};

#[cfg(unix)]
pub fn start_server(app: AppHandle, state: AutomationState) -> Result<(), String> {
    let path = socket_path()?;
    if let Some(parent) = path.parent() {
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|err| format!("failed to secure automation directory: {err}"))?;
    }
    if path.exists() {
        if UnixStream::connect(&path).is_ok() {
            return Err(format!(
                "another Stacks automation server is already listening at {}",
                path.display()
            ));
        }
        std::fs::remove_file(&path)
            .map_err(|err| format!("failed to remove stale automation socket: {err}"))?;
    }

    let listener = UnixListener::bind(&path)
        .map_err(|err| format!("failed to bind automation socket {}: {err}", path.display()))?;
    if let Err(err) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
        let _ = std::fs::remove_file(&path);
        return Err(format!("failed to secure automation socket: {err}"));
    }
    state.mark_socket_owned();

    std::thread::spawn(move || {
        for connection in listener.incoming() {
            match connection {
                Ok(stream) => {
                    let app = app.clone();
                    let state = state.clone();
                    std::thread::spawn(move || handle_connection(stream, app, state));
                }
                Err(err) => eprintln!("automation socket accept failed: {err}"),
            }
        }
    });
    Ok(())
}

#[cfg(not(unix))]
pub fn start_server(_app: AppHandle, _state: AutomationState) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn handle_connection(mut stream: UnixStream, app: AppHandle, state: AutomationState) {
    let result = read_client_request(&stream).and_then(|client_request| {
        if client_request.action == "activate" {
            focus_main_window(&app)?;
            return Ok(AutomationResponse::success("Activated Stacks"));
        }

        let request = AutomationRequest {
            request_id: Uuid::new_v4().to_string(),
            action: client_request.action,
            name: client_request.name,
            startup_command: client_request.startup_command,
            run_once: client_request.run_once,
        };
        let (response_tx, response_rx) = mpsc::channel();
        state.insert(request.clone(), response_tx);
        if let Err(err) = focus_main_window(&app) {
            state.remove(&request.request_id);
            return Err(err);
        }

        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Stacks main window is unavailable".to_string())?;
        if let Err(err) = window.emit(AUTOMATION_EVENT, &request) {
            state.remove(&request.request_id);
            return Err(format!("failed to notify Stacks frontend: {err}"));
        }

        match response_rx.recv_timeout(RESPONSE_TIMEOUT) {
            Ok(response) => Ok(response),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                state.remove(&request.request_id);
                Err("Stacks did not process the request within 11 minutes".into())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                state.remove(&request.request_id);
                Err("Stacks dropped the automation request".into())
            }
        }
    });

    let response = result.unwrap_or_else(AutomationResponse::error);
    if let Ok(json) = serde_json::to_string(&response) {
        let _ = writeln!(stream, "{json}");
    }
}

fn focus_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Stacks main window is unavailable".to_string())?;
    let _ = window.show();
    let _ = window.unminimize();
    window.set_focus().map_err(|err| err.to_string())
}

#[cfg(unix)]
fn read_client_request(stream: &UnixStream) -> Result<ClientRequest, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|err| err.to_string())?;
    let mut reader = BufReader::new(stream).take(MAX_REQUEST_BYTES + 1);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|err| format!("failed to read automation request: {err}"))?;
    if line.len() as u64 > MAX_REQUEST_BYTES {
        return Err("automation request is too large".into());
    }
    serde_json::from_str(&line).map_err(|err| format!("invalid automation request: {err}"))
}
