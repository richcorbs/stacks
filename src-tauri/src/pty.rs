use portable_pty::{native_pty_system, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    sync::Mutex,
    thread,
};
use tauri::{Emitter, Manager, State, Window};

// Serialize release starts, including openpty/spawn/registry insertion.
static RELEASE_START: Mutex<()> = Mutex::new(());

use crate::pty_command::build_shell_command;
use crate::pty_cwd::{PtyHandle, PtyRegistry};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PtyData {
    terminal_id: String,
    generation: String,
    data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PtyExit {
    terminal_id: String,
    generation: String,
    status: Option<i32>,
}

#[allow(clippy::too_many_arguments)] // Tauri command arguments mirror the frontend invoke contract.
#[tauri::command]
pub fn spawn_pty(
    window: Window,
    registry: State<'_, Mutex<PtyRegistry>>,
    terminal_id: String,
    generation: Option<String>,
    cwd: String,
    command: Option<String>,
    managed_service: Option<bool>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let _card_resource_guard = if crate::kanban::card_terminal_owner(&terminal_id).is_some() {
        Some(
            crate::kanban::CARD_RESOURCE_START_LOCK
                .lock()
                .map_err(|_| "Card resource lock failed".to_string())?,
        )
    } else {
        None
    };
    let is_release = terminal_id.starts_with("release:");
    let _release_guard = if is_release {
        Some(
            RELEASE_START
                .lock()
                .map_err(|_| "Release start lock failed")?,
        )
    } else {
        None
    };
    if is_release {
        let mut guard = registry.lock().map_err(|_| "PTY registry lock poisoned")?;
        if let Some(handle) = guard.terminals.get_mut(&terminal_id) {
            if handle
                .child
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_none()
            {
                return Err("A release is already running for this repository".into());
            }
        }
        if !managed_service.unwrap_or(false) {
            return Err("Release terminals must exit with their command".into());
        }
    }
    let generation =
        generation.unwrap_or_else(|| format!("{}:{}", terminal_id, uuid::Uuid::new_v4()));
    let command = crate::kanban::validate_card_terminal_start(&terminal_id, &cwd, command)?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let child = pair
        .slave
        .spawn_command(build_shell_command(
            cwd,
            command,
            managed_service.unwrap_or(false),
        ))
        .map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    {
        let mut guard = registry
            .lock()
            .map_err(|_| "PTY registry lock poisoned".to_string())?;
        if let Some(mut old) = guard.terminals.remove(&terminal_id) {
            let _ = terminate_pty_child(old.child.as_mut());
        }
        guard.terminals.insert(
            terminal_id.clone(),
            PtyHandle {
                generation: generation.clone(),
                managed_service: managed_service.unwrap_or(false),
                master: pair.master,
                writer,
                child,
            },
        );
    }

    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = window.emit(
                        "pty-data",
                        PtyData {
                            terminal_id: terminal_id.clone(),
                            generation: generation.clone(),
                            data: buf[..n].to_vec(),
                        },
                    );
                }
                Err(_) => break,
            }
        }
        // Reap the matching child, not a replacement with the same terminal ID.
        // EOF can precede child exit slightly; poll without blocking registry users.
        let status = loop {
            let registry = window.state::<Mutex<PtyRegistry>>();
            let Ok(mut guard) = registry.lock() else {
                break None;
            };
            let Some(handle) = guard
                .terminals
                .get_mut(&terminal_id)
                .filter(|h| h.generation == generation)
            else {
                break None;
            };
            match handle.child.try_wait() {
                Ok(Some(status)) => {
                    handle.managed_service = false;
                    break Some(status.exit_code() as i32);
                }
                Err(_) => break None,
                Ok(None) => {}
            }
            drop(guard);
            thread::sleep(std::time::Duration::from_millis(20));
        };
        let _ = window.emit(
            "pty-exit",
            PtyExit {
                terminal_id,
                generation,
                status,
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub fn write_pty(
    registry: State<'_, Mutex<PtyRegistry>>,
    terminal_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let mut guard = registry
        .lock()
        .map_err(|_| "PTY registry lock poisoned".to_string())?;
    let handle = guard
        .terminals
        .get_mut(&terminal_id)
        .ok_or_else(|| "Unknown PTY terminal".to_string())?;
    handle.writer.write_all(&data).map_err(|e| e.to_string())?;
    handle.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resize_pty(
    registry: State<'_, Mutex<PtyRegistry>>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut guard = registry
        .lock()
        .map_err(|_| "PTY registry lock poisoned".to_string())?;
    let handle = guard
        .terminals
        .get_mut(&terminal_id)
        .ok_or_else(|| "Unknown PTY terminal".to_string())?;
    handle
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn kill_pty(
    registry: State<'_, Mutex<PtyRegistry>>,
    terminal_id: String,
    _expected_cwd: Option<String>,
    expected_generation: Option<String>,
) -> Result<(), String> {
    let Some(expected_generation) = expected_generation else {
        return kill_ptys(registry.inner(), &[terminal_id]);
    };
    let handle = {
        let mut guard = registry
            .lock()
            .map_err(|_| "PTY registry lock poisoned".to_string())?;
        if !guard
            .terminals
            .get(&terminal_id)
            .is_some_and(|handle| handle.generation == expected_generation)
        {
            return Ok(());
        }
        guard.terminals.remove(&terminal_id)
    };
    let Some(mut handle) = handle else {
        return Ok(());
    };
    if let Err(error) = terminate_pty_child(handle.child.as_mut()) {
        registry
            .lock()
            .map_err(|_| "PTY registry lock poisoned".to_string())?
            .terminals
            .entry(terminal_id)
            .or_insert(handle);
        return Err(error);
    }
    Ok(())
}

pub(crate) fn kill_ptys_with_prefix(
    registry: &Mutex<PtyRegistry>,
    prefix: &str,
) -> Result<Vec<String>, String> {
    let terminal_ids = {
        let guard = registry
            .lock()
            .map_err(|_| "PTY registry lock poisoned".to_string())?;
        guard
            .terminals
            .keys()
            .filter(|id| id.starts_with(prefix))
            .cloned()
            .collect::<Vec<_>>()
    };
    kill_ptys(registry, &terminal_ids)?;
    Ok(terminal_ids)
}

pub(crate) fn card_pty_runtime_ids(
    registry: &Mutex<PtyRegistry>,
    card_id: &str,
) -> Result<Vec<String>, String> {
    let guard = registry
        .lock()
        .map_err(|_| "PTY registry lock poisoned".to_string())?;
    Ok(guard
        .terminals
        .keys()
        .filter(|id| crate::kanban::card_terminal_owner(id).as_deref() == Some(card_id))
        .cloned()
        .collect())
}

pub(crate) fn kill_ptys(
    registry: &Mutex<PtyRegistry>,
    terminal_ids: &[String],
) -> Result<(), String> {
    let mut failures = Vec::new();
    for terminal_id in terminal_ids {
        let handle = registry
            .lock()
            .map_err(|_| "PTY registry lock poisoned".to_string())?
            .terminals
            .remove(terminal_id);
        let Some(mut handle) = handle else { continue };
        if let Err(error) = terminate_pty_child(handle.child.as_mut()) {
            registry
                .lock()
                .map_err(|_| "PTY registry lock poisoned".to_string())?
                .terminals
                .insert(terminal_id.clone(), handle);
            failures.push(format!("{terminal_id}: {error}"));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn terminate_pty_child(child: &mut dyn portable_pty::Child) -> Result<(), String> {
    let mut failures = Vec::new();
    #[cfg(unix)]
    if let Some(pid) = child.process_id() {
        // Procfile runners may put Rails and Solid Queue into child process
        // groups. Capture the complete tree before killing the shell, while
        // parent/child relationships are still available.
        let process_ids = descendant_process_ids(pid);
        let own_group = unsafe { libc::getpgrp() };
        let mut groups = std::collections::HashSet::new();
        for process_id in &process_ids {
            let group_id = unsafe { libc::getpgid(*process_id as i32) };
            if group_id > 0 && group_id != own_group {
                groups.insert(group_id);
            }
        }
        for group_id in &groups {
            let result = unsafe { libc::kill(-*group_id, libc::SIGTERM) };
            if result != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
                failures.push(format!(
                    "could not terminate process group {group_id}: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        for process_id in &process_ids {
            let result = unsafe { libc::kill(*process_id as i32, libc::SIGTERM) };
            if result != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
                failures.push(format!(
                    "could not terminate process {process_id}: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        for group_id in &groups {
            let result = unsafe { libc::kill(-*group_id, libc::SIGKILL) };
            if result != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
                failures.push(format!(
                    "could not kill process group {group_id}: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        for process_id in &process_ids {
            let result = unsafe { libc::kill(*process_id as i32, libc::SIGKILL) };
            if result != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
                failures.push(format!(
                    "could not kill process {process_id}: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
    }
    if let Err(error) = child.kill() {
        if child.try_wait().ok().flatten().is_none() {
            failures.push(format!("child kill failed: {error}"));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

#[cfg(unix)]
fn descendant_process_ids(root: u32) -> Vec<u32> {
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid="])
        .output();
    let Ok(output) = output else {
        return vec![root];
    };
    let mut children = std::collections::HashMap::<u32, Vec<u32>>::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (fields.next(), fields.next()) else {
            continue;
        };
        let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) else {
            continue;
        };
        children.entry(ppid).or_default().push(pid);
    }
    let mut result = vec![root];
    let mut index = 0;
    while index < result.len() {
        if let Some(direct_children) = children.get(&result[index]) {
            result.extend(direct_children);
        }
        index += 1;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_pty_streams_output_and_retains_actual_failure_exit_code() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = portable_pty::CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "printf 'Building\\n'; sleep 0.02; printf 'Failed\\n'; exit 7",
        ]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut output = Vec::new();
        let mut buf = [0; 128];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => output.extend_from_slice(&buf[..n]),
            }
        }
        assert_eq!(child.wait().unwrap().exit_code(), 7);
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("Building"));
        assert!(output.contains("Failed"));
    }
}
