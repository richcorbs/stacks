use std::sync::Mutex;
use tauri::State;

pub use stacks_core::project_direct::{
    migrate, project_direct_owner, ProjectDirectWork,
};
use crate::pi_rpc::PiRpcRegistry;
use crate::{pi_rpc, pty, pty_cwd::PtyRegistry};

#[tauri::command]
pub fn project_direct_load_or_create(project_id: String) -> Result<ProjectDirectWork, String> {
    let store = crate::profile_store()?;
    stacks_core::project_direct::project_direct_load_or_create(&store, project_id)
}

#[tauri::command]
pub fn project_direct_save_layout(
    project_id: String,
    split_layout: serde_json::Value,
    focused_pane_id: Option<String>,
    pane_ids: Vec<String>,
    expected_revision: i64,
) -> Result<ProjectDirectWork, String> {
    let store = crate::profile_store()?;
    stacks_core::project_direct::project_direct_save_layout(
        &store,
        project_id,
        split_layout,
        focused_pane_id,
        pane_ids,
        expected_revision,
    )
}

#[tauri::command]
pub fn project_direct_delete(
    project_id: String,
    pi_registry: State<'_, Mutex<PiRpcRegistry>>,
    pty_registry: State<'_, Mutex<PtyRegistry>>,
) -> Result<Vec<String>, String> {
    let store = crate::profile_store()?;
    let mut pane_ids = stacks_core::project_direct::project_pane_ids(&store, &project_id)?;
    pane_ids.push(format!("project-direct:{project_id}:terminal:server"));
    pane_ids.push(format!("project-direct:{project_id}:terminal:console"));
    pi_rpc::delete_pi_session_impl(
        pi_registry.inner(),
        &format!("project-direct:{project_id}:agent"),
    )?;
    let live_pane_ids = pty::kill_ptys_with_prefix(
        pty_registry.inner(),
        &format!("project-direct:{project_id}:terminal:"),
    )?;
    stacks_core::project_direct::delete_persistence(&store, &project_id)?;
    Ok(pane_ids.into_iter().chain(live_pane_ids).collect())
}
