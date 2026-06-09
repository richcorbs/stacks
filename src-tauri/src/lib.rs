use std::sync::Mutex;
use tauri::AppHandle;
use uuid::Uuid;

mod app_events;
mod app_stats;
mod fs_paths;
mod git;
mod menu;
mod open;
mod pty;
mod pty_command;
mod pty_cwd;
mod settings;
mod settings_model;
mod store;
use app_events::{handle_menu_event, setup_main_window};
use app_stats::app_stats;
use git::git_info;
use menu::app_menu;
use open::{open_path_in_editor, open_url};
use pty::{kill_pty, resize_pty, spawn_pty, write_pty};
use pty_cwd::{pty_cwd, PtyRegistry};
use settings::{load_settings, save_window_state, save_current_window_state, save_sidebar_width, save_terminal_font_size, save_app_settings, reset_settings};
use store::{load_store, save_store};

#[tauri::command]
fn new_id() -> String {
    Uuid::new_v4().to_string()
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    tauri::Builder::default()
        .menu(|app| app_menu(app))
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(PtyRegistry::default()))
        .invoke_handler(tauri::generate_handler![
            load_store,
            save_store,
            load_settings,
            save_window_state,
            save_current_window_state,
            save_sidebar_width,
            save_terminal_font_size,
            save_app_settings,
            reset_settings,
            new_id,
            quit_app,
            open_path_in_editor,
            open_url,
            spawn_pty,
            write_pty,
            resize_pty,
            kill_pty,
            pty_cwd,
            app_stats,
            git_info,
        ])
        .setup(setup_main_window)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
