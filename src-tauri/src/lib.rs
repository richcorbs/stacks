use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

mod app_events;
mod automation;
mod fs_paths;
mod git;
mod github;
mod kanban;
mod menu;
mod open;
mod pi_image;
mod pi_rpc;
mod process_group;
mod project_direct;
mod pty;
mod pty_command;
mod pty_cwd;
mod settings;
mod settings_model;
mod store;
mod superthread;
mod workspace_setup;
use app_events::{handle_menu_event, setup_main_window};
use automation::AutomationState;
use git::{
    cleanup_git_worktree, git_change_summary, git_diff_files, git_file_diff, git_info,
    remove_git_worktree,
};
use github::{
    github_action_runs, github_current_pull_request, github_merge_pull_request,
    github_pull_requests,
};
use kanban::{
    kanban_abort_target_merge, kanban_apply_pi_lifecycle_intent, kanban_apply_workflow_action,
    kanban_approve_and_commit, kanban_card_snapshot, kanban_cards, kanban_cleanup_environment,
    kanban_cleanup_environment_creation, kanban_close_card, kanban_create_local_card,
    kanban_create_pull_request, kanban_delete_card, kanban_delete_project_records,
    kanban_environment_health, kanban_environment_start_preflight, kanban_finalize_target_merge,
    kanban_finish_local_refinement, kanban_merge_card, kanban_merge_pull_request, kanban_open_card,
    kanban_prepare_target_merge, kanban_refresh_pull_request, kanban_reorder_cards,
    kanban_retry_runtime_cleanup, kanban_save_environment_layout, kanban_set_merge_target,
    kanban_set_project, kanban_start_environment, kanban_status_metadata,
    kanban_sync_superthread_cards, kanban_update_local_card, kanban_validate_project_deletion,
};
use menu::app_menu;
use open::{open_path_in_editor, open_url};
use pi_image::read_pi_image;
use pi_rpc::{
    delete_pi_session, pi_project_trusted, send_pi_rpc, set_pi_project_trusted, start_pi_session,
    stop_pi_session, PiRpcRegistry,
};
use project_direct::{
    project_direct_delete, project_direct_load_or_create, project_direct_save_layout,
};
use pty::{kill_pty, resize_pty, spawn_pty, write_pty};
use pty_cwd::{pty_cwd, PtyRegistry};
use settings::{
    load_settings, reset_settings, save_app_settings, save_current_window_state, save_window_state,
};
use store::{load_store, save_store};
use superthread::{
    superthread_board_cards, superthread_board_lists, superthread_boards, superthread_card,
    superthread_create_card, SuperthreadService,
};
use workspace_setup::{cancel_workspace_setup, run_workspace_setup, WorkspaceSetupState};

#[tauri::command]
fn new_id() -> String {
    Uuid::new_v4().to_string()
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn restart_app(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    save_current_window_state(window)?;
    app.restart()
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
        .menu(app_menu)
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(PtyRegistry::default()))
        .manage(Mutex::new(PiRpcRegistry::default()))
        .manage(WorkspaceSetupState::default())
        .manage(automation_state.clone())
        .manage(SuperthreadService::default())
        .invoke_handler(tauri::generate_handler![
            load_store,
            save_store,
            load_settings,
            save_window_state,
            save_current_window_state,
            save_app_settings,
            reset_settings,
            new_id,
            quit_app,
            restart_app,
            open_path_in_editor,
            open_url,
            spawn_pty,
            write_pty,
            resize_pty,
            kill_pty,
            pty_cwd,
            start_pi_session,
            pi_project_trusted,
            set_pi_project_trusted,
            send_pi_rpc,
            read_pi_image,
            stop_pi_session,
            delete_pi_session,
            git_info,
            git_change_summary,
            git_diff_files,
            git_file_diff,
            remove_git_worktree,
            cleanup_git_worktree,
            github_pull_requests,
            github_current_pull_request,
            github_action_runs,
            github_merge_pull_request,
            kanban_cards,
            kanban_card_snapshot,
            kanban_create_local_card,
            kanban_update_local_card,
            kanban_finish_local_refinement,
            kanban_open_card,
            kanban_delete_card,
            kanban_validate_project_deletion,
            kanban_delete_project_records,
            kanban_sync_superthread_cards,
            kanban_apply_workflow_action,
            kanban_apply_pi_lifecycle_intent,
            kanban_status_metadata,
            kanban_reorder_cards,
            kanban_set_project,
            kanban_environment_health,
            kanban_environment_start_preflight,
            kanban_start_environment,
            kanban_cleanup_environment_creation,
            kanban_cleanup_environment,
            kanban_close_card,
            kanban_retry_runtime_cleanup,
            kanban_create_pull_request,
            kanban_refresh_pull_request,
            kanban_merge_pull_request,
            kanban_set_merge_target,
            kanban_approve_and_commit,
            kanban_merge_card,
            kanban_prepare_target_merge,
            kanban_finalize_target_merge,
            kanban_abort_target_merge,
            kanban_save_environment_layout,
            project_direct_load_or_create,
            project_direct_save_layout,
            project_direct_delete,
            superthread_boards,
            superthread_board_lists,
            superthread_board_cards,
            superthread_card,
            superthread_create_card,
            run_workspace_setup,
            cancel_workspace_setup,
        ])
        .setup(|app| {
            kanban::initialize_database().map_err(std::io::Error::other)?;
            kanban::set_app_handle(app.handle().clone());
            setup_main_window(app)?;
            let state = app.state::<AutomationState>().inner().clone();
            if let Err(err) = automation::start_server(app.handle().clone(), state) {
                eprintln!("Stacks automation is unavailable: {err}");
            }
            Ok(())
        })
        .run(tauri::generate_context!());

    automation::cleanup_server(&automation_state);
    if let Err(error) = run_result {
        eprintln!("Stacks failed to start: {error}");
        std::process::exit(1);
    }
}
