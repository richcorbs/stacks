use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::State;

use crate::{pi_rpc::PiRpcRegistry, pty_cwd::PtyRegistry, release::ReleaseRegistry, workspace_setup::WorkspaceSetupState};

/// Backend-owned runtime view used by deferred updates. This intentionally does
/// not consider window visibility or which React view happens to be mounted.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IdleSnapshot {
    pub idle: bool,
    pub reasons: Vec<String>,
}

impl IdleSnapshot {
    pub fn collect(
        pi: &Mutex<PiRpcRegistry>,
        pty: &Mutex<PtyRegistry>,
        setup: &WorkspaceSetupState,
        releases: &Arc<ReleaseRegistry>,
    ) -> Self {
        let mut reasons = Vec::new();
        match pi.lock() {
            Ok(registry) if registry.busy_sessions() > 0 => reasons.push("Pi has active or pending work".into()),
            Err(_) => reasons.push("Pi runtime state is unavailable".into()),
            _ => {}
        }
        match pty.lock() {
            Ok(registry) if !registry.busy_terminals().is_empty() => reasons.push("A terminal command or managed service is running".into()),
            Err(_) => reasons.push("PTY runtime state is unavailable".into()),
            _ => {}
        }
        if setup.busy() > 0 { reasons.push("Workspace setup is running".into()); }
        if releases.busy() > 0 { reasons.push("A release operation is running".into()); }
        Self { idle: reasons.is_empty(), reasons }
    }
}

#[tauri::command]
pub fn app_idle_snapshot(
    pi: State<'_, Mutex<PiRpcRegistry>>,
    pty: State<'_, Mutex<PtyRegistry>>,
    setup: State<'_, WorkspaceSetupState>,
    releases: State<'_, Arc<ReleaseRegistry>>,
) -> IdleSnapshot {
    IdleSnapshot::collect(pi.inner(), pty.inner(), setup.inner(), releases.inner())
}

#[cfg(test)]
mod tests {
    use super::IdleSnapshot;

    #[test]
    fn empty_runtime_is_idle() {
        assert!(IdleSnapshot { idle: true, reasons: vec![] }.idle);
    }
}
