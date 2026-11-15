//! The Stacks automation socket, served by a native host.
//!
//! Pi's bundled Stacks extension talks to this socket for card tools, and the
//! native Pi pane reports `agent_start` / `agent_settled` through the same
//! channel. Serving it also gives the TUI single-instance ownership: a second
//! Stacks cannot bind the same path.

use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};

use crate::{
    paths,
    store::{ApprovedChildSpec, CardStore},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationResponse {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

impl AutomationResponse {
    pub fn success(message: impl Into<String>) -> Self {
        Self {
            ok: true,
            message: message.into(),
            exit_code: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: message.into(),
            exit_code: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRequest {
    pub action: String,
    #[serde(default)]
    pub card_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub parent_specified: Option<bool>,
    #[serde(default)]
    pub children: Option<Vec<ApprovedChildSpec>>,
    #[serde(default)]
    pub thread: Option<String>,
    #[serde(default)]
    pub phase: Option<String>,
}

/// The host observes automation side effects. Lifecycle changes must refresh
/// the board without the UI polling.
pub trait AutomationHost: Send + Sync {
    fn state_changed(&self, card_id: &str);
    fn notify(&self, message: &str);
}

#[derive(Debug)]
pub struct AutomationGuard {
    path: PathBuf,
}

impl AutomationGuard {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for AutomationGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

pub fn start(store: CardStore, host: Arc<dyn AutomationHost>) -> Result<AutomationGuard, String> {
    let path = match std::env::var_os("STACKS_TUI_AUTOMATION_SOCKET") {
        Some(path) => PathBuf::from(path),
        None => paths::automation_socket_path()?,
    };
    start_at(path, store, host)
}

#[cfg(unix)]
pub fn start_at(
    path: PathBuf,
    store: CardStore,
    host: Arc<dyn AutomationHost>,
) -> Result<AutomationGuard, String> {
    use std::os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    };

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
    }
    if path.exists() {
        if UnixStream::connect(&path).is_ok() {
            return Err(format!(
                "Another Stacks instance is already listening at {}. Quit it before starting stacks-tui.",
                path.display()
            ));
        }
        std::fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    let listener = UnixListener::bind(&path)
        .map_err(|error| format!("Could not bind {}: {error}", path.display()))?;
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));

    let guard = AutomationGuard { path: path.clone() };
    std::thread::Builder::new()
        .name("stacks-tui-automation".into())
        .spawn(move || {
            for connection in listener.incoming() {
                match connection {
                    Ok(stream) => {
                        let store = store.clone();
                        let host = Arc::clone(&host);
                        let _ = std::thread::Builder::new()
                            .name("stacks-tui-automation-request".into())
                            .spawn(move || {
                                if let Err(error) = handle_connection(stream, &store, host.as_ref())
                                {
                                    eprintln!("automation request failed: {error}");
                                }
                            });
                    }
                    Err(error) => {
                        eprintln!("automation accept failed: {error}");
                        break;
                    }
                }
            }
        })
        .map_err(|error| format!("Could not start the automation server: {error}"))?;
    Ok(guard)
}

#[cfg(not(unix))]
pub fn start_at(
    _path: PathBuf,
    _store: CardStore,
    _host: Arc<dyn AutomationHost>,
) -> Result<AutomationGuard, String> {
    Err("The Stacks automation socket is only implemented on Unix".to_string())
}

#[cfg(unix)]
fn handle_connection(
    mut stream: std::os::unix::net::UnixStream,
    store: &CardStore,
    host: &dyn AutomationHost,
) -> Result<(), String> {
    use std::io::Read;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(10)))
        .map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?)
        .take(1024 * 1024 + 1);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| format!("Could not read the automation request: {error}"))?;
    if line.len() > 1024 * 1024 {
        return Err("Automation request is too large".to_string());
    }
    let request: AutomationRequest = serde_json::from_str(&line)
        .map_err(|error| format!("Invalid automation request: {error}"))?;
    let response = handle_request(request, store, host);
    let json = serde_json::to_string(&response).map_err(|error| error.to_string())?;
    let _ = writeln!(stream, "{json}");
    Ok(())
}

pub fn handle_request(
    request: AutomationRequest,
    store: &CardStore,
    host: &dyn AutomationHost,
) -> AutomationResponse {
    match dispatch(request, store, host) {
        Ok(message) => AutomationResponse::success(message),
        Err(error) => AutomationResponse::error(error),
    }
}

fn dispatch(
    request: AutomationRequest,
    store: &CardStore,
    host: &dyn AutomationHost,
) -> Result<String, String> {
    match request.action.as_str() {
        "activate" => {
            host.notify("Stacks TUI is ready");
            Ok("Stacks TUI is already active".into())
        }
        "createLocalCard" => {
            let project_id = request
                .project_id
                .as_deref()
                .ok_or_else(|| "A Stacks-scoped project ID is required".to_string())?;
            let title = request
                .title
                .as_deref()
                .ok_or_else(|| "A card title is required".to_string())?;
            let card_id = store
                .create_card(
                    project_id,
                    title,
                    request.description.as_deref().unwrap_or(""),
                )
                .map_err(|error| error.to_string())?;
            host.state_changed(&card_id);
            let detail = store
                .load_detail(&card_id)
                .map_err(|error| error.to_string())?;
            Ok(format!(
                "Created local card #{} in Needs refinement for {}",
                detail.card.external_id, detail.card.board_title
            ))
        }
        "updateLocalCard" => {
            let card_id = request
                .card_id
                .as_deref()
                .ok_or_else(|| "A scoped card ID is required".to_string())?;
            if request.parent_specified.unwrap_or(false) {
                return Err("Changing a card's parent is not available from stacks-tui yet".into());
            }
            let detail = store
                .load_detail(card_id)
                .map_err(|error| error.to_string())?;
            store
                .update_card(
                    card_id,
                    detail.card.workflow_revision,
                    request.title.as_deref(),
                    request.content.as_deref(),
                )
                .map_err(|error| error.to_string())?;
            host.state_changed(card_id);
            Ok("Updated the local card".into())
        }
        "finishLocalCardRefinement" => {
            let card_id = request
                .card_id
                .as_deref()
                .ok_or_else(|| "A scoped card ID is required".to_string())?;
            let content = request
                .content
                .as_deref()
                .ok_or_else(|| "A final card description is required".to_string())?;
            let detail = store
                .load_detail(card_id)
                .map_err(|error| error.to_string())?;
            store
                .finish_refinement_with_children(
                    card_id,
                    detail.card.workflow_revision,
                    request.title.as_deref(),
                    content,
                    request.children.as_deref(),
                )
                .map_err(|error| error.to_string())?;
            host.state_changed(card_id);
            Ok("Saved the final brief and finished refinement".into())
        }
        "startLocalCardWork" => {
            let card_id = request
                .card_id
                .as_deref()
                .ok_or_else(|| "A scoped card ID is required".to_string())?;
            let detail = store
                .load_detail(card_id)
                .map_err(|error| error.to_string())?;
            if let Some(environment) = &detail.card.environment {
                host.state_changed(card_id);
                return Ok(format!(
                    "Work is already started on {} ({})",
                    environment.branch, environment.worktree_path
                ));
            }
            store
                .start_local_work(card_id, detail.card.workflow_revision)
                .map_err(|error| error.to_string())?;
            host.state_changed(card_id);
            let detail = store
                .load_detail(card_id)
                .map_err(|error| error.to_string())?;
            match &detail.card.environment {
                Some(environment) => Ok(format!(
                    "Started work on {} ({})",
                    environment.branch, environment.worktree_path
                )),
                None => Ok("Started work".into()),
            }
        }
        "finishExternalCardRefinement" => Err(
            "Superthread refinement is not available from stacks-tui yet; use the Stacks app"
                .into(),
        ),
        "agentLifecycle" => {
            let card_id = request
                .card_id
                .as_deref()
                .ok_or_else(|| "A scoped card ID is required".to_string())?;
            let thread = request.thread.as_deref().unwrap_or("planning");
            let phase = request.phase.as_deref().unwrap_or("settled");
            let intent = match phase {
                "started" => "agent_started",
                "settled" => "agent_settled",
                "failed" => "protocol_failed",
                other => return Err(format!("Unknown agent lifecycle phase: {other}")),
            };
            let changed = store
                .apply_agent_lifecycle(card_id, thread, intent)
                .map_err(|error| error.to_string())?;
            host.state_changed(card_id);
            Ok(match changed {
                Some(status) => format!("Card status is now {status}"),
                None => "Lifecycle recorded".into(),
            })
        }
        other => Err(format!("Unsupported Stacks automation action: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Host;
    impl AutomationHost for Host {
        fn state_changed(&self, _card_id: &str) {}
        fn notify(&self, _message: &str) {}
    }

    #[test]
    fn unsupported_actions_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let store = CardStore::new(dir.path().join("workflow.sqlite3"));
        let response = handle_request(
            AutomationRequest {
                action: "nope".into(),
                card_id: None,
                project_id: None,
                title: None,
                content: None,
                description: None,
                parent_id: None,
                parent_specified: None,
                children: None,
                thread: None,
                phase: None,
            },
            &store,
            &Host,
        );
        assert!(!response.ok);
        assert!(response.message.contains("Unsupported"));
    }

    #[test]
    fn activate_is_supported() {
        let dir = tempfile::tempdir().unwrap();
        let store = CardStore::new(dir.path().join("workflow.sqlite3"));
        let response = handle_request(
            AutomationRequest {
                action: "activate".into(),
                card_id: None,
                project_id: None,
                title: None,
                content: None,
                description: None,
                parent_id: None,
                parent_specified: None,
                children: None,
                thread: None,
                phase: None,
            },
            &store,
            &Host,
        );
        assert!(response.ok);
    }

    #[cfg(unix)]
    #[test]
    fn a_second_automation_server_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = CardStore::new(dir.path().join("workflow.sqlite3"));
        let path = dir.path().join("automation.sock");
        let guard = start_at(path.clone(), store.clone(), Arc::new(Host)).unwrap();
        let error = start_at(path, store, Arc::new(Host)).unwrap_err();
        assert!(error.contains("already listening"), "{error}");
        drop(guard);
    }
}
