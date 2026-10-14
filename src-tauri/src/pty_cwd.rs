use std::{collections::HashMap, process::Command, sync::Mutex};

use portable_pty::{Child, MasterPty};
use tauri::State;

pub trait PtyProcessRegistry {
    fn process_id_for_terminal(&self, terminal_id: &str) -> Result<Option<u32>, String>;
}

pub struct PtyHandle {
    pub generation: String,
    pub managed_service: bool,
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn std::io::Write + Send>,
    pub child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyRegistry {
    pub terminals: HashMap<String, PtyHandle>,
}

impl PtyRegistry {
    pub(crate) fn busy_terminals(&self) -> Vec<String> {
        self.terminals.iter().filter_map(|(id, handle)| {
            if handle.managed_service || foreground_child_exists(handle.child.process_id()) {
                Some(id.clone())
            } else { None }
        }).collect()
    }
}

#[cfg(unix)]
fn foreground_child_exists(pid: Option<u32>) -> bool {
    let Some(pid) = pid else { return false };
    let output = Command::new("ps").args(["-axo", "pid=,ppid="]).output();
    let Ok(output) = output else { return false };
    let mut children = HashMap::<u32, Vec<u32>>::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split_whitespace();
        let (Some(child), Some(parent)) = (fields.next(), fields.next()) else { continue };
        if let (Ok(child), Ok(parent)) = (child.parse(), parent.parse()) {
            children.entry(parent).or_default().push(child);
        }
    }
    let mut pending = vec![pid];
    while let Some(parent) = pending.pop() {
        if let Some(descendants) = children.get(&parent) {
            if !descendants.is_empty() { return true; }
            pending.extend(descendants);
        }
    }
    false
}

#[cfg(not(unix))]
fn foreground_child_exists(_pid: Option<u32>) -> bool { false }

impl PtyProcessRegistry for PtyRegistry {
    fn process_id_for_terminal(&self, terminal_id: &str) -> Result<Option<u32>, String> {
        let handle = self
            .terminals
            .get(terminal_id)
            .ok_or_else(|| "Unknown PTY terminal".to_string())?;
        Ok(handle.child.process_id())
    }
}

#[tauri::command]
pub fn pty_cwd(
    registry: State<'_, Mutex<PtyRegistry>>,
    terminal_id: String,
) -> Result<Option<String>, String> {
    let pid = {
        let guard = registry
            .lock()
            .map_err(|_| "PTY registry lock poisoned".to_string())?;
        guard.process_id_for_terminal(&terminal_id)?
    };

    let Some(pid) = pid else {
        return Ok(None);
    };
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
