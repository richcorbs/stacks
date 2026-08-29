use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

mod app_events;
mod app_stats;
mod automation;
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
mod superthread;
use app_events::{handle_menu_event, setup_main_window};
use app_stats::app_stats;
use automation::{complete_automation_request, drain_automation_requests, AutomationState};
use git::git_info;
use menu::app_menu;
use open::{open_path_in_editor, open_url};
use pty::{kill_pty, resize_pty, spawn_pty, write_pty};
use pty_cwd::{pty_cwd, PtyRegistry};
use settings::{
    load_settings, reset_settings, save_app_settings, save_current_window_state,
    save_sidebar_width, save_terminal_font_size, save_window_state,
};
use store::{load_store, save_store};
use superthread::{
    superthread_board_cards, superthread_board_lists, superthread_boards, superthread_card,
    SuperthreadService,
};

#[tauri::command]
fn new_id() -> String {
    Uuid::new_v4().to_string()
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    if let Some(exit_code) = automation::handle_cli_invocation() {
        std::process::exit(exit_code);
    }
    if automation::activate_existing_instance() {
        return;
    }

    let automation_state = AutomationState::default();
    let run_result = tauri::Builder::default()
        .menu(|app| app_menu(app))
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(PtyRegistry::default()))
        .manage(automation_state.clone())
        .manage(SuperthreadService::default())
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
            drain_automation_requests,
            complete_automation_request,
            superthread_boards,
            superthread_board_lists,
            superthread_board_cards,
            superthread_card,
        ])
        .setup(|app| {
            setup_main_window(app)?;
            let state = app.state::<AutomationState>().inner().clone();
            if let Err(err) = automation::start_server(app.handle().clone(), state) {
                eprintln!("Stacks automation is unavailable: {err}");
            }
            Ok(())
        })
        .run(tauri::generate_context!());

    automation::cleanup_server(&automation_state);
    run_result.expect("error while running tauri application");
}
