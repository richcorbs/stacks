//! The single durable journal for every multi-step card operation.
//!
//! Historically each feature (cleanup, environment creation, target merge, scripted
//! delivery, provider sync, local purge and Pi lifecycle) owned a table with its own
//! phase column, attempts and recovery loop. This module owns the storage and the
//! phase→action mapping; features keep their existing behaviour but are represented
//! as one `operations` row with a typed, validated JSON payload.
//!
//! During the migration described on card #340 the legacy tables remain the write
//! surface. Triggers installed by [`install`] mirror every insert/update/delete into
//! `operations`, so the journal is always complete without changing any feature code.
//! Later cards can move reads to this module and drop the legacy tables; the payload
//! structs and the [`resume`] dispatcher are the contract they will use.

#![allow(dead_code)]

use super::health::{db_error, unix_timestamp};
use super::*;
use rusqlite::{params, Connection, OptionalExtension};

/// Schema revision which introduced [`OPERATIONS_SCHEMA`]. Kept next to the DDL so the
/// pairing with `CURRENT_SCHEMA_MIGRATION` is obvious when adding a journal kind.
pub(in crate::kanban) const OPERATIONS_SCHEMA_MIGRATION: i64 = 81;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(in crate::kanban) enum OperationKind {
    Cleanup,
    Creation,
    TargetMerge,
    ScriptedDelivery,
    ProviderSync,
    Purge,
    PiLifecycle,
    /// Card retirement, one kind per mode (see `retirement.rs`).
    RetirePreserve,
    RetireRemove,
    RetireDelete,
}

impl OperationKind {
    pub(in crate::kanban) const ALL: [OperationKind; 10] = [
        OperationKind::Cleanup,
        OperationKind::Creation,
        OperationKind::TargetMerge,
        OperationKind::ScriptedDelivery,
        OperationKind::ProviderSync,
        OperationKind::Purge,
        OperationKind::PiLifecycle,
        OperationKind::RetirePreserve,
        OperationKind::RetireRemove,
        OperationKind::RetireDelete,
    ];

    pub(in crate::kanban) fn as_str(self) -> &'static str {
        match self {
            OperationKind::Cleanup => "cleanup",
            OperationKind::Creation => "creation",
            OperationKind::TargetMerge => "target_merge",
            OperationKind::ScriptedDelivery => "scripted_delivery",
            OperationKind::ProviderSync => "provider_sync",
            OperationKind::Purge => "purge",
            OperationKind::PiLifecycle => "pi_lifecycle",
            OperationKind::RetirePreserve => "retire_preserve_resources",
            OperationKind::RetireRemove => "retire_remove_resources",
            OperationKind::RetireDelete => "retire_delete_record",
        }
    }

    pub(in crate::kanban) fn is_retirement(self) -> bool {
        matches!(
            self,
            OperationKind::RetirePreserve
                | OperationKind::RetireRemove
                | OperationKind::RetireDelete
        )
    }

    pub(in crate::kanban) fn from_str(value: &str) -> Result<Self, String> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.as_str() == value)
            .ok_or_else(|| {
                format!("Unknown operation kind {value:?}; the journal cannot be resumed safely")
            })
    }

    /// The complete phase vocabulary for this kind. A row outside this list is corrupt
    /// and every load fails loudly rather than guessing at a resume point.
    pub(in crate::kanban) fn phases(self) -> &'static [&'static str] {
        match self {
            OperationKind::Cleanup => &crate::kanban::cleanup::CLEANUP_PHASES,
            OperationKind::Creation => &[
                "prepared",
                "setup_running",
                "setup_complete",
                "attaching",
                "compensation_pending",
                "recovery_required",
            ],
            OperationKind::TargetMerge => &[
                "target_sync",
                "target_conflicted",
                "pushed",
                "source_conflicted",
                "source_merged",
            ],
            OperationKind::ScriptedDelivery => &[
                "merged",
                "pushing",
                "push_failed",
                "pushed",
                "deploying",
                "deployment_failed",
                "cancelled",
                "uncertain",
                "deployed",
            ],
            OperationKind::ProviderSync => &[
                "pending",
                "running",
                "failed",
                "succeeded",
                "stale",
                "superseded",
            ],
            OperationKind::Purge => &["pending"],
            OperationKind::PiLifecycle => &["active"],
            // Retirement records a durable intent and then applies the mode's
            // existing resumable machinery. One phase keeps the journal honest:
            // interruption leaves an in-flight row which the same API resumes.
            OperationKind::RetirePreserve => &["execute"],
            OperationKind::RetireRemove => &["execute"],
            OperationKind::RetireDelete => &["execute"],
        }
    }

    /// Phases which are finished without any further action.
    pub(in crate::kanban) fn is_terminal_phase(self, phase: &str) -> bool {
        match self {
            OperationKind::ScriptedDelivery => matches!(phase, "deployed" | "cancelled"),
            OperationKind::ProviderSync => {
                matches!(phase, "succeeded" | "stale" | "superseded")
            }
            _ => false,
        }
    }

    /// Phases which require a human decision; resuming them automatically would be
    /// unsafe or would silently discard evidence.
    pub(in crate::kanban) fn is_human_phase(self, phase: &str) -> bool {
        match self {
            OperationKind::Creation => phase == "recovery_required",
            OperationKind::ScriptedDelivery => phase == "uncertain",
            _ => false,
        }
    }

    /// Maximum automatic attempts, where the existing feature already enforces one.
    /// `None` means the feature deliberately allows manual retries forever.
    pub(in crate::kanban) fn max_attempts(self) -> Option<i64> {
        match self {
            OperationKind::TargetMerge => Some(2),
            _ => None,
        }
    }

    fn validate_phase(self, phase: &str) -> Result<(), String> {
        if self.phases().contains(&phase) {
            Ok(())
        } else {
            Err(format!(
                "Operation kind {} has no phase {phase:?}; refusing to resume blindly",
                self.as_str()
            ))
        }
    }
}

/// SQLite stores booleans as integers. Accept both so a hand-written JSON payload
/// and the trigger-mirrored journal decode identically.
fn deserialize_sql_bool<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct SqlBoolVisitor;
    impl serde::de::Visitor<'_> for SqlBoolVisitor {
        type Value = bool;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a boolean or 0/1 integer")
        }
        fn visit_bool<E>(self, value: bool) -> Result<bool, E> {
            Ok(value)
        }
        fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<bool, E> {
            Ok(value != 0)
        }
        fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<bool, E> {
            Ok(value != 0)
        }
    }
    deserializer.deserialize_any(SqlBoolVisitor)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub(in crate::kanban) struct CleanupEvidencePayload {
    pub recorded_target_path: Option<String>,
    pub recorded_target_branch: Option<String>,
    pub reconciled_target_path: String,
    pub reconciled_target_branch: String,
    pub merge_proof_type: String,
    pub merge_proof_detail: String,
    pub local_branch_disposition: String,
    pub remote_branch_disposition: String,
    pub remote_name: Option<String>,
    pub remote_tip: Option<String>,
    pub runtime_inventory: String,
    pub metadata_inventory: String,
    pub captured_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub(in crate::kanban) struct CleanupPayload {
    pub environment_id: String,
    pub workflow_revision: i64,
    pub environment_revision: i64,
    pub status: String,
    pub completion_outcome: String,
    pub repository_id: String,
    pub source_path: String,
    pub target_path: String,
    pub source_branch: String,
    pub target_branch: String,
    pub source_revision: String,
    pub target_revision: Option<String>,
    #[serde(deserialize_with = "deserialize_sql_bool")]
    pub delete_local_branch: bool,
    #[serde(deserialize_with = "deserialize_sql_bool")]
    pub delete_remote_branch: bool,
    pub merged_pr_repository: Option<String>,
    pub merged_pr_number: Option<i64>,
    pub merged_pr_head_revision: Option<String>,
    pub pane_ids: String,
    #[serde(deserialize_with = "deserialize_sql_bool")]
    pub override_authorized: bool,
    #[serde(deserialize_with = "deserialize_sql_bool")]
    pub registration_validated: bool,
    pub validation_completed_at: Option<i64>,
    #[serde(default)]
    pub evidence: Option<CleanupEvidencePayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub(in crate::kanban) struct CreationPayload {
    pub operation_id: String,
    pub card_id: String,
    pub project_id: String,
    pub repository_id: String,
    pub expected_workflow_revision: i64,
    pub target_checkout_path: String,
    pub target_branch: String,
    pub observed_target_revision: String,
    pub setup_command: String,
    #[serde(deserialize_with = "deserialize_sql_bool")]
    pub custom_command: bool,
    pub attempt_token: Option<String>,
    pub result_path: String,
    pub pre_worktrees: String,
    pub pre_branches: String,
    pub post_worktrees: Option<String>,
    pub post_branches: Option<String>,
    pub setup_result_cwd: Option<String>,
    pub setup_output: Option<String>,
    pub source_path: Option<String>,
    pub source_branch: Option<String>,
    pub source_revision: Option<String>,
    #[serde(deserialize_with = "deserialize_sql_bool")]
    pub source_worktree_new: bool,
    #[serde(deserialize_with = "deserialize_sql_bool")]
    pub source_branch_new: bool,
    #[serde(deserialize_with = "deserialize_sql_bool")]
    pub worktree_removed: bool,
    pub error: Option<String>,
    #[serde(deserialize_with = "deserialize_sql_bool")]
    pub cleanup_available: bool,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub(in crate::kanban) struct TargetMergePayload {
    pub operation_id: String,
    pub card_id: String,
    pub environment_id: String,
    pub workflow_revision: i64,
    pub environment_revision: i64,
    pub initial_status: String,
    pub repository_id: String,
    pub source_path: String,
    pub source_branch: String,
    pub target_checkout_path: String,
    pub target_branch: String,
    pub upstream_remote: String,
    pub upstream_merge_ref: String,
    pub source_revision: String,
    pub initial_target_revision: String,
    pub target_revision: String,
    pub remote_revision: Option<String>,
    pub pushed_target_revision: Option<String>,
    pub push_attempts: i64,
    pub conflict_paths: String,
    pub target_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub(in crate::kanban) struct ScriptedDeliveryPayload {
    pub card_id: String,
    pub project_id: String,
    pub environment_id: String,
    pub repository_id: String,
    pub primary_checkout_path: String,
    pub target_branch: String,
    pub source_revision: String,
    pub merge_revision: String,
    pub verified_push_revision: Option<String>,
    pub deployed_revision: Option<String>,
    pub upstream_remote: Option<String>,
    pub upstream_ref: Option<String>,
    pub attempt_token: Option<String>,
    pub failure_class: Option<String>,
    pub summary: Option<String>,
    pub started_at: i64,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub(in crate::kanban) struct ProviderSyncPayload {
    pub operation_id: String,
    pub card_id: String,
    /// The provider transition (`start_work` or `done`), distinct from the
    /// journal kind (`provider_sync`).
    pub sync_kind: String,
    pub provider: String,
    pub external_id: String,
    pub board_id: String,
    pub source_column_id: String,
    pub source_column_name: String,
    pub destination_column_id: String,
    pub destination_column_name: String,
    pub workflow_revision: i64,
    pub integration_revision: i64,
    pub project_id: String,
    pub api_token_env_var: String,
    pub logical_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub(in crate::kanban) struct PurgePayload {
    /// The card has already been deleted, so the owning id lives in the payload while
    /// `operations.card_id` is nulled by the foreign key.
    pub card_id: String,
    pub storage_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub(in crate::kanban) struct PiLifecyclePayload {
    pub card_id: String,
    pub thread: String,
    pub generation: String,
    pub latest_event_order: i64,
    pub latest_event_id: String,
}

/// Durable intent for the single card-retirement path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub(in crate::kanban) struct RetirementPayload {
    pub card_id: String,
    /// `preserve_resources`, `remove_resources` or `delete_record`.
    pub mode: String,
    pub workflow_revision: i64,
    /// The user explicitly accepted removing unmerged work; evidence is
    /// preserved before any destructive Git effect.
    #[serde(deserialize_with = "deserialize_sql_bool")]
    pub override_authorized: bool,
    /// Where the recovery bundle was written, when one was required.
    pub evidence_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
pub(in crate::kanban) enum OperationPayload {
    Cleanup(CleanupPayload),
    Creation(CreationPayload),
    TargetMerge(TargetMergePayload),
    ScriptedDelivery(ScriptedDeliveryPayload),
    ProviderSync(ProviderSyncPayload),
    Purge(PurgePayload),
    PiLifecycle(PiLifecyclePayload),
    Retirement(RetirementPayload),
}

impl OperationPayload {
    pub(in crate::kanban) fn kind(&self) -> OperationKind {
        match self {
            OperationPayload::Cleanup(_) => OperationKind::Cleanup,
            OperationPayload::Creation(_) => OperationKind::Creation,
            OperationPayload::TargetMerge(_) => OperationKind::TargetMerge,
            OperationPayload::ScriptedDelivery(_) => OperationKind::ScriptedDelivery,
            OperationPayload::ProviderSync(_) => OperationKind::ProviderSync,
            OperationPayload::Purge(_) => OperationKind::Purge,
            OperationPayload::PiLifecycle(_) => OperationKind::PiLifecycle,
            OperationPayload::Retirement(payload) => match payload.mode.as_str() {
                "preserve_resources" => OperationKind::RetirePreserve,
                "delete_record" => OperationKind::RetireDelete,
                _ => OperationKind::RetireRemove,
            },
        }
    }

    pub(in crate::kanban) fn to_json(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|error| error.to_string())
    }

    /// Explicit, typed validation. Anything a feature would need to resume must be
    /// present; a bad payload is a reported error, never a guessed default.
    pub(in crate::kanban) fn validate(&self) -> Result<(), String> {
        match self {
            OperationPayload::Cleanup(payload) => {
                require(&payload.environment_id, "cleanup.environment_id")?;
                require(&payload.repository_id, "cleanup.repository_id")?;
                require(&payload.source_path, "cleanup.source_path")?;
                require(&payload.target_path, "cleanup.target_path")?;
                require(&payload.source_branch, "cleanup.source_branch")?;
                require(&payload.target_branch, "cleanup.target_branch")?;
                require(&payload.source_revision, "cleanup.source_revision")?;
                if !matches!(payload.completion_outcome.as_str(), "merged" | "closed") {
                    return Err(format!(
                        "cleanup.completion_outcome {:?} is not merged or closed",
                        payload.completion_outcome
                    ));
                }
                if !matches!(payload.status.as_str(), "pending" | "failed" | "completed") {
                    return Err(format!("cleanup.status {:?} is invalid", payload.status));
                }
                Ok(())
            }
            OperationPayload::Creation(payload) => {
                require(&payload.operation_id, "creation.operation_id")?;
                require(&payload.card_id, "creation.card_id")?;
                require(&payload.project_id, "creation.project_id")?;
                require(&payload.repository_id, "creation.repository_id")?;
                require(
                    &payload.target_checkout_path,
                    "creation.target_checkout_path",
                )?;
                require(&payload.target_branch, "creation.target_branch")?;
                require(
                    &payload.observed_target_revision,
                    "creation.observed_target_revision",
                )?;
                require(&payload.result_path, "creation.result_path")?;
                Ok(())
            }
            OperationPayload::TargetMerge(payload) => {
                require(&payload.operation_id, "target_merge.operation_id")?;
                require(&payload.card_id, "target_merge.card_id")?;
                require(&payload.environment_id, "target_merge.environment_id")?;
                require(&payload.repository_id, "target_merge.repository_id")?;
                require(&payload.source_path, "target_merge.source_path")?;
                require(&payload.source_branch, "target_merge.source_branch")?;
                require(
                    &payload.target_checkout_path,
                    "target_merge.target_checkout_path",
                )?;
                require(&payload.target_branch, "target_merge.target_branch")?;
                require(&payload.upstream_remote, "target_merge.upstream_remote")?;
                require(
                    &payload.upstream_merge_ref,
                    "target_merge.upstream_merge_ref",
                )?;
                require(&payload.source_revision, "target_merge.source_revision")?;
                require(&payload.target_revision, "target_merge.target_revision")?;
                if !matches!(payload.target_source.as_str(), "local" | "remote") {
                    return Err(format!(
                        "target_merge.target_source {:?} is not local or remote",
                        payload.target_source
                    ));
                }
                Ok(())
            }
            OperationPayload::ScriptedDelivery(payload) => {
                require(&payload.card_id, "scripted_delivery.card_id")?;
                require(&payload.project_id, "scripted_delivery.project_id")?;
                require(&payload.repository_id, "scripted_delivery.repository_id")?;
                require(
                    &payload.primary_checkout_path,
                    "scripted_delivery.primary_checkout_path",
                )?;
                require(&payload.target_branch, "scripted_delivery.target_branch")?;
                require(
                    &payload.source_revision,
                    "scripted_delivery.source_revision",
                )?;
                require(&payload.merge_revision, "scripted_delivery.merge_revision")?;
                Ok(())
            }
            OperationPayload::ProviderSync(payload) => {
                require(&payload.operation_id, "provider_sync.operation_id")?;
                require(&payload.card_id, "provider_sync.card_id")?;
                if !matches!(payload.sync_kind.as_str(), "start_work" | "done") {
                    return Err(format!(
                        "provider_sync.sync_kind {:?} is not start_work or done",
                        payload.sync_kind
                    ));
                }
                require(&payload.provider, "provider_sync.provider")?;
                require(&payload.external_id, "provider_sync.external_id")?;
                require(&payload.board_id, "provider_sync.board_id")?;
                require(
                    &payload.destination_column_id,
                    "provider_sync.destination_column_id",
                )?;
                require(&payload.project_id, "provider_sync.project_id")?;
                Ok(())
            }
            OperationPayload::Purge(payload) => {
                require(&payload.card_id, "purge.card_id")?;
                require(&payload.storage_key, "purge.storage_key")?;
                Ok(())
            }
            OperationPayload::PiLifecycle(payload) => {
                require(&payload.card_id, "pi_lifecycle.card_id")?;
                if !matches!(payload.thread.as_str(), "planning" | "work") {
                    return Err(format!(
                        "pi_lifecycle.thread {:?} is not planning or work",
                        payload.thread
                    ));
                }
                require(&payload.generation, "pi_lifecycle.generation")?;
                Ok(())
            }
            OperationPayload::Retirement(payload) => {
                require(&payload.card_id, "retirement.card_id")?;
                if !matches!(
                    payload.mode.as_str(),
                    "preserve_resources" | "remove_resources" | "delete_record"
                ) {
                    return Err(format!(
                        "retirement.mode {:?} is not a supported retirement mode",
                        payload.mode
                    ));
                }
                Ok(())
            }
        }
    }
}

fn require(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("Operation payload field {field} is empty"))
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(in crate::kanban) struct Operation {
    pub id: String,
    /// `None` only for purge tombstones whose card record has already been removed.
    pub card_id: Option<String>,
    pub kind: OperationKind,
    pub phase: String,
    pub attempt: i64,
    pub error_code: Option<String>,
    pub error_detail: Option<String>,
    pub payload: OperationPayload,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

impl Operation {
    /// Unfinished, including operations parked for a human decision. The point of the
    /// journal is to report those; silently dropping them would hide the stuck card.
    pub(in crate::kanban) fn is_in_flight(&self) -> bool {
        self.completed_at.is_none() && !self.kind.is_terminal_phase(&self.phase)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(in crate::kanban) struct OperationAttempt {
    pub operation_id: String,
    pub attempt: i64,
    pub phase: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub outcome: Option<String>,
    pub error: Option<String>,
    pub detail: Option<String>,
}

/// What the single dispatcher decided to do with an operation.
#[derive(Debug, Clone, PartialEq)]
pub(in crate::kanban) enum ResumeDecision {
    /// Re-run this phase. Phases are idempotent in the owning feature.
    ApplyPhase { phase: String },
    /// Already finished (or a terminal feature state).
    Complete,
    /// Preserved evidence requires a human decision.
    NeedsHuman { reason: String },
}

/// The result a feature reports back after applying one phase.
#[derive(Debug, Clone, PartialEq)]
pub(in crate::kanban) enum PhaseOutcome {
    /// The phase is done; optionally record the next phase.
    Advanced { next_phase: Option<String> },
    /// The whole operation is finished.
    Completed,
    /// A retryable failure. The attempt counter is incremented and the phase is kept.
    Retry { error_code: String, detail: String },
    /// Stop and leave the operation reportable for a human.
    NeedsHuman { reason: String },
}

#[derive(Debug, Clone, PartialEq)]
pub(in crate::kanban) enum ResumeOutcome {
    Applied { phase: String },
    Completed,
    NeedsHuman { reason: String },
}

/// Features implement this instead of their own resume loop. The dispatcher owns the
/// phase vocabulary, retry policy and durability; the feature only applies one phase.
pub(in crate::kanban) trait OperationDriver {
    fn apply_phase(&mut self, operation: &Operation, phase: &str) -> Result<PhaseOutcome, String>;
}

/// Load and validate one operation. A row with an unknown kind, a mismatched payload
/// kind, an unknown phase or a missing required field is an error, not a default.
pub(in crate::kanban) fn load_operation(
    connection: &Connection,
    id: &str,
) -> Result<Option<Operation>, String> {
    connection
        .query_row(
            "SELECT id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at
             FROM operations WHERE id=?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, Option<i64>>(10)?,
                ))
            },
        )
        .optional()
        .map_err(db_error)?
        .map(|row| decode_operation(row))
        .transpose()
}

type RawOperation = (
    String,
    Option<String>,
    String,
    String,
    i64,
    Option<String>,
    Option<String>,
    String,
    i64,
    i64,
    Option<i64>,
);

fn decode_operation(row: RawOperation) -> Result<Operation, String> {
    let (
        id,
        card_id,
        kind,
        phase,
        attempt,
        error_code,
        error_detail,
        payload,
        created_at,
        updated_at,
        completed_at,
    ) = row;
    let kind = OperationKind::from_str(&kind)
        .map_err(|error| format!("Operation {id} is not readable: {error}"))?;
    kind.validate_phase(&phase)
        .map_err(|error| format!("Operation {id} is not readable: {error}"))?;
    let payload: OperationPayload =
        match kind {
            OperationKind::Cleanup => {
                serde_json::from_str::<CleanupPayload>(&payload).map(OperationPayload::Cleanup)
            }
            OperationKind::Creation => {
                serde_json::from_str::<CreationPayload>(&payload).map(OperationPayload::Creation)
            }
            OperationKind::TargetMerge => serde_json::from_str::<TargetMergePayload>(&payload)
                .map(OperationPayload::TargetMerge),
            OperationKind::ScriptedDelivery => {
                serde_json::from_str::<ScriptedDeliveryPayload>(&payload)
                    .map(OperationPayload::ScriptedDelivery)
            }
            OperationKind::ProviderSync => serde_json::from_str::<ProviderSyncPayload>(&payload)
                .map(OperationPayload::ProviderSync),
            OperationKind::Purge => {
                serde_json::from_str::<PurgePayload>(&payload).map(OperationPayload::Purge)
            }
            OperationKind::PiLifecycle => serde_json::from_str::<PiLifecyclePayload>(&payload)
                .map(OperationPayload::PiLifecycle),
            OperationKind::RetirePreserve
            | OperationKind::RetireRemove
            | OperationKind::RetireDelete => {
                serde_json::from_str::<RetirementPayload>(&payload)
                    .map(OperationPayload::Retirement)
            }
        }
        .map_err(|error| {
            format!(
                "Operation {id} has a {} payload which cannot be decoded: {error}",
                kind.as_str()
            )
        })?;
    if payload.kind() != kind {
        return Err(format!(
            "Operation {id} declares kind {} but carries a {} payload; refusing to resume",
            kind.as_str(),
            payload.kind().as_str()
        ));
    }
    payload
        .validate()
        .map_err(|error| format!("Operation {id} has an invalid payload: {error}"))?;
    Ok(Operation {
        id,
        card_id,
        kind,
        phase,
        attempt,
        error_code,
        error_detail,
        payload,
        created_at,
        updated_at,
        completed_at,
    })
}

pub(in crate::kanban) fn list_operations(
    connection: &Connection,
    kind: Option<OperationKind>,
) -> Result<Vec<Operation>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at
             FROM operations WHERE (?1 IS NULL OR kind=?1) ORDER BY created_at,id",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([kind.map(OperationKind::as_str)], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, Option<i64>>(10)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    rows.into_iter().map(decode_operation).collect()
}

/// The single answer to "what is in flight on this card?". Purge rows keep their card
/// identity in the payload after the card record itself is gone.
pub(in crate::kanban) fn in_flight_for_card(
    connection: &Connection,
    card_id: &str,
) -> Result<Vec<Operation>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at
             FROM operations
             WHERE (card_id=?1 OR json_extract(payload,'$.card_id')=?1)
               AND completed_at IS NULL
             ORDER BY created_at,id",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([card_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, Option<i64>>(10)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let mut operations = rows
        .into_iter()
        .map(decode_operation)
        .collect::<Result<Vec<_>, String>>()?;
    operations.retain(Operation::is_in_flight);
    operations.sort_by(|left, right| (&left.kind, &left.id).cmp(&(&right.kind, &right.id)));
    Ok(operations)
}

/// An unfinished operation of exactly this kind for this card. Retirement uses it to
/// resume an interrupted run instead of starting a parallel one.
pub(in crate::kanban) fn open_for_card(
    connection: &Connection,
    card_id: &str,
    kind: OperationKind,
) -> Result<Option<Operation>, String> {
    Ok(in_flight_for_card(connection, card_id)?
        .into_iter()
        .find(|operation| operation.kind == kind))
}

/// Write the durable retirement intent. Idempotent for the same card and kind: a
/// retry resumes the existing row rather than stacking duplicate intents.
pub(in crate::kanban) fn begin(
    connection: &Connection,
    kind: OperationKind,
    card_id: &str,
    phase: &str,
    payload: &OperationPayload,
) -> Result<String, String> {
    if payload.kind() != kind {
        return Err(format!(
            "Cannot journal a {} payload as {}",
            payload.kind().as_str(),
            kind.as_str()
        ));
    }
    payload.validate()?;
    kind.validate_phase(phase)?;
    if let Some(existing) = open_for_card(connection, card_id, kind)? {
        return Ok(existing.id);
    }
    let id = format!("{}:{}", kind.as_str(), uuid::Uuid::new_v4());
    let now = unix_timestamp();
    connection
        .execute(
            "INSERT INTO operations(id,card_id,kind,phase,attempt,payload,created_at,updated_at)
             VALUES (?1,?2,?3,?4,0,?5,?6,?6)",
            params![id, card_id, kind.as_str(), phase, payload.to_json()?, now],
        )
        .map_err(db_error)?;
    Ok(id)
}

pub(in crate::kanban) fn attempts(
    connection: &Connection,
    operation_id: &str,
) -> Result<Vec<OperationAttempt>, String> {
    let mut statement = connection
        .prepare(
            "SELECT operation_id,attempt,phase,started_at,finished_at,outcome,error,detail
             FROM operation_attempts WHERE operation_id=?1 ORDER BY attempt",
        )
        .map_err(db_error)?;
    let attempts = statement
        .query_map([operation_id], |row| {
            Ok(OperationAttempt {
                operation_id: row.get(0)?,
                attempt: row.get(1)?,
                phase: row.get(2)?,
                started_at: row.get(3)?,
                finished_at: row.get(4)?,
                outcome: row.get(5)?,
                error: row.get(6)?,
                detail: row.get(7)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(attempts)
}

/// The one phase → next-action mapping. Features never write their own resume loop:
/// they implement [`OperationDriver::apply_phase`] and call [`resume_with`].
pub(in crate::kanban) fn resume(operation: &Operation) -> Result<ResumeDecision, String> {
    operation.kind.validate_phase(&operation.phase)?;
    if operation.completed_at.is_some() {
        return Ok(ResumeDecision::Complete);
    }
    if operation.kind.is_terminal_phase(&operation.phase) {
        return Ok(ResumeDecision::Complete);
    }
    if operation.kind.is_human_phase(&operation.phase) {
        return Ok(ResumeDecision::NeedsHuman {
            reason: operation.error_detail.clone().unwrap_or_else(|| {
                format!("Operation requires attention in phase {}", operation.phase)
            }),
        });
    }
    if let Some(max) = operation.kind.max_attempts() {
        if operation.attempt >= max && operation.error_code.is_some() {
            return Ok(ResumeDecision::NeedsHuman {
                reason: format!(
                    "Operation exhausted {max} automatic attempt(s) during {}",
                    operation.phase
                ),
            });
        }
    }
    Ok(ResumeDecision::ApplyPhase {
        phase: operation.phase.clone(),
    })
}

/// Load, decide and (when safe) apply exactly one phase through a feature driver.
pub(in crate::kanban) fn resume_with<D: OperationDriver>(
    connection: &Connection,
    id: &str,
    driver: &mut D,
) -> Result<ResumeOutcome, String> {
    let operation =
        load_operation(connection, id)?.ok_or_else(|| format!("Operation {id} was not found"))?;
    match resume(&operation)? {
        ResumeDecision::Complete => Ok(ResumeOutcome::Completed),
        ResumeDecision::NeedsHuman { reason } => Ok(ResumeOutcome::NeedsHuman { reason }),
        ResumeDecision::ApplyPhase { phase } => {
            start_attempt(connection, id, &phase)?;
            match driver.apply_phase(&operation, &phase)? {
                PhaseOutcome::Advanced { next_phase } => {
                    let next = next_phase.unwrap_or_else(|| phase.clone());
                    record_advance(connection, id, &phase, &next)?;
                    Ok(ResumeOutcome::Applied { phase })
                }
                PhaseOutcome::Completed => {
                    complete(connection, id, &phase)?;
                    Ok(ResumeOutcome::Applied { phase })
                }
                PhaseOutcome::Retry { error_code, detail } => {
                    record_failure(connection, id, &phase, &error_code, &detail)?;
                    Ok(ResumeOutcome::Applied { phase })
                }
                PhaseOutcome::NeedsHuman { reason } => {
                    record_needs_human(connection, id, &phase, &reason)?;
                    Ok(ResumeOutcome::NeedsHuman { reason })
                }
            }
        }
    }
}

pub(in crate::kanban) fn start_attempt(
    connection: &Connection,
    id: &str,
    phase: &str,
) -> Result<i64, String> {
    let now = unix_timestamp();
    let attempt: i64 = connection
        .query_row(
            "UPDATE operations SET attempt=attempt+1,updated_at=?1 WHERE id=?2 AND completed_at IS NULL RETURNING attempt",
            params![now, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| format!("Operation {id} is no longer resumable"))?;
    connection
        .execute(
            "INSERT INTO operation_attempts(operation_id,attempt,phase,started_at)
             VALUES (?1,?2,?3,?4)
             ON CONFLICT(operation_id,attempt) DO UPDATE SET phase=excluded.phase,started_at=excluded.started_at",
            params![id, attempt, phase, now],
        )
        .map_err(db_error)?;
    Ok(attempt)
}

fn record_advance(
    connection: &Connection,
    id: &str,
    phase: &str,
    next_phase: &str,
) -> Result<(), String> {
    let now = unix_timestamp();
    connection
        .execute(
            "UPDATE operation_attempts SET finished_at=?1,outcome='success'
             WHERE operation_id=?2 AND attempt=(SELECT MAX(attempt) FROM operation_attempts WHERE operation_id=?2)",
            params![now, id],
        )
        .map_err(db_error)?;
    connection
        .execute(
            "UPDATE operations SET phase=?1,error_code=NULL,error_detail=NULL,updated_at=?2 WHERE id=?3 AND phase=?4",
            params![next_phase, now, id, phase],
        )
        .map_err(db_error)?;
    Ok(())
}

pub(in crate::kanban) fn record_failure(
    connection: &Connection,
    id: &str,
    phase: &str,
    error_code: &str,
    detail: &str,
) -> Result<(), String> {
    let now = unix_timestamp();
    connection
        .execute(
            "UPDATE operation_attempts SET finished_at=?1,outcome='failure',error=?2
             WHERE operation_id=?3 AND attempt=(SELECT MAX(attempt) FROM operation_attempts WHERE operation_id=?3)",
            params![now, detail, id],
        )
        .map_err(db_error)?;
    connection
        .execute(
            "UPDATE operations SET error_code=?1,error_detail=?2,updated_at=?3 WHERE id=?4 AND phase=?5",
            params![error_code, detail, now, id, phase],
        )
        .map_err(db_error)?;
    Ok(())
}

fn record_needs_human(
    connection: &Connection,
    id: &str,
    phase: &str,
    reason: &str,
) -> Result<(), String> {
    let now = unix_timestamp();
    connection
        .execute(
            "UPDATE operation_attempts SET finished_at=?1,outcome='needs_human',error=?2
             WHERE operation_id=?3 AND attempt=(SELECT MAX(attempt) FROM operation_attempts WHERE operation_id=?3)",
            params![now, reason, id],
        )
        .map_err(db_error)?;
    connection
        .execute(
            "UPDATE operations SET error_code='needs_human',error_detail=?1,updated_at=?2 WHERE id=?3 AND phase=?4",
            params![reason, now, id, phase],
        )
        .map_err(db_error)?;
    Ok(())
}

pub(in crate::kanban) fn complete(
    connection: &Connection,
    id: &str,
    phase: &str,
) -> Result<(), String> {
    let now = unix_timestamp();
    connection
        .execute(
            "UPDATE operation_attempts SET finished_at=?1,outcome='success'
             WHERE operation_id=?2 AND attempt=(SELECT MAX(attempt) FROM operation_attempts WHERE operation_id=?2)",
            params![now, id],
        )
        .map_err(db_error)?;
    connection
        .execute(
            "UPDATE operations SET completed_at=?1,error_code=NULL,error_detail=NULL,updated_at=?1 WHERE id=?2 AND phase=?3",
            params![now, id, phase],
        )
        .map_err(db_error)?;
    Ok(())
}

/// Startup check for a partially-written or future-version journal. It never mutates a
/// card; it reports every unreadable operation so health/diagnostics can surface it.
pub(in crate::kanban) fn unreadable_operations(connection: &Connection) -> Vec<String> {
    let ids: Vec<String> = match connection
        .prepare("SELECT id FROM operations ORDER BY id")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()
        }) {
        Ok(ids) => ids,
        Err(error) => return vec![format!("Could not list operations: {error}")],
    };
    ids.into_iter()
        .filter_map(|id| load_operation(connection, &id).err())
        .collect()
}

/// Create the journal, copy every legacy journal into it and install the mirroring
/// triggers. This is the single DDL step for card #340; legacy tables stay the write
/// surface so no feature behaviour changes while follow-up cards move reads.
pub(in crate::kanban) fn install(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(OPERATIONS_SCHEMA)
        .map_err(db_error)?;
    connection
        .execute_batch(&backfill_sql())
        .map_err(db_error)?;
    connection.execute_batch(&trigger_sql()).map_err(db_error)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?1,unixepoch())",
            [OPERATIONS_SCHEMA_MIGRATION],
        )
        .map_err(db_error)?;
    Ok(())
}

const OPERATIONS_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    -- Nullable only for purge tombstones: their card record is already gone.
    card_id TEXT REFERENCES kanban_cards(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    phase TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_detail TEXT,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS operations_card_idx ON operations(card_id,kind,completed_at);
CREATE INDEX IF NOT EXISTS operations_kind_idx ON operations(kind,completed_at);
CREATE TABLE IF NOT EXISTS operation_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    phase TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    outcome TEXT,
    error TEXT,
    detail TEXT,
    UNIQUE(operation_id,attempt)
);
";

fn json_fields(prefix: &str, fields: &[(&str, &str)]) -> String {
    let args = fields
        .iter()
        .map(|(key, column)| format!("'{key}',{prefix}{column}"))
        .collect::<Vec<_>>()
        .join(",");
    format!("json_object({args})")
}

const CLEANUP_FIELDS: &[(&str, &str)] = &[
    ("environment_id", "environment_id"),
    ("workflow_revision", "workflow_revision"),
    ("environment_revision", "environment_revision"),
    ("status", "status"),
    ("completion_outcome", "completion_outcome"),
    ("repository_id", "repository_id"),
    ("source_path", "source_path"),
    ("target_path", "target_path"),
    ("source_branch", "source_branch"),
    ("target_branch", "target_branch"),
    ("source_revision", "source_revision"),
    ("target_revision", "target_revision"),
    ("delete_local_branch", "delete_local_branch"),
    ("delete_remote_branch", "delete_remote_branch"),
    ("merged_pr_repository", "merged_pr_repository"),
    ("merged_pr_number", "merged_pr_number"),
    ("merged_pr_head_revision", "merged_pr_head_revision"),
    ("pane_ids", "pane_ids"),
    ("override_authorized", "override_authorized"),
    ("registration_validated", "registration_validated"),
    ("validation_completed_at", "validation_completed_at"),
];

const CREATION_FIELDS: &[(&str, &str)] = &[
    ("operation_id", "id"),
    ("card_id", "card_id"),
    ("project_id", "project_id"),
    ("repository_id", "repository_id"),
    ("expected_workflow_revision", "expected_workflow_revision"),
    ("target_checkout_path", "target_checkout_path"),
    ("target_branch", "target_branch"),
    ("observed_target_revision", "observed_target_revision"),
    ("setup_command", "setup_command"),
    ("custom_command", "custom_command"),
    ("attempt_token", "attempt_token"),
    ("result_path", "result_path"),
    ("pre_worktrees", "pre_worktrees"),
    ("pre_branches", "pre_branches"),
    ("post_worktrees", "post_worktrees"),
    ("post_branches", "post_branches"),
    ("setup_result_cwd", "setup_result_cwd"),
    ("setup_output", "setup_output"),
    ("source_path", "source_path"),
    ("source_branch", "source_branch"),
    ("source_revision", "source_revision"),
    ("source_worktree_new", "source_worktree_new"),
    ("source_branch_new", "source_branch_new"),
    ("worktree_removed", "worktree_removed"),
    ("error", "error"),
    ("cleanup_available", "cleanup_available"),
    ("revision", "revision"),
];

const TARGET_MERGE_FIELDS: &[(&str, &str)] = &[
    ("operation_id", "id"),
    ("card_id", "card_id"),
    ("environment_id", "environment_id"),
    ("workflow_revision", "workflow_revision"),
    ("environment_revision", "environment_revision"),
    ("initial_status", "initial_status"),
    ("repository_id", "repository_id"),
    ("source_path", "source_path"),
    ("source_branch", "source_branch"),
    ("target_checkout_path", "target_checkout_path"),
    ("target_branch", "target_branch"),
    ("upstream_remote", "upstream_remote"),
    ("upstream_merge_ref", "upstream_merge_ref"),
    ("source_revision", "source_revision"),
    ("initial_target_revision", "initial_target_revision"),
    ("target_revision", "target_revision"),
    ("remote_revision", "remote_revision"),
    ("pushed_target_revision", "pushed_target_revision"),
    ("push_attempts", "push_attempts"),
    ("conflict_paths", "conflict_paths"),
    ("target_source", "target_source"),
];

const SCRIPTED_DELIVERY_FIELDS: &[(&str, &str)] = &[
    ("card_id", "card_id"),
    ("project_id", "project_id"),
    ("environment_id", "environment_id"),
    ("repository_id", "repository_id"),
    ("primary_checkout_path", "primary_checkout_path"),
    ("target_branch", "target_branch"),
    ("source_revision", "source_revision"),
    ("merge_revision", "merge_revision"),
    ("verified_push_revision", "verified_push_revision"),
    ("deployed_revision", "deployed_revision"),
    ("upstream_remote", "upstream_remote"),
    ("upstream_ref", "upstream_ref"),
    ("attempt_token", "attempt_token"),
    ("failure_class", "failure_class"),
    ("summary", "summary"),
    ("started_at", "started_at"),
    ("revision", "revision"),
];

const PROVIDER_SYNC_FIELDS: &[(&str, &str)] = &[
    ("operation_id", "id"),
    ("card_id", "card_id"),
    ("sync_kind", "kind"),
    ("provider", "provider"),
    ("external_id", "external_id"),
    ("board_id", "board_id"),
    ("source_column_id", "source_column_id"),
    ("source_column_name", "source_column_name"),
    ("destination_column_id", "destination_column_id"),
    ("destination_column_name", "destination_column_name"),
    ("workflow_revision", "workflow_revision"),
    ("integration_revision", "integration_revision"),
    ("project_id", "project_id"),
    ("api_token_env_var", "api_token_env_var"),
    ("logical_revision", "logical_revision"),
];

const PURGE_FIELDS: &[(&str, &str)] = &[("card_id", "card_id"), ("storage_key", "storage_key")];

const PI_LIFECYCLE_FIELDS: &[(&str, &str)] = &[
    ("card_id", "card_id"),
    ("thread", "thread"),
    ("generation", "generation"),
    ("latest_event_order", "latest_event_order"),
    ("latest_event_id", "latest_event_id"),
];

const CLEANUP_EVIDENCE_FIELDS: &[(&str, &str)] = &[
    ("recorded_target_path", "recorded_target_path"),
    ("recorded_target_branch", "recorded_target_branch"),
    ("reconciled_target_path", "reconciled_target_path"),
    ("reconciled_target_branch", "reconciled_target_branch"),
    ("merge_proof_type", "merge_proof_type"),
    ("merge_proof_detail", "merge_proof_detail"),
    ("local_branch_disposition", "local_branch_disposition"),
    ("remote_branch_disposition", "remote_branch_disposition"),
    ("remote_name", "remote_name"),
    ("remote_tip", "remote_tip"),
    ("runtime_inventory", "runtime_inventory"),
    ("metadata_inventory", "metadata_inventory"),
    ("captured_at", "captured_at"),
];

fn cleanup_attempt_index(prefix: &str) -> String {
    format!(
        "CASE {prefix}phase \
         WHEN 'validate_repository' THEN 1 \
         WHEN 'runtime_sessions' THEN 2 \
         WHEN 'remove_worktree' THEN 3 \
         WHEN 'delete_local_branch' THEN 4 \
         WHEN 'delete_remote_branch' THEN 5 \
         WHEN 'remove_metadata' THEN 6 \
         WHEN 'record_completion' THEN 7 \
         ELSE 99 END"
    )
}

fn backfill_sql() -> String {
    let cleanup = json_fields("", CLEANUP_FIELDS);
    let cleanup_evidence = json_fields("e.", CLEANUP_EVIDENCE_FIELDS);
    let creation = json_fields("", CREATION_FIELDS);
    let target = json_fields("", TARGET_MERGE_FIELDS);
    let scripted = json_fields("", SCRIPTED_DELIVERY_FIELDS);
    let provider = json_fields("", PROVIDER_SYNC_FIELDS);
    let purge = json_fields("", PURGE_FIELDS);
    let pi = json_fields("", PI_LIFECYCLE_FIELDS);
    let attempt = cleanup_attempt_index("");
    format!(
        "
INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
SELECT 'cleanup:'||card_id,card_id,'cleanup',phase,0,error_code,error_detail,{cleanup},started_at,updated_at,completed_at
FROM card_cleanup_operations WHERE 1
ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,attempt=excluded.attempt,
  error_code=excluded.error_code,error_detail=excluded.error_detail,
  payload=CASE WHEN json_extract(operations.payload,'$.evidence') IS NOT NULL
     THEN json_patch(excluded.payload,json_object('evidence',json_extract(operations.payload,'$.evidence')))
     ELSE excluded.payload END,
  updated_at=excluded.updated_at,completed_at=excluded.completed_at;

UPDATE operations
SET payload=json_set(payload,'$.evidence',{cleanup_evidence})
FROM card_cleanup_evidence AS e
WHERE operations.id='cleanup:'||e.card_id;

INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
SELECT 'creation:'||id,card_id,'creation',phase,0,NULL,error,{creation},created_at,updated_at,NULL
FROM environment_creation_operations WHERE 1
ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,
  error_detail=excluded.error_detail,payload=excluded.payload,updated_at=excluded.updated_at;

INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
SELECT 'target_merge:'||id,card_id,'target_merge',phase,push_attempts,NULL,NULL,{target},created_at,updated_at,NULL
FROM card_target_merge_operations WHERE 1
ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,
  attempt=excluded.attempt,payload=excluded.payload,updated_at=excluded.updated_at;

INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
SELECT 'scripted_delivery:'||card_id,card_id,'scripted_delivery',stage,attempt,failure_class,summary,{scripted},started_at,updated_at,completed_at
FROM scripted_delivery_operations WHERE 1
ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,
  attempt=excluded.attempt,error_code=excluded.error_code,error_detail=excluded.error_detail,
  payload=excluded.payload,updated_at=excluded.updated_at,completed_at=excluded.completed_at;

INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
SELECT 'provider_sync:'||id,card_id,'provider_sync',state,attempts,
  CASE WHEN state='failed' THEN 'provider_sync_failed' ELSE NULL END,error,{provider},created_at,updated_at,completed_at
FROM provider_sync_operations WHERE 1
ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,
  attempt=excluded.attempt,error_code=excluded.error_code,error_detail=excluded.error_detail,
  payload=excluded.payload,updated_at=excluded.updated_at,completed_at=excluded.completed_at;

INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
SELECT 'purge:'||card_id,
  CASE WHEN EXISTS(SELECT 1 FROM kanban_cards c WHERE c.id=local_card_purge_jobs.card_id) THEN card_id ELSE NULL END,
  'purge','pending',0,NULL,NULL,{purge},0,0,NULL
FROM local_card_purge_jobs WHERE 1
ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,phase=excluded.phase,payload=excluded.payload;

INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
SELECT 'pi_lifecycle:'||card_id||':'||thread,card_id,'pi_lifecycle','active',0,NULL,NULL,{pi},0,0,NULL
FROM card_pi_lifecycle WHERE 1
ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,payload=excluded.payload;

INSERT INTO operation_attempts(operation_id,attempt,phase,started_at,finished_at,outcome,error,detail)
SELECT 'provider_sync:'||operation_id,attempt_number,'provider_sync',started_at,finished_at,outcome,error,NULL
FROM provider_sync_attempts WHERE 1
ON CONFLICT(operation_id,attempt) DO UPDATE SET phase=excluded.phase,started_at=excluded.started_at,
  finished_at=excluded.finished_at,outcome=excluded.outcome,error=excluded.error;

INSERT INTO operation_attempts(operation_id,attempt,phase,started_at,finished_at,outcome,error,detail)
SELECT 'cleanup:'||card_id,{attempt},phase,completed_at,completed_at,outcome,NULL,detail
FROM card_cleanup_phase_outcomes WHERE 1
ON CONFLICT(operation_id,attempt) DO UPDATE SET phase=excluded.phase,started_at=excluded.started_at,
  finished_at=excluded.finished_at,outcome=excluded.outcome,detail=excluded.detail;

INSERT INTO operation_attempts(operation_id,attempt,phase,started_at,finished_at,outcome,error,detail)
SELECT operation_id,attempt,'active',0,0,outcome,NULL,detail FROM (
  SELECT 'pi_lifecycle:'||card_id||':'||thread AS operation_id,
         ROW_NUMBER() OVER (PARTITION BY card_id,thread ORDER BY generation,event_id) AS attempt,
         event_id AS outcome,generation AS detail
  FROM card_pi_lifecycle_events
) WHERE 1
ON CONFLICT(operation_id,attempt) DO UPDATE SET phase=excluded.phase,outcome=excluded.outcome,detail=excluded.detail;
"
    )
}

fn trigger_sql() -> String {
    let cleanup_new = json_fields("NEW.", CLEANUP_FIELDS);
    let creation_new = json_fields("NEW.", CREATION_FIELDS);
    let target_new = json_fields("NEW.", TARGET_MERGE_FIELDS);
    let scripted_new = json_fields("NEW.", SCRIPTED_DELIVERY_FIELDS);
    let provider_new = json_fields("NEW.", PROVIDER_SYNC_FIELDS);
    let purge_new = json_fields("NEW.", PURGE_FIELDS);
    let pi_new = json_fields("NEW.", PI_LIFECYCLE_FIELDS);
    let evidence_new = json_fields("NEW.", CLEANUP_EVIDENCE_FIELDS);
    let cleanup_attempt_new = cleanup_attempt_index("NEW.");
    format!(
        "
-- Cleanup journal and its evidence/phase children.
CREATE TRIGGER IF NOT EXISTS operations_cleanup_insert AFTER INSERT ON card_cleanup_operations BEGIN
  INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
  VALUES ('cleanup:'||NEW.card_id,NEW.card_id,'cleanup',NEW.phase,0,NEW.error_code,NEW.error_detail,{cleanup_new},NEW.started_at,NEW.updated_at,NEW.completed_at)
  ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,
    error_code=excluded.error_code,error_detail=excluded.error_detail,
    payload=CASE WHEN json_extract(operations.payload,'$.evidence') IS NOT NULL
      THEN json_patch(excluded.payload,json_object('evidence',json_extract(operations.payload,'$.evidence')))
      ELSE excluded.payload END,
    updated_at=excluded.updated_at,completed_at=excluded.completed_at;
END;
CREATE TRIGGER IF NOT EXISTS operations_cleanup_update AFTER UPDATE ON card_cleanup_operations BEGIN
  INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
  VALUES ('cleanup:'||NEW.card_id,NEW.card_id,'cleanup',NEW.phase,0,NEW.error_code,NEW.error_detail,{cleanup_new},NEW.started_at,NEW.updated_at,NEW.completed_at)
  ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,
    error_code=excluded.error_code,error_detail=excluded.error_detail,
    payload=CASE WHEN json_extract(operations.payload,'$.evidence') IS NOT NULL
      THEN json_patch(excluded.payload,json_object('evidence',json_extract(operations.payload,'$.evidence')))
      ELSE excluded.payload END,
    updated_at=excluded.updated_at,completed_at=excluded.completed_at;
END;
CREATE TRIGGER IF NOT EXISTS operations_cleanup_delete AFTER DELETE ON card_cleanup_operations BEGIN
  DELETE FROM operations WHERE id='cleanup:'||OLD.card_id;
END;
CREATE TRIGGER IF NOT EXISTS operations_cleanup_evidence_insert AFTER INSERT ON card_cleanup_evidence BEGIN
  UPDATE operations SET payload=json_set(payload,'$.evidence',{evidence_new}),updated_at=NEW.captured_at
  WHERE id='cleanup:'||NEW.card_id;
END;
CREATE TRIGGER IF NOT EXISTS operations_cleanup_evidence_update AFTER UPDATE ON card_cleanup_evidence BEGIN
  UPDATE operations SET payload=json_set(payload,'$.evidence',{evidence_new}),updated_at=NEW.captured_at
  WHERE id='cleanup:'||NEW.card_id;
END;
CREATE TRIGGER IF NOT EXISTS operations_cleanup_evidence_delete AFTER DELETE ON card_cleanup_evidence BEGIN
  UPDATE operations SET payload=json_remove(payload,'$.evidence') WHERE id='cleanup:'||OLD.card_id;
END;
CREATE TRIGGER IF NOT EXISTS operations_cleanup_outcome_insert AFTER INSERT ON card_cleanup_phase_outcomes BEGIN
  INSERT INTO operation_attempts(operation_id,attempt,phase,started_at,finished_at,outcome,error,detail)
  VALUES ('cleanup:'||NEW.card_id,{cleanup_attempt_new},NEW.phase,NEW.completed_at,NEW.completed_at,NEW.outcome,NULL,NEW.detail)
  ON CONFLICT(operation_id,attempt) DO UPDATE SET phase=excluded.phase,started_at=excluded.started_at,
    finished_at=excluded.finished_at,outcome=excluded.outcome,detail=excluded.detail;
END;
CREATE TRIGGER IF NOT EXISTS operations_cleanup_outcome_update AFTER UPDATE ON card_cleanup_phase_outcomes BEGIN
  INSERT INTO operation_attempts(operation_id,attempt,phase,started_at,finished_at,outcome,error,detail)
  VALUES ('cleanup:'||NEW.card_id,{cleanup_attempt_new},NEW.phase,NEW.completed_at,NEW.completed_at,NEW.outcome,NULL,NEW.detail)
  ON CONFLICT(operation_id,attempt) DO UPDATE SET phase=excluded.phase,started_at=excluded.started_at,
    finished_at=excluded.finished_at,outcome=excluded.outcome,detail=excluded.detail;
END;
CREATE TRIGGER IF NOT EXISTS operations_cleanup_outcome_delete AFTER DELETE ON card_cleanup_phase_outcomes BEGIN
  DELETE FROM operation_attempts WHERE operation_id='cleanup:'||OLD.card_id AND phase=OLD.phase;
END;

-- Environment creation journal.
CREATE TRIGGER IF NOT EXISTS operations_creation_insert AFTER INSERT ON environment_creation_operations BEGIN
  INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
  VALUES ('creation:'||NEW.id,NEW.card_id,'creation',NEW.phase,0,NULL,NEW.error,{creation_new},NEW.created_at,NEW.updated_at,NULL)
  ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,
    error_detail=excluded.error_detail,payload=excluded.payload,updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS operations_creation_update AFTER UPDATE ON environment_creation_operations BEGIN
  INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
  VALUES ('creation:'||NEW.id,NEW.card_id,'creation',NEW.phase,0,NULL,NEW.error,{creation_new},NEW.created_at,NEW.updated_at,NULL)
  ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,
    error_detail=excluded.error_detail,payload=excluded.payload,updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS operations_creation_delete AFTER DELETE ON environment_creation_operations BEGIN
  DELETE FROM operations WHERE id='creation:'||OLD.id;
END;

-- Target merge journal.
CREATE TRIGGER IF NOT EXISTS operations_target_merge_insert AFTER INSERT ON card_target_merge_operations BEGIN
  INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
  VALUES ('target_merge:'||NEW.id,NEW.card_id,'target_merge',NEW.phase,NEW.push_attempts,NULL,NULL,{target_new},NEW.created_at,NEW.updated_at,NULL)
  ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,
    attempt=excluded.attempt,payload=excluded.payload,updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS operations_target_merge_update AFTER UPDATE ON card_target_merge_operations BEGIN
  INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
  VALUES ('target_merge:'||NEW.id,NEW.card_id,'target_merge',NEW.phase,NEW.push_attempts,NULL,NULL,{target_new},NEW.created_at,NEW.updated_at,NULL)
  ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,
    attempt=excluded.attempt,payload=excluded.payload,updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS operations_target_merge_delete AFTER DELETE ON card_target_merge_operations BEGIN
  DELETE FROM operations WHERE id='target_merge:'||OLD.id;
END;

-- Scripted delivery journal.
CREATE TRIGGER IF NOT EXISTS operations_scripted_insert AFTER INSERT ON scripted_delivery_operations BEGIN
  INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
  VALUES ('scripted_delivery:'||NEW.card_id,NEW.card_id,'scripted_delivery',NEW.stage,NEW.attempt,NEW.failure_class,NEW.summary,{scripted_new},NEW.started_at,NEW.updated_at,NEW.completed_at)
  ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,
    attempt=excluded.attempt,error_code=excluded.error_code,error_detail=excluded.error_detail,
    payload=excluded.payload,updated_at=excluded.updated_at,completed_at=excluded.completed_at;
END;
CREATE TRIGGER IF NOT EXISTS operations_scripted_update AFTER UPDATE ON scripted_delivery_operations BEGIN
  INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
  VALUES ('scripted_delivery:'||NEW.card_id,NEW.card_id,'scripted_delivery',NEW.stage,NEW.attempt,NEW.failure_class,NEW.summary,{scripted_new},NEW.started_at,NEW.updated_at,NEW.completed_at)
  ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,
    attempt=excluded.attempt,error_code=excluded.error_code,error_detail=excluded.error_detail,
    payload=excluded.payload,updated_at=excluded.updated_at,completed_at=excluded.completed_at;
END;
CREATE TRIGGER IF NOT EXISTS operations_scripted_delete AFTER DELETE ON scripted_delivery_operations BEGIN
  DELETE FROM operations WHERE id='scripted_delivery:'||OLD.card_id;
END;

-- Provider synchronization journal and its attempt history.
CREATE TRIGGER IF NOT EXISTS operations_provider_insert AFTER INSERT ON provider_sync_operations BEGIN
  INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
  VALUES ('provider_sync:'||NEW.id,NEW.card_id,'provider_sync',NEW.state,NEW.attempts,
    CASE WHEN NEW.state='failed' THEN 'provider_sync_failed' ELSE NULL END,NEW.error,{provider_new},NEW.created_at,NEW.updated_at,NEW.completed_at)
  ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,
    attempt=excluded.attempt,error_code=excluded.error_code,error_detail=excluded.error_detail,
    payload=excluded.payload,updated_at=excluded.updated_at,completed_at=excluded.completed_at;
END;
CREATE TRIGGER IF NOT EXISTS operations_provider_update AFTER UPDATE ON provider_sync_operations BEGIN
  INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
  VALUES ('provider_sync:'||NEW.id,NEW.card_id,'provider_sync',NEW.state,NEW.attempts,
    CASE WHEN NEW.state='failed' THEN 'provider_sync_failed' ELSE NULL END,NEW.error,{provider_new},NEW.created_at,NEW.updated_at,NEW.completed_at)
  ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,
    attempt=excluded.attempt,error_code=excluded.error_code,error_detail=excluded.error_detail,
    payload=excluded.payload,updated_at=excluded.updated_at,completed_at=excluded.completed_at;
END;
CREATE TRIGGER IF NOT EXISTS operations_provider_delete AFTER DELETE ON provider_sync_operations BEGIN
  DELETE FROM operations WHERE id='provider_sync:'||OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS operations_provider_attempt_insert AFTER INSERT ON provider_sync_attempts BEGIN
  INSERT INTO operation_attempts(operation_id,attempt,phase,started_at,finished_at,outcome,error,detail)
  VALUES ('provider_sync:'||NEW.operation_id,NEW.attempt_number,'provider_sync',NEW.started_at,NEW.finished_at,NEW.outcome,NEW.error,NULL)
  ON CONFLICT(operation_id,attempt) DO UPDATE SET phase=excluded.phase,started_at=excluded.started_at,
    finished_at=excluded.finished_at,outcome=excluded.outcome,error=excluded.error;
END;
CREATE TRIGGER IF NOT EXISTS operations_provider_attempt_update AFTER UPDATE ON provider_sync_attempts BEGIN
  INSERT INTO operation_attempts(operation_id,attempt,phase,started_at,finished_at,outcome,error,detail)
  VALUES ('provider_sync:'||NEW.operation_id,NEW.attempt_number,'provider_sync',NEW.started_at,NEW.finished_at,NEW.outcome,NEW.error,NULL)
  ON CONFLICT(operation_id,attempt) DO UPDATE SET phase=excluded.phase,started_at=excluded.started_at,
    finished_at=excluded.finished_at,outcome=excluded.outcome,error=excluded.error;
END;
CREATE TRIGGER IF NOT EXISTS operations_provider_attempt_delete AFTER DELETE ON provider_sync_attempts BEGIN
  DELETE FROM operation_attempts WHERE operation_id='provider_sync:'||OLD.operation_id AND attempt=OLD.attempt_number;
END;

-- Local purge tombstone. It outlives the card, so the payload keeps the identity.
CREATE TRIGGER IF NOT EXISTS operations_purge_insert AFTER INSERT ON local_card_purge_jobs BEGIN
  INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
  VALUES ('purge:'||NEW.card_id,NEW.card_id,'purge','pending',0,NULL,NULL,{purge_new},0,0,NULL)
  ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,phase=excluded.phase,payload=excluded.payload;
END;
CREATE TRIGGER IF NOT EXISTS operations_purge_update AFTER UPDATE ON local_card_purge_jobs BEGIN
  INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
  VALUES ('purge:'||NEW.card_id,NEW.card_id,'purge','pending',0,NULL,NULL,{purge_new},0,0,NULL)
  ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,phase=excluded.phase,payload=excluded.payload;
END;
CREATE TRIGGER IF NOT EXISTS operations_purge_delete AFTER DELETE ON local_card_purge_jobs BEGIN
  DELETE FROM operations WHERE id='purge:'||OLD.card_id;
END;

-- Pi lifecycle cursors and their event dedupe history.
CREATE TRIGGER IF NOT EXISTS operations_pi_insert AFTER INSERT ON card_pi_lifecycle BEGIN
  INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
  VALUES ('pi_lifecycle:'||NEW.card_id||':'||NEW.thread,NEW.card_id,'pi_lifecycle','active',0,NULL,NULL,{pi_new},0,0,NULL)
  ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,payload=excluded.payload;
END;
CREATE TRIGGER IF NOT EXISTS operations_pi_update AFTER UPDATE ON card_pi_lifecycle BEGIN
  INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
  VALUES ('pi_lifecycle:'||NEW.card_id||':'||NEW.thread,NEW.card_id,'pi_lifecycle','active',0,NULL,NULL,{pi_new},0,0,NULL)
  ON CONFLICT(id) DO UPDATE SET card_id=excluded.card_id,kind=excluded.kind,phase=excluded.phase,payload=excluded.payload;
END;
CREATE TRIGGER IF NOT EXISTS operations_pi_delete AFTER DELETE ON card_pi_lifecycle BEGIN
  DELETE FROM operations WHERE id='pi_lifecycle:'||OLD.card_id||':'||OLD.thread;
END;
CREATE TRIGGER IF NOT EXISTS operations_pi_event_insert AFTER INSERT ON card_pi_lifecycle_events BEGIN
  INSERT INTO operation_attempts(operation_id,attempt,phase,started_at,finished_at,outcome,error,detail)
  SELECT 'pi_lifecycle:'||NEW.card_id||':'||NEW.thread,
         COALESCE(MAX(attempt),0)+1,'active',0,0,NEW.event_id,NULL,NEW.generation
  FROM operation_attempts WHERE operation_id='pi_lifecycle:'||NEW.card_id||':'||NEW.thread
  ON CONFLICT(operation_id,attempt) DO UPDATE SET outcome=excluded.outcome,detail=excluded.detail;
END;
CREATE TRIGGER IF NOT EXISTS operations_pi_event_update AFTER UPDATE ON card_pi_lifecycle_events BEGIN
  INSERT INTO operation_attempts(operation_id,attempt,phase,started_at,finished_at,outcome,error,detail)
  SELECT 'pi_lifecycle:'||NEW.card_id||':'||NEW.thread,
         COALESCE(MAX(attempt),0)+1,'active',0,0,NEW.event_id,NULL,NEW.generation
  FROM operation_attempts WHERE operation_id='pi_lifecycle:'||NEW.card_id||':'||NEW.thread
  ON CONFLICT(operation_id,attempt) DO UPDATE SET outcome=excluded.outcome,detail=excluded.detail;
END;
CREATE TRIGGER IF NOT EXISTS operations_pi_event_delete AFTER DELETE ON card_pi_lifecycle_events BEGIN
  DELETE FROM operation_attempts WHERE operation_id='pi_lifecycle:'||OLD.card_id||':'||OLD.thread
    AND outcome=OLD.event_id AND detail=OLD.generation;
END;
"
    )
}
