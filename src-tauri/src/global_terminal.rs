pub use stacks_core::global_terminal::{migrate, GlobalTerminalState, GlobalTerminalTab};

#[tauri::command]
pub fn global_terminal_load_or_create() -> Result<GlobalTerminalState, String> {
    let store = crate::profile_store()?;
    stacks_core::global_terminal::global_terminal_load_or_create(&store)
}

#[tauri::command]
pub fn global_terminal_save(
    tabs: Vec<GlobalTerminalTab>,
    selected_tab_id: String,
    expected_revision: i64,
) -> Result<GlobalTerminalState, String> {
    let store = crate::profile_store()?;
    stacks_core::global_terminal::global_terminal_save(
        &store,
        tabs,
        selected_tab_id,
        expected_revision,
    )
}
