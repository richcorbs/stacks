//! Serializable read models for the Stacks LIST surface.
//!
//! These are deliberately narrower than the Tauri board/detail models: they
//! contain only fields LIST renders or groups by. Keeping the projection here
//! means the GPUI host never learns SQLite or workflow-transition rules.

use serde::{Deserialize, Serialize};

/// The eight canonical workflow statuses owned by the Stacks backend.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardStatus {
    NeedsRefinement,
    Refining,
    NeedsRefinementInput,
    Ready,
    AgentWorking,
    NeedsHuman,
    Approved,
    Done,
}

impl CardStatus {
    pub const ALL: [Self; 8] = [
        Self::NeedsRefinement,
        Self::Refining,
        Self::NeedsRefinementInput,
        Self::Ready,
        Self::AgentWorking,
        Self::NeedsHuman,
        Self::Approved,
        Self::Done,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NeedsRefinement => "needs_refinement",
            Self::Refining => "refining",
            Self::NeedsRefinementInput => "needs_refinement_input",
            Self::Ready => "ready",
            Self::AgentWorking => "agent_working",
            Self::NeedsHuman => "needs_human",
            Self::Approved => "approved",
            Self::Done => "done",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::NeedsRefinement => "Needs refinement",
            Self::Refining => "Refining",
            Self::NeedsRefinementInput => "Needs you for refinement",
            Self::Ready => "Ready for agent",
            Self::AgentWorking => "Agent working",
            Self::NeedsHuman => "Needs you",
            Self::Approved => "Approved",
            Self::Done => "Done",
        }
    }

    pub fn status_index(self) -> usize {
        match self {
            Self::NeedsRefinement => 0,
            Self::Refining => 1,
            Self::NeedsRefinementInput => 2,
            Self::Ready => 3,
            Self::AgentWorking => 4,
            Self::NeedsHuman => 5,
            Self::Approved => 6,
            Self::Done => 7,
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "needs_refinement" => Self::NeedsRefinement,
            "refining" => Self::Refining,
            "needs_refinement_input" => Self::NeedsRefinementInput,
            "ready" => Self::Ready,
            "agent_working" => Self::AgentWorking,
            "needs_human" => Self::NeedsHuman,
            "approved" => Self::Approved,
            "done" => Self::Done,
            _ => return None,
        })
    }
}

impl std::fmt::Display for CardStatus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl std::str::FromStr for CardStatus {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value).ok_or_else(|| format!("Unknown workflow status: {value}"))
    }
}

/// LIST groups. Order matches `WORK_GROUPS` in the React app.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WorkGroup {
    Attention,
    Progress,
    Backlog,
    Done,
}

impl WorkGroup {
    pub const ALL: [Self; 4] = [Self::Attention, Self::Progress, Self::Backlog, Self::Done];

    pub fn id(self) -> &'static str {
        match self {
            Self::Attention => "attention",
            Self::Progress => "progress",
            Self::Backlog => "backlog",
            Self::Done => "done",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Attention => "Needs your action",
            Self::Progress => "In progress",
            Self::Backlog => "Backlog",
            Self::Done => "Done",
        }
    }

    /// Canonical statuses assigned to this group, in display order.
    pub fn statuses(self) -> &'static [CardStatus] {
        match self {
            Self::Attention => &[
                CardStatus::NeedsRefinementInput,
                CardStatus::Ready,
                CardStatus::NeedsHuman,
                CardStatus::Approved,
            ],
            Self::Progress => &[CardStatus::Refining, CardStatus::AgentWorking],
            Self::Backlog => &[CardStatus::NeedsRefinement],
            Self::Done => &[CardStatus::Done],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryWorkflow {
    LocalMerge,
    GithubPullRequest,
    ScriptedDelivery,
}

impl DeliveryWorkflow {
    pub fn parse(value: &str) -> Self {
        match value {
            "github_pull_request" => Self::GithubPullRequest,
            "scripted_delivery" => Self::ScriptedDelivery,
            _ => Self::LocalMerge,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub color_id: Option<String>,
    pub delivery_workflow: DeliveryWorkflow,
    pub kanban_source: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Relationship {
    pub id: String,
    pub external_id: String,
    pub title: String,
    pub status: CardStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EnvironmentIndicator {
    pub id: String,
    pub project_id: String,
    pub worktree_path: String,
    pub branch: String,
    pub target_branch: Option<String>,
    pub lifecycle_state: String,
    pub revision: i64,
    pub layout_revision: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PullRequestIndicator {
    pub number: u64,
    pub url: String,
    pub state: String,
    pub draft: bool,
    pub ci_status: String,
    pub review_state: String,
    pub has_conflicts: bool,
    pub mergeable: bool,
    pub blockers: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CardSummary {
    pub id: String,
    pub provider: String,
    pub external_id: String,
    pub title: String,
    pub board_id: String,
    pub board_title: String,
    pub list_title: String,
    pub assignee_names: Vec<String>,
    pub status: CardStatus,
    pub completion_outcome: Option<String>,
    pub workflow_revision: i64,
    pub record_revision: i64,
    pub project_id: Option<String>,
    pub parent: Option<Relationship>,
    pub child_count: u64,
    pub children: Vec<Relationship>,
    pub hierarchy_finalized: bool,
    pub environment: Option<EnvironmentIndicator>,
    pub pull_request: Option<PullRequestIndicator>,
    pub delivery_operation_stage: Option<String>,
    pub delivery_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub sort_order: i64,
}

impl CardSummary {
    pub fn project<'a>(&self, projects: &'a [Project]) -> Option<&'a Project> {
        self.project_id
            .as_deref()
            .and_then(|id| projects.iter().find(|project| project.id == id))
    }

    pub fn has_git_environment_warning(&self) -> bool {
        self.environment
            .as_ref()
            .is_some_and(|environment| environment.lifecycle_state != "ready")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CardEvent {
    pub id: i64,
    pub created_at: i64,
    pub actor: String,
    pub event_type: String,
    pub outcome: String,
    pub from_status: Option<CardStatus>,
    pub to_status: Option<CardStatus>,
    pub summary: Option<String>,
    pub error_code: Option<String>,
    pub error_detail: Option<String>,
}

/// Read-only detail projection. Editing, workflow actions, chat, diff and
/// provider mutations intentionally stay in the shipped Tauri/React app.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CardDetail {
    pub card: CardSummary,
    pub content: String,
    pub card_url: String,
    pub feature_environment: bool,
    pub runtime_cleanup_status: Option<String>,
    pub runtime_cleanup_error: Option<String>,
    pub events: Vec<CardEvent>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CardSnapshot {
    pub projects: Vec<Project>,
    pub cards: Vec<CardSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeliveryStep {
    pub label: String,
    pub action_required: bool,
    pub pr_merge_ready: bool,
}

impl DeliveryStep {
    pub(crate) fn new(label: impl Into<String>, action_required: bool) -> Self {
        Self {
            label: label.into(),
            action_required,
            pr_merge_ready: false,
        }
    }
}
