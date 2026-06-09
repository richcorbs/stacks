use tauri::{Emitter, LogicalPosition, LogicalSize, Manager};

use crate::settings::{load_window_state, reset_settings_file};

pub fn handle_menu_event(app: &tauri::AppHandle, id: &str) {
    if id == "reset-settings" {
        if let Err(err) = reset_settings_file() {
            eprintln!("failed to reset settings: {err}");
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit("app-toast", "Window settings reset");
        }
    } else if let Some(action) = id.strip_prefix("menu-shortcut-") {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit("menu-shortcut", action);
        }
    }
}

pub fn setup_main_window(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(window) = app.get_webview_window("main") {
        let title = if cfg!(debug_assertions) {
            "Stacks - DEV BUILD"
        } else {
            "Stacks"
        };
        let _ = window.set_title(title);
        if let Some(state) = load_window_state() {
            let width = state.width().clamp(780, 10_000);
            let height = state.height().clamp(500, 10_000);
            let _ = window.set_size(LogicalSize::new(width, height));
            if let (Some(x), Some(y)) = (state.x(), state.y()) {
                let _ = window.set_position(LogicalPosition::new(x, y));
            }
        }
    }
    Ok(())
}
