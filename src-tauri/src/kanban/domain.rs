use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub(in crate::kanban) const STATUSES: [&str; 8] = [
    "needs_refinement",
    "refining",
    "needs_refinement_input",
    "ready",
    "agent_working",
    "needs_human",
    "approved",
    "done",
];
pub(in crate::kanban) const REFINEMENT_STATUSES: [&str; 3] =
    ["needs_refinement", "refining", "needs_refinement_input"];
pub(in crate::kanban) const REORDER_CONFLICT_CODE: &str = "KANBAN_REORDER_CONFLICT";

#[derive(Debug, Clone, Deserialize)]
pub struct KanbanCardSnapshot {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub board_id: String,
    #[serde(default)]
    pub board_title: String,
    #[serde(default)]
    pub list_id: String,
    #[serde(default)]
    pub list_title: String,
    #[serde(default)]
    pub card_url: String,
    #[serde(default)]
    pub assignee_names: Vec<String>,
    #[serde(default)]
    pub task_parent_id: Option<String>,
    #[serde(default)]
    pub task_parent_title: Option<String>,
    #[serde(default)]
    pub total_task_children: u64,
    #[serde(default = "default_true")]
    pub in_scope: bool,
}

pub(in crate::kanban) fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CardPane {
    pub(in crate::kanban) id: String,
    pub(in crate::kanban) role: String,
    pub(in crate::kanban) kind: String,
    pub(in crate::kanban) command: Option<String>,
    pub(in crate::kanban) sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CardEnvironment {
    pub(in crate::kanban) id: String,
    pub(in crate::kanban) card_id: String,
    pub(in crate::kanban) project_id: String,
    pub(in crate::kanban) worktree_path: String,
    pub(in crate::kanban) branch: String,
    pub(in crate::kanban) repository_id: Option<String>,
    pub(in crate::kanban) target_checkout_path: Option<String>,
    pub(in crate::kanban) target_branch: Option<String>,
    pub(in crate::kanban) source_revision: Option<String>,
    pub(in crate::kanban) target_revision: Option<String>,
    pub(in crate::kanban) lifecycle_state: String,
    pub(in crate::kanban) revision: i64,
    pub(in crate::kanban) layout_revision: i64,
    pub(in crate::kanban) split_layout: serde_json::Value,
    pub(in crate::kanban) focused_pane_id: Option<String>,
    pub(in crate::kanban) panes: Vec<CardPane>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EnvironmentHealthIssue {
    pub(in crate::kanban) code: String,
    pub(in crate::kanban) message: String,
    pub(in crate::kanban) step: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CardEnvironmentHealth {
    pub(in crate::kanban) card_id: String,
    pub(in crate::kanban) issues: Vec<EnvironmentHealthIssue>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CardCleanupOperation {
    pub(in crate::kanban) status: String,
    pub(in crate::kanban) phase: String,
    pub(in crate::kanban) error_code: Option<String>,
    pub(in crate::kanban) error_detail: Option<String>,
    pub(in crate::kanban) started_at: i64,
    pub(in crate::kanban) updated_at: i64,
    pub(in crate::kanban) completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CardEvent {
    pub(in crate::kanban) id: i64,
    pub(in crate::kanban) created_at: i64,
    pub(in crate::kanban) actor: String,
    pub(in crate::kanban) event_type: String,
    pub(in crate::kanban) outcome: String,
    pub(in crate::kanban) from_status: Option<String>,
    pub(in crate::kanban) to_status: Option<String>,
    pub(in crate::kanban) summary: Option<String>,
    pub(in crate::kanban) error_code: Option<String>,
    pub(in crate::kanban) error_detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CardPullRequest {
    pub(in crate::kanban) repository: String,
    pub(in crate::kanban) number: u64,
    pub(in crate::kanban) title: String,
    pub(in crate::kanban) url: String,
    pub(in crate::kanban) state: String,
    pub(in crate::kanban) draft: bool,
    pub(in crate::kanban) ci_status: String,
    pub(in crate::kanban) review_state: String,
    pub(in crate::kanban) has_conflicts: bool,
    pub(in crate::kanban) mergeable: bool,
    pub(in crate::kanban) blockers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CardRelationshipSummary {
    pub(in crate::kanban) id: String,
    pub(in crate::kanban) external_id: String,
    pub(in crate::kanban) title: String,
    pub(in crate::kanban) status: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ApprovedChildSpec {
    #[serde(default)]
    pub(in crate::kanban) id: Option<String>,
    pub(in crate::kanban) title: String,
    pub(in crate::kanban) content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct KanbanCard {
    pub(in crate::kanban) id: String,
    pub(in crate::kanban) provider: String,
    pub(in crate::kanban) external_id: String,
    pub(in crate::kanban) title: String,
    pub(in crate::kanban) content: String,
    pub(in crate::kanban) board_id: String,
    pub(in crate::kanban) board_title: String,
    pub(in crate::kanban) list_id: String,
    pub(in crate::kanban) list_title: String,
    pub(in crate::kanban) card_url: String,
    pub(in crate::kanban) assignee_names: Vec<String>,
    pub(in crate::kanban) status: String,
    pub(in crate::kanban) completion_outcome: Option<String>,
    pub(in crate::kanban) feature_environment: bool,
    pub(in crate::kanban) pull_request: Option<CardPullRequest>,
    pub(in crate::kanban) delivery_operation_stage: Option<String>,
    pub(in crate::kanban) delivery_error: Option<String>,
    pub(in crate::kanban) workflow_revision: i64,
    pub(in crate::kanban) record_revision: i64,
    pub(in crate::kanban) project_id: Option<String>,
    pub(in crate::kanban) parent: Option<CardRelationshipSummary>,
    pub(in crate::kanban) child_count: u64,
    pub(in crate::kanban) children: Vec<CardRelationshipSummary>,
    pub(in crate::kanban) hierarchy_finalized: bool,
    pub(in crate::kanban) environment: Option<CardEnvironment>,
    pub(in crate::kanban) cleanup_operation: Option<CardCleanupOperation>,
    pub(in crate::kanban) created_at: i64,
    pub(in crate::kanban) updated_at: i64,
    pub(in crate::kanban) sort_order: i64,
    pub(in crate::kanban) in_scope: bool,
    pub(in crate::kanban) events: Vec<CardEvent>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CardSnapshot {
    pub card: KanbanCard,
    pub board_revision: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BoardSnapshot {
    pub cards: Vec<KanbanCard>,
    pub board_revision: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BoardChange {
    pub upserts: Vec<KanbanCard>,
    pub removed_ids: Vec<String>,
    pub board_revision: i64,
}

#[derive(Debug, Serialize)]
pub struct KanbanPullRequestRefreshResult {
    pub(in crate::kanban) card: KanbanCard,
    pub(in crate::kanban) error: Option<String>,
}

impl KanbanCard {
    pub(crate) fn number(&self) -> &str {
        &self.external_id
    }

    pub(crate) fn board_title(&self) -> &str {
        &self.board_title
    }
}

pub(in crate::kanban) fn is_local_kanban_source(source: &str) -> bool {
    source == "local"
}

pub(in crate::kanban) fn is_legal_status_transition(current: &str, next: &str) -> bool {
    matches!(
        (current, next),
        ("needs_refinement", "refining")
            | ("needs_refinement", "ready")
            | ("refining", "needs_refinement")
            | ("refining", "needs_refinement_input")
            | ("needs_refinement_input", "refining")
            | ("needs_refinement_input", "needs_refinement")
            | ("ready", "needs_refinement")
            | ("ready", "agent_working")
            | ("agent_working", "needs_human")
            | ("needs_human", "agent_working")
            | ("needs_human", "approved")
            | ("approved", "needs_human")
    )
}

pub(in crate::kanban) fn reject_duplicate_ids(field: &str, ids: &[String]) -> Result<(), String> {
    let mut unique = HashSet::new();
    if let Some(duplicate) = ids.iter().find(|id| !unique.insert(id.as_str())) {
        return Err(format!(
            "Reorder {field} contains duplicate card ID: {duplicate}"
        ));
    }
    Ok(())
}
