use std::path::PathBuf;

use crate::fs_paths::app_data_file;

mod cli;
mod protocol;
mod server;
mod state;

pub use cli::{activate_existing_instance, handle_cli_invocation};
pub use server::start_server;
pub use state::AutomationState;

const MAX_REQUEST_BYTES: u64 = 1024 * 1024;

pub(crate) fn socket_path() -> Result<PathBuf, String> {
    let name = if cfg!(debug_assertions) {
        "automation-dev.sock"
    } else {
        "automation.sock"
    };
    app_data_file(name)
}

pub fn cleanup_server(state: &AutomationState) {
    if !state.take_socket_ownership() {
        return;
    }
    if let Ok(path) = socket_path() {
        if let Err(err) = std::fs::remove_file(&path) {
            if err.kind() != std::io::ErrorKind::NotFound {
                eprintln!("failed to remove Stacks automation socket: {err}");
            }
        }
    }
}
