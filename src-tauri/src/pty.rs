use portable_pty::{native_pty_system, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    sync::Mutex,
    thread,
};
use tauri::{Emitter, State, Window};

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
    cols: u16,
    rows: u16,
) -> Result<(), String> {
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
        .spawn_command(build_shell_command(cwd, command))
        .map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    {
        let mut guard = registry
            .lock()
            .map_err(|_| "PTY registry lock poisoned".to_string())?;
        if let Some(mut old) = guard.terminals.remove(&terminal_id) {
            terminate_pty_child(old.child.as_mut());
        }
        guard.terminals.insert(
            terminal_id.clone(),
            PtyHandle {
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
        let _ = window.emit(
            "pty-exit",
            PtyExit {
                terminal_id,
                generation,
                status: None,
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
) -> Result<(), String> {
    kill_ptys(registry.inner(), &[terminal_id])
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

pub(crate) fn kill_ptys(
    registry: &Mutex<PtyRegistry>,
    terminal_ids: &[String],
) -> Result<(), String> {
    let handles = {
        let mut guard = registry
            .lock()
            .map_err(|_| "PTY registry lock poisoned".to_string())?;
        terminal_ids
            .iter()
            .filter_map(|id| guard.terminals.remove(id))
            .collect::<Vec<_>>()
    };
    for mut handle in handles {
        terminate_pty_child(handle.child.as_mut());
    }
    Ok(())
}

fn terminate_pty_child(child: &mut dyn portable_pty::Child) {
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
            unsafe { libc::kill(-*group_id, libc::SIGTERM) };
        }
        for process_id in &process_ids {
            unsafe { libc::kill(*process_id as i32, libc::SIGTERM) };
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        for group_id in &groups {
            unsafe { libc::kill(-*group_id, libc::SIGKILL) };
        }
        for process_id in &process_ids {
            unsafe { libc::kill(*process_id as i32, libc::SIGKILL) };
        }
    }
    let _ = child.kill();
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
