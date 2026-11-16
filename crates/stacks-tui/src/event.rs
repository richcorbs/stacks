//! Worker → UI messages.

use stacks_core::diff::{DiffFile, GitReviewContext, WorktreeStatus};
use stacks_core::pty::PtyEvent;
use stacks_core::{
    CardDetail, CardSnapshot, WorkflowAction,
    release::{ReleaseAction, ReleaseSetup},
};

#[derive(Debug)]
pub enum CoreEvent {
    Board(Result<CardSnapshot, String>),
    Detail {
        card_id: String,
        result: Result<CardDetail, String>,
    },
    Action {
        card_id: String,
        action: WorkflowAction,
        result: Result<(), String>,
    },
    DiffFiles {
        card_id: String,
        result: Result<(Vec<DiffFile>, GitReviewContext), String>,
    },
    FileDiff {
        owner: String,
        path: String,
        result: Result<String, String>,
    },
    WorktreeStatus {
        card_id: String,
        result: Result<WorktreeStatus, String>,
    },
    Reorder(Result<(), String>),
    Created(Result<String, String>),
    ProjectCreated(Result<String, String>),
    ProjectUpdated(Result<(), String>),
    ProjectDeleted {
        project_id: String,
        result: Result<(), String>,
    },
    PullRequestsSynced(Result<usize, String>),
    SuperthreadSynced {
        manual: bool,
        result: Result<usize, String>,
    },
    ProviderCardSynced(Result<bool, String>),
    SuperthreadConfigured {
        project_id: String,
        result: Result<(), String>,
    },
    ReleaseInfo {
        project_id: String,
        result: Result<crate::core_bridge::ReleaseInfo, String>,
    },
    ReleasePrepared {
        project_id: String,
        version: String,
        action: ReleaseAction,
        result: Result<(ReleaseSetup, String), String>,
    },
    Edited(Result<(), String>),
    AutomationChanged {
        card_id: String,
        message: String,
    },
    Pty {
        pane: String,
        event: PtyEvent,
    },
    Toast(String),
    Notice(String),
}

/// Crossbeam channel pair. Cloned senders live in workers and reader threads.
#[derive(Clone)]
pub struct EventSender {
    sender: crossbeam_channel::Sender<CoreEvent>,
}

impl EventSender {
    pub fn send(&self, event: CoreEvent) {
        let _ = self.sender.send(event);
    }

    pub fn toast(&self, message: impl Into<String>) {
        self.send(CoreEvent::Toast(message.into()));
    }

    pub fn notice(&self, message: impl Into<String>) {
        self.send(CoreEvent::Notice(message.into()));
    }
}

pub struct EventBus {
    sender: EventSender,
    receiver: crossbeam_channel::Receiver<CoreEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        let (sender, receiver) = crossbeam_channel::unbounded();
        Self {
            sender: EventSender { sender },
            receiver,
        }
    }

    pub fn sender(&self) -> EventSender {
        self.sender.clone()
    }

    pub fn try_recv(&self) -> Option<CoreEvent> {
        self.receiver.try_recv().ok()
    }

    pub fn recv_timeout(&self, timeout: std::time::Duration) -> Option<CoreEvent> {
        self.receiver.recv_timeout(timeout).ok()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}
