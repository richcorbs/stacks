use crate::{
    fs_paths::{app_data_dir, app_data_file},
    pi_rpc::{delete_pi_session_impl, PiRpcRegistry},
    pty::kill_ptys,
    pty_cwd::PtyRegistry,
    repository_coordinator,
    workspace_setup::{run_workspace_setup_durable, WorkspaceSetupState},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::AtomicBool, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use workflow::{
    CardStatus, CompletionOutcome, DeliveryWorkflow, EnvironmentLifecycle, PiLifecycleIntent,
    PiThread, PullRequestState, WorkflowAction, WorkflowActor, WorkflowCapability, WorkflowContext,
    WorkflowEventOutcome,
};

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
mod provider_sync;
mod repository;
mod scripted_delivery;
mod superthread_refinement;
mod sync;
pub(crate) mod workflow;

pub(crate) use cards::{
    card_directory, card_pi_owner, card_pi_session, card_project_id, card_terminal_owner,
    create_local_card_for_project, register_pi_lifecycle_generation, validate_card_pi_start,
    validate_card_terminal_start,
};
pub use commands::*;
pub use domain::*;
#[allow(unused_imports)]
pub use environment::{EnvironmentStartPreflight, WorkflowOperationResult};
#[allow(unused_imports)]
pub use local_delivery::TargetMergePrepareResult;
pub(crate) use provider_sync::{
    executing_for_project, run_pending_once, supersede_for_mapping_change, unresolved_for_project,
};
#[cfg(test)]
pub(crate) use repository::migrate;
pub(crate) use repository::{
    initialize_database, with_board_mutation, with_connection, with_read_connection,
    with_write_connection,
};
pub(crate) use superthread_refinement::finish_superthread_refinement;

#[cfg(test)]
mod tests;
