#[cfg(unix)]
use std::os::unix::{
    fs::PermissionsExt,
    net::{UnixListener, UnixStream},
};
use std::{
    io::{BufRead, BufReader, Read, Write},
    time::Duration,
};
use tauri::{AppHandle, Manager};

use super::{
    protocol::{AutomationResponse, ClientRequest},
    socket_path,
    state::AutomationState,
    MAX_REQUEST_BYTES,
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
fn handle_connection(mut stream: UnixStream, app: AppHandle, _state: AutomationState) {
    let result = read_client_request(&stream).and_then(|client_request| {
        if client_request.action == "activate" {
            focus_main_window(&app)?;
            return Ok(AutomationResponse::success("Activated Stacks"));
        }
        if client_request.action == "createLocalCard" {
            let project_id = client_request
                .project_id
                .as_deref()
                .ok_or_else(|| "A Stacks-scoped project ID is required".to_string())?;
            let title = client_request
                .title
                .as_deref()
                .ok_or_else(|| "A card title is required".to_string())?;
            let card = crate::kanban::create_local_card_for_project(
                project_id,
                title,
                client_request.description.as_deref().unwrap_or(""),
            )?;
            // The revisioned board event is emitted best-effort by the committed
            // mutation. Delivery failure must not turn a successful create into
            // an automation error that invites an unsafe retry.
            return Ok(AutomationResponse::success(format!(
                "Created local card #{} in Needs refinement for {}",
                card.number(),
                card.board_title()
            )));
        }
        if client_request.action == "updateLocalCard" {
            let card_id = client_request
                .card_id
                .as_deref()
                .ok_or_else(|| "A scoped card ID is required".to_string())?;
            crate::kanban::kanban_update_local_card(
                card_id.to_string(),
                client_request.title,
                client_request.content,
                client_request.parent_id,
                client_request.parent_specified,
            )?;
            return Ok(AutomationResponse::success("Updated the local card"));
        }
        if client_request.action == "finishLocalCardRefinement" {
            let card_id = client_request
                .card_id
                .ok_or_else(|| "A scoped card ID is required".to_string())?;
            let content = client_request
                .content
                .ok_or_else(|| "A final card description is required".to_string())?;
            crate::kanban::kanban_finish_local_refinement(
                card_id,
                client_request.title,
                content,
                client_request.children,
            )?;
            return Ok(AutomationResponse::success(
                "Saved the final brief and finished refinement",
            ));
        }
        if client_request.action == "finishExternalCardRefinement" {
            let card_id = client_request
                .card_id
                .ok_or_else(|| "A scoped card ID is required".to_string())?;
            crate::kanban::kanban_finish_external_refinement(card_id)?;
            return Ok(AutomationResponse::success(
                "Finished refinement and moved the card to Ready for agent",
            ));
        }

        Err(format!(
            "Unsupported Stacks automation action: {}",
            client_request.action
        ))
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
