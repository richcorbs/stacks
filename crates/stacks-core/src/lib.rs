//! Host-agnostic Stacks services.
//!
//! The crate is deliberately free of Tauri types so native clients (the
//! shipping Tauri shell today, `stacks-tui` now) can share the same workflow
//! rules, SQLite projections and side effects.
//!
//! The card/workflow modules originate in the card #322 native read-model
//! spike (`stacks-cards` / `stacks-workflow`). They are the reusable seam
//! called out by that spike and are kept behaviour-compatible with the
//! shipped `src-tauri/src/kanban` module.

pub mod automation;
pub mod diff;
pub mod git;
pub mod git_repository;
pub mod github;
pub mod global_terminal;
pub mod grouping;
pub mod model;
pub mod open;
pub mod paths;
pub mod pi;
pub mod pi_paths;
pub mod process_group;
pub mod project_direct;
pub mod pty;
pub mod pty_command;
pub mod release;
pub mod repository_coordinator;
pub mod settings;
pub mod settings_model;
pub mod store;
pub mod terminal;
pub mod workflow;

pub use diff::{GitReviewContext, review_context};
pub use grouping::{
    backlog_cards, delivery_step, group_cards, merge_filtered_lane_order, work_group,
};
pub use model::{
    CardDetail, CardEvent, CardSnapshot, CardStatus, CardSummary, DeliveryStep, DeliveryWorkflow,
    EnvironmentIndicator, Project, PullRequestIndicator, Relationship, WorkGroup,
};
pub use store::{CardStore, DATABASE_ENV, REORDER_CONFLICT_CODE, ScriptedDeploymentCommand};
pub use workflow::{
    WorkflowAction, WorkflowActionAppearance, WorkflowActionPresentation, WorkflowConfirmation,
    WorkflowContext, present_actions, transition,
};
