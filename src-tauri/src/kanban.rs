use crate::{
    fs_paths::app_data_file,
    pi_rpc::{delete_pi_session_impl, PiRpcRegistry},
    pty::kill_ptys,
    pty_cwd::PtyRegistry,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

static REPOSITORY_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static BOARD_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static DATABASE_INITIALIZATION: OnceLock<Result<(), String>> = OnceLock::new();

pub(crate) fn set_app_handle(app: AppHandle) {
    let _ = APP_HANDLE.set(app);
}

mod cards;
mod cleanup;
mod commands;
mod domain;
mod environment;
mod git_effects;
mod github_delivery;
mod health;
mod local_delivery;
mod repository;
mod sync;

pub(crate) use cards::{
    card_directory, card_pi_session, card_project_id, create_local_card_for_project,
    kanban_finish_external_refinement, validate_card_pi_start, validate_card_terminal_start,
};
pub use commands::*;
pub use domain::*;
#[allow(unused_imports)]
pub use environment::{EnvironmentStartPreflight, WorkflowOperationResult};
#[cfg(test)]
pub(crate) use repository::migrate;
pub(crate) use repository::{initialize_database, with_connection};

#[cfg(test)]
mod tests;
