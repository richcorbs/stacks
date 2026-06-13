use std::{collections::HashMap, process::Command, sync::Mutex};

use portable_pty::{Child, MasterPty};
use tauri::State;

pub trait PtyProcessRegistry {
    fn process_id_for_terminal(&self, terminal_id: &str) -> Result<Option<u32>, String>;
}

pub struct PtyHandle {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn std::io::Write + Send>,
    pub child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyRegistry {
    pub terminals: HashMap<String, PtyHandle>,
}

impl PtyProcessRegistry for PtyRegistry {
    fn process_id_for_terminal(&self, terminal_id: &str) -> Result<Option<u32>, String> {
        let handle = self.terminals.get(terminal_id).ok_or_else(|| "Unknown PTY terminal".to_string())?;
        Ok(handle.child.process_id())
    }
}

#[tauri::command]
pub fn pty_cwd(registry: State<'_, Mutex<PtyRegistry>>, terminal_id: String) -> Result<Option<String>, String> {
    let pid = {
        let guard = registry.lock().map_err(|_| "PTY registry lock poisoned".to_string())?;
        guard.process_id_for_terminal(&terminal_id)?
    };

    let Some(pid) = pid else { return Ok(None); };
    let output = Command::new("lsof")
        .args(["-a", "-d", "cwd", "-p", &pid.to_string(), "-Fn"])
        .output()
        .map_err(|err| err.to_string())?;

    if !output.status.success() {
        return Ok(None);
    }

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(cwd) = line.strip_prefix('n') {
            return Ok(Some(cwd.to_string()));
        }
    }
    Ok(None)
}
