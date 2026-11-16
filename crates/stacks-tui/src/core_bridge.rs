//! Worker helpers around `stacks-core`.
//!
//! Every long operation (SQLite reads, git, gh, worktree creation) runs on its
//! own thread and posts a [`CoreEvent`]. The UI thread never blocks on I/O.

use std::sync::Arc;

use stacks_core::WorkflowAction;
use stacks_core::store::CardStore;
use stacks_core::{
    diff::{changed_files, file_diff, review_context, worktree_status},
    release::{ReleaseAction, ReleaseSetup, ReleaseState},
};

use crate::event::{CoreEvent, EventSender};

pub type Store = Arc<CardStore>;

fn spawn(sender: EventSender, name: &str, work: impl FnOnce(EventSender) + Send + 'static) {
    let _ = std::thread::Builder::new()
        .name(format!("stacks-tui-{name}"))
        .spawn(move || work(sender));
}

pub fn load_board(store: Store, sender: EventSender) {
    spawn(sender.clone(), "board", move |sender| {
        sender.send(CoreEvent::Board(
            store.load_snapshot().map_err(|error| error.to_string()),
        ));
    });
}

pub fn load_detail(store: Store, card_id: String, sender: EventSender) {
    spawn(sender.clone(), "detail", move |sender| {
        let result = store
            .load_detail(&card_id)
            .map_err(|error| error.to_string());
        sender.send(CoreEvent::Detail { card_id, result });
    });
}

pub fn run_action(
    store: Store,
    card_id: String,
    action: WorkflowAction,
    revision: i64,
    feature_environment: bool,
    sender: EventSender,
) {
    spawn(sender.clone(), "action", move |sender| {
        let result = store
            .run_action(&card_id, action, revision, feature_environment)
            .map_err(|error| error.to_string());
        sender.send(CoreEvent::Action {
            card_id,
            action,
            result,
        });
    });
}

pub fn finish_refinement(
    store: Store,
    card_id: String,
    revision: i64,
    content: String,
    sender: EventSender,
) {
    spawn(sender.clone(), "refinement", move |sender| {
        let result = store
            .finish_refinement(&card_id, revision, &content)
            .map_err(|error| error.to_string());
        sender.send(CoreEvent::Edited(result));
    });
}

pub fn finish_superthread_refinement(
    store: Store,
    card_id: String,
    revision: i64,
    content: String,
    sender: EventSender,
) {
    spawn(sender.clone(), "refinement-provider", move |sender| {
        let service = stacks_core::superthread::SuperthreadService::default();
        let result = store
            .finish_superthread_refinement(&card_id, revision, &content, &service)
            .map_err(|error| error.to_string());
        sender.send(CoreEvent::Edited(result));
    });
}

pub fn update_card(
    store: Store,
    card_id: String,
    revision: i64,
    title: Option<String>,
    content: Option<String>,
    sender: EventSender,
) {
    spawn(sender.clone(), "edit", move |sender| {
        let result = store
            .update_card(&card_id, revision, title.as_deref(), content.as_deref())
            .map_err(|error| error.to_string());
        sender.send(CoreEvent::Edited(result));
    });
}

pub fn create_card(
    store: Store,
    project_id: String,
    title: String,
    content: String,
    sender: EventSender,
) {
    spawn(sender.clone(), "create", move |sender| {
        let service = stacks_core::superthread::SuperthreadService::default();
        let result = store
            .create_project_card(&project_id, &title, &content, &service)
            .map_err(|error| error.to_string());
        sender.send(CoreEvent::Created(result));
    });
}

#[derive(Debug)]
pub struct ReleaseInfo {
    pub setup: ReleaseSetup,
    pub latest: Option<String>,
    pub latest_error: Option<String>,
    pub state: Option<ReleaseState>,
    pub state_error: Option<String>,
}

pub fn load_release_info(store: Store, project_id: String, version: String, sender: EventSender) {
    spawn(sender.clone(), "release-info", move |sender| {
        let result = stacks_core::release::release_setup(&store, project_id.clone()).map(|setup| {
            let (latest, latest_error) =
                match stacks_core::release::release_latest(&store, project_id.clone()) {
                    Ok(latest) => (Some(latest), None),
                    Err(error) => (None, Some(error)),
                };
            let (state, state_error) =
                match stacks_core::release::release_state(&store, project_id.clone(), version) {
                    Ok(state) => (state, None),
                    Err(error) => (None, Some(error)),
                };
            ReleaseInfo {
                setup,
                latest,
                latest_error,
                state,
                state_error,
            }
        });
        sender.send(CoreEvent::ReleaseInfo { project_id, result });
    });
}

pub fn prepare_release(
    store: Store,
    project_id: String,
    version: String,
    action: ReleaseAction,
    setup: ReleaseSetup,
    sender: EventSender,
) {
    spawn(sender.clone(), "release-command", move |sender| {
        let result = stacks_core::release::release_command(
            &store,
            project_id.clone(),
            version.clone(),
            setup.cwd.clone(),
            setup.terminal_id.clone(),
            Some(action),
        )
        .map(|command| (setup, command));
        sender.send(CoreEvent::ReleasePrepared {
            project_id,
            version,
            action,
            result,
        });
    });
}

pub fn configure_superthread_project(
    store: Store,
    project_id: String,
    config: stacks_core::store::SuperthreadProjectConfig,
    sender: EventSender,
) {
    spawn(sender.clone(), "superthread-config", move |sender| {
        let service = stacks_core::superthread::SuperthreadService::default();
        let result = store
            .configure_superthread_project(&project_id, &config, &service)
            .map_err(|error| error.to_string());
        sender.send(CoreEvent::SuperthreadConfigured { project_id, result });
    });
}

pub fn sync_superthread_card_status(store: Store, card_id: String, sender: EventSender) {
    spawn(sender.clone(), "superthread-card", move |sender| {
        let service = stacks_core::superthread::SuperthreadService::default();
        let result = store
            .sync_superthread_card_status(&card_id, &service)
            .map_err(|error| error.to_string());
        sender.send(CoreEvent::ProviderCardSynced(result));
    });
}

pub fn sync_superthread_project(
    store: Store,
    project_id: String,
    manual: bool,
    sender: EventSender,
) {
    spawn(sender.clone(), "superthread-sync", move |sender| {
        let service = stacks_core::superthread::SuperthreadService::default();
        let result = store
            .sync_superthread_project(&project_id, &service)
            .map_err(|error| error.to_string());
        sender.send(CoreEvent::SuperthreadSynced { manual, result });
    });
}

pub fn sync_project_pull_requests(
    store: Store,
    project_id: String,
    path: String,
    sender: EventSender,
) {
    spawn(sender.clone(), "pull-requests", move |sender| {
        let result = stacks_core::github::github_pull_requests_all(path).and_then(|response| {
            store
                .sync_project_pull_requests(
                    &project_id,
                    &response.repository,
                    &response.pull_requests,
                )
                .map_err(|error| error.to_string())
        });
        sender.send(CoreEvent::PullRequestsSynced(result));
    });
}

pub fn delete_project(store: Store, project_id: String, sender: EventSender) {
    spawn(sender.clone(), "delete-project", move |sender| {
        let result = store
            .delete_project(&project_id)
            .map_err(|error| error.to_string());
        sender.send(CoreEvent::ProjectDeleted { project_id, result });
    });
}

pub fn update_project(
    store: Store,
    project_id: String,
    update: stacks_core::store::ProjectSettingsUpdate,
    sender: EventSender,
) {
    spawn(sender.clone(), "update-project", move |sender| {
        let result = store
            .update_project(&project_id, &update)
            .map_err(|error| error.to_string());
        sender.send(CoreEvent::ProjectUpdated(result));
    });
}

pub fn create_project(store: Store, name: String, path: String, sender: EventSender) {
    spawn(sender.clone(), "create-project", move |sender| {
        let result = store
            .create_project(&name, &path)
            .map_err(|error| error.to_string());
        sender.send(CoreEvent::ProjectCreated(result));
    });
}

pub fn reorder_backlog(
    store: Store,
    expected: Vec<String>,
    ordered: Vec<String>,
    sender: EventSender,
) {
    spawn(sender.clone(), "reorder", move |sender| {
        let result = store
            .reorder_backlog(&expected, &ordered)
            .map_err(|error| error.to_string());
        sender.send(CoreEvent::Reorder(result));
    });
}

pub fn load_diff_files(
    store: Store,
    card_id: String,
    worktree: String,
    target: String,
    sender: EventSender,
) {
    spawn(sender.clone(), "diff-files", move |sender| {
        let result = changed_files(&worktree, &target)
            .map(|files| (files, review_context(&worktree, &target)))
            .map_err(|error| error.to_string());
        sender.send(CoreEvent::DiffFiles { card_id, result });
    });
    let _ = store;
}

pub fn load_worktree_status(
    card_id: String,
    worktree: String,
    target: String,
    sender: EventSender,
) {
    spawn(sender.clone(), "worktree-status", move |sender| {
        let result = Ok(worktree_status(&worktree, &target));
        sender.send(CoreEvent::WorktreeStatus { card_id, result });
    });
}

pub fn load_file_diff(
    worktree: String,
    target: String,
    owner: String,
    path: String,
    sender: EventSender,
) {
    spawn(sender.clone(), "file-diff", move |sender| {
        let result = file_diff(&worktree, &target, &path).map_err(|error| error.to_string());
        sender.send(CoreEvent::FileDiff {
            owner,
            path,
            result,
        });
    });
}
