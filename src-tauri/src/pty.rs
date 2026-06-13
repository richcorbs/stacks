use portable_pty::{native_pty_system, PtySize};
use serde::{Deserialize, Serialize};
use std::{io::{Read, Write}, sync::Mutex, thread};
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
    let generation = generation.unwrap_or_else(|| format!("{}:{}", terminal_id, uuid::Uuid::new_v4()));
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let child = pair.slave.spawn_command(build_shell_command(cwd, command)).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    {
        let mut guard = registry.lock().map_err(|_| "PTY registry lock poisoned".to_string())?;
        if let Some(mut old) = guard.terminals.remove(&terminal_id) {
            let _ = old.child.kill();
        }
        guard.terminals.insert(terminal_id.clone(), PtyHandle { master: pair.master, writer, child });
    }

    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = window.emit("pty-data", PtyData { terminal_id: terminal_id.clone(), generation: generation.clone(), data: buf[..n].to_vec() });
                }
                Err(_) => break,
            }
        }
        let _ = window.emit("pty-exit", PtyExit { terminal_id, generation, status: None });
    });

    Ok(())
}

#[tauri::command]
pub fn write_pty(registry: State<'_, Mutex<PtyRegistry>>, terminal_id: String, data: Vec<u8>) -> Result<(), String> {
    let mut guard = registry.lock().map_err(|_| "PTY registry lock poisoned".to_string())?;
    let handle = guard.terminals.get_mut(&terminal_id).ok_or_else(|| "Unknown PTY terminal".to_string())?;
    handle.writer.write_all(&data).map_err(|e| e.to_string())?;
    handle.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resize_pty(registry: State<'_, Mutex<PtyRegistry>>, terminal_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let mut guard = registry.lock().map_err(|_| "PTY registry lock poisoned".to_string())?;
    let handle = guard.terminals.get_mut(&terminal_id).ok_or_else(|| "Unknown PTY terminal".to_string())?;
    handle.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn kill_pty(registry: State<'_, Mutex<PtyRegistry>>, terminal_id: String) -> Result<(), String> {
    let mut guard = registry.lock().map_err(|_| "PTY registry lock poisoned".to_string())?;
    if let Some(mut handle) = guard.terminals.remove(&terminal_id) {
        let _ = handle.child.kill();
    }
    Ok(())
}

