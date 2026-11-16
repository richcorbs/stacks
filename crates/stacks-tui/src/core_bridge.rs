//! Worker helpers around `stacks-core`.
//!
//! Every long operation (SQLite reads, git, gh, worktree creation) runs on its
//! own thread and posts a [`CoreEvent`]. The UI thread never blocks on I/O.

use std::sync::Arc;

use stacks_core::WorkflowAction;
use stacks_core::diff::{changed_files, file_diff, review_context, worktree_status};
use stacks_core::store::CardStore;

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
        let result = store
            .create_card(&project_id, &title, &content)
            .map_err(|error| error.to_string());
        sender.send(CoreEvent::Created(result));
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

pub fn load_file_diff(worktree: String, target: String, path: String, sender: EventSender) {
    spawn(sender.clone(), "file-diff", move |sender| {
        let result = file_diff(&worktree, &target, &path).map_err(|error| error.to_string());
        sender.send(CoreEvent::FileDiff { path, result });
    });
}
