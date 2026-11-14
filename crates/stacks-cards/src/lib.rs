//! Reusable Rust read model for Stacks' LIST surface.
//!
//! The crate is deliberately Tauri-free. It reads the shipped SQLite database
//! read-only, projects cards into the LIST model, and owns the backlog reorder
//! contract. GPUI (or any future native host) renders these types instead of
//! duplicating SQL or workflow projection rules.

pub mod model;
pub mod store;
pub mod workflow;

pub use model::{
    CardSnapshot, CardStatus, CardSummary, DeliveryStep, DeliveryWorkflow, EnvironmentIndicator,
    Project, PullRequestIndicator, Relationship, WorkGroup,
};
pub use store::{CardStore, DATABASE_ENV, REORDER_CONFLICT_CODE};
pub use workflow::{
    backlog_cards, delivery_step, group_cards, merge_filtered_lane_order, work_group,
};
