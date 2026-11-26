//! One gate and one repair path for every "this card is blocked" state (card #350).
//!
//! Before this module, five mechanisms each decided whether a card could be acted on
//! and each used its own vocabulary: `health.rs` issues, `cleanup.rs` blockers,
//! `retirement.rs` codes, `hygiene.rs` findings and `done_retention.rs` safety
//! reasons. A state could be visible in one place, invisible in another, and
//! unrepairable in all of them.
//!
//! [`evaluate`] is now the only evaluation. Every consumer renders the same
//! [`Blocker`] values and every blocker carries the [`Repair`] that clears it (or an
//! explicit "this needs you" instruction). Mode-specific differences live in
//! [`GateContext`], never in a second checklist.
//!
//! ```text
//! GateMode::Health      the environment banner + action gating
//! GateMode::Action(a)   the same checks, filtered to what `a` needs
//! GateMode::Retire(m)   the retirement invariant checklist
//! GateMode::Retention   why Done retention defers this card
//! ```
//!
//! `cleanup.rs` keeps its detailed resource inventory (that is its job) but records
//! its reasons through [`GateVerdict::push`], so its codes, copy and repairs come
//! from this module too. `hygiene.rs` is the repair executor plus the report.

use super::health::{db_error, unix_timestamp};
use super::retirement::{RetirementMode, RetirementOverride};
use super::*;
#[allow(unused_imports)]
use super::{
    cards::*, cleanup::*, domain::*, done_retention::*, environment::*, git_effects::*,
    local_delivery::*, operations::*, repository::*, sync::*, workflow::*,
};
use rusqlite::{params, Connection, OptionalExtension};

// Canonical blocker messages. These are the strings the UI already shows; the gate
// owns them so a code cannot drift from its copy.
pub(in crate::kanban) const LINKED_CHILDREN: &str =
    "Linked children make this card an aggregate; reload before attempting leaf work";
pub(in crate::kanban) const DIRTY_WORKTREE: &str =
    "Source worktree is dirty. Commit, stash, or discard its changes before cleanup.";
pub(in crate::kanban) const ACTIVE_GIT_OPERATION: &str =
    "Source worktree has an active Git operation. Finish or abort it before cleanup.";
pub(in crate::kanban) const UNREGISTERED_WORKTREE: &str = "Source path is not a registered worktree.";
pub(in crate::kanban) const UNMERGED_REVISION: &str =
    "Exact source revision is not authoritatively merged.";
pub(in crate::kanban) const OPEN_PULL_REQUEST: &str =
    "The card has an open pull request; merge or close it before removing resources.";
pub(in crate::kanban) const UNRESOLVED_OPERATION: &str =
    "An incomplete cleanup operation must be resumed instead of deleting its environment metadata.";
pub(in crate::kanban) const RUNTIME_PROCESSES: &str =
    "Card terminal processes are running; stop them before cleaning up the environment.";
pub(in crate::kanban) const SHARED_STORAGE_KEY: &str = "Card storage key is shared with another card";
pub(in crate::kanban) const INVALID_ENVIRONMENT_OWNERSHIP: &str =
    "The card environment or project ownership is invalid";
pub(in crate::kanban) const PRIMARY_CHECKOUT: &str =
    "Source worktree is the configured primary checkout and cannot be removed.";
pub(in crate::kanban) const FOREIGN_REPOSITORY: &str =
    "Source worktree belongs to another repository.";
pub(in crate::kanban) const ONLY_CLEANUP_METADATA_REMAINS: &str = "Only cleanup metadata remains.";
pub(in crate::kanban) const STALE_LIFECYCLE_PROJECTION: &str =
    "A Pi lifecycle row is still marked active but no session is running. Clear the stale projection.";

/// One stable, machine-readable blocker code. `ALL` is the single reviewable table:
/// every code names the copy the UI shows and the repair that clears it.
macro_rules! blocker_codes {
    ($( $variant:ident => ($code:literal, $message:expr, $step:ident, $repair:ident) ),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub(in crate::kanban) enum BlockerCode { $($variant),+ }

        impl BlockerCode {
            pub(in crate::kanban) const ALL: &'static [BlockerCode] = &[$(BlockerCode::$variant),+];

            pub(in crate::kanban) const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $code),+ }
            }

            pub(in crate::kanban) fn message(self) -> &'static str {
                match self { $(Self::$variant => $message),+ }
            }

            pub(in crate::kanban) fn step(self) -> GateAction {
                match self { $(Self::$variant => GateAction::$step),+ }
            }

            pub(in crate::kanban) fn repair(self) -> RepairId {
                match self { $(Self::$variant => RepairId::$repair),+ }
            }

            pub(in crate::kanban) fn from_str(value: &str) -> Option<Self> {
                Self::ALL.iter().copied().find(|code| code.as_str() == value)
            }
        }
    };
}

blocker_codes! {
    // ---- health.rs vocabulary (the environment banner) ----
    CleanupEnvironmentReplaced => ("cleanup_environment_replaced", "Cleanup evidence belongs to a different environment or revision. Do not retry deletion; inspect the operation and resources.", Cleanup, InspectCleanupEvidence),
    CleanupEnvironmentMissing => ("cleanup_environment_missing", "Cleanup metadata has no captured environment and no completed removal evidence. Inspect resources before retrying.", Cleanup, InspectCleanupEvidence),
    CleanupEnvironmentRetained => ("cleanup_environment_retained", "Completed cleanup still has an environment. Inspect resources before taking further action.", Cleanup, InspectCleanupEvidence),
    ParentStateInconsistent => ("parent_state_inconsistent", "This Superthread parent has conflicting local workflow or environment state. Leaf actions are blocked. Inspect the remote hierarchy and resolve any worktree, branch, process or PR separately before reconciling parent metadata.", Work, ReconcileParent),
    TargetMergePending => ("target_merge_pending", "Target synchronization is incomplete. Use Merge in target & resolve to resume or recover it.", Merge, MergeInTarget),
    EnvironmentMissing => ("environment_missing", "This card needs a usable environment.", Work, StartWork),
    EnvironmentNotReady => ("environment_not_ready", "The recorded environment is not ready for workflow operations.", Work, StartWork),
    ProjectMetadataMissing => ("project_metadata_missing", "The environment has no recorded project.", Work, AssignProject),
    EnvironmentProjectMismatch => ("environment_project_mismatch", "The card and its environment belong to different projects. Project-dependent operations are blocked.", Work, AssignProject),
    CardProjectMissing => ("card_project_missing", "The card's owning project no longer exists.", Work, AssignProject),
    SourceBranchMissing => ("source_branch_missing", "The source branch metadata is missing.", Work, StartWork),
    RepositoryMetadataMissing => ("repository_metadata_missing", "The environment has no recorded repository. Set the merge target again.", Merge, SetMergeTarget),
    TargetCheckoutMissing => ("target_checkout_missing", "The target checkout metadata is missing. Set the merge target before continuing.", Merge, SetMergeTarget),
    TargetBranchMissing => ("target_branch_missing", "The target branch metadata is missing. Set the merge target before continuing.", Merge, SetMergeTarget),
    SourceTargetBranchSame => ("source_target_branch_same", "The source and target branches are not distinct.", Merge, SetMergeTarget),
    SourceRevisionMissing => ("source_revision_missing", "The merged source revision metadata is missing.", Cleanup, InspectCleanupEvidence),
    ProjectRepositoryMismatch => ("project_repository_mismatch", "The owning project's configured checkout belongs to a different repository.", Work, FixRepositoryConfiguration),
    ProjectCheckoutUnavailable => ("project_checkout_unavailable", "Stacks could not identify the owning project's configured repository.", Work, FixRepositoryConfiguration),
    SourceCheckoutUnavailable => ("source_checkout_unavailable", "The source checkout is missing or inaccessible.", Work, StartWork),
    SourceRepositoryMismatch => ("source_repository_mismatch", "The source checkout belongs to a different repository.", Work, FixRepositoryConfiguration),
    SourceRepositoryUnavailable => ("source_repository_unavailable", "Stacks could not identify the source repository.", Work, FixRepositoryConfiguration),
    SourceBranchMismatch => ("source_branch_mismatch", "The source checkout is on a different branch.", Work, CheckoutRecordedBranch),
    SourceCheckoutDetached => ("source_checkout_detached", "The source checkout is detached; a named branch is required.", Work, CheckoutRecordedBranch),
    SourceGitOperationInProgress => ("source_git_operation_in_progress", "The source checkout has an in-progress Git operation.", Work, FinishGitOperation),
    SourceGitStateUnavailable => ("source_git_state_unavailable", "Stacks could not determine whether the source checkout has an in-progress Git operation.", Work, InspectCheckout),
    SourceRevisionUnavailable => ("source_revision_unavailable", "Stacks could not read the source checkout revision.", Work, InspectCheckout),
    TargetCheckoutUnavailable => ("target_checkout_unavailable", "The target checkout is missing or inaccessible.", Merge, SetMergeTarget),
    TargetRepositoryMismatch => ("target_repository_mismatch", "The target checkout belongs to a different repository.", Merge, FixRepositoryConfiguration),
    TargetRepositoryUnavailable => ("target_repository_unavailable", "Stacks could not identify the target repository.", Merge, FixRepositoryConfiguration),
    TargetBranchMismatch => ("target_branch_mismatch", "The target checkout is on a different branch.", Merge, CheckoutTargetBranch),
    TargetCheckoutDetached => ("target_checkout_detached", "The target checkout is detached; a named branch is required.", Merge, CheckoutTargetBranch),
    TargetGitOperationInProgress => ("target_git_operation_in_progress", "The target checkout has an in-progress Git operation.", Merge, FinishGitOperation),
    TargetGitStateUnavailable => ("target_git_state_unavailable", "Stacks could not determine whether the target checkout has an in-progress Git operation.", Merge, InspectCheckout),
    SourceWorktreeNotRegistered => ("source_worktree_not_registered", "The source checkout is not a distinct registered worktree of the target repository.", Merge, RegisterWorktree),
    SourceRevisionChanged => ("source_revision_changed", "The source branch has new commits since merge; merge again before cleanup.", Cleanup, MergeInTarget),
    TargetCheckoutBehind => ("target_checkout_behind", "The merged revision is on the remote target, but the target checkout is behind it.", Cleanup, PullTargetCheckout),
    SourceRevisionNotMerged => ("source_revision_not_merged", "The merged source revision is no longer reachable from the target branch.", Cleanup, ReviewHistory),
    AncestryCheckFailed => ("ancestry_check_failed", "Stacks could not verify that the source revision is reachable from the target branch.", Cleanup, InspectCheckout),

    // ---- retirement.rs vocabulary ----
    LinkedChildren => ("linked_children", LINKED_CHILDREN, Work, RetireChildren),
    InvalidEnvironmentOwnership => ("invalid_environment_ownership", INVALID_ENVIRONMENT_OWNERSHIP, Cleanup, AssignProject),
    SharedStorageKey => ("shared_storage_key", SHARED_STORAGE_KEY, Delete, ResolveStorageCollision),
    RuntimeProcesses => ("runtime_processes", RUNTIME_PROCESSES, Cleanup, RetryRuntimeCleanup),
    PrimaryCheckout => ("primary_checkout", PRIMARY_CHECKOUT, Cleanup, ResolveWorktree),
    ForeignRepository => ("foreign_repository", FOREIGN_REPOSITORY, Cleanup, FixRepositoryConfiguration),
    DirtyWorktree => ("dirty_worktree", DIRTY_WORKTREE, Cleanup, CommitOrStash),
    ActiveGitOperation => ("active_git_operation", ACTIVE_GIT_OPERATION, Cleanup, FinishGitOperation),
    UnmergedRevision => ("unmerged_revision", UNMERGED_REVISION, Cleanup, MergeInTarget),
    OpenPullRequest => ("open_pull_request", OPEN_PULL_REQUEST, Cleanup, MergeOrClosePullRequest),
    UnresolvedOperation => ("unresolved_operation", UNRESOLVED_OPERATION, Cleanup, ResumeCleanup),

    // ---- cleanup.rs vocabulary (resource inventory reasons) ----
    CleanupOnlyDoneEligible => ("cleanup_only_done_eligible", "Only Done cards are eligible for cleanup.", Cleanup, RetryRuntimeCleanup),
    CleanupSourceIdentityMissing => ("cleanup_source_identity_missing", "The card environment lacks immutable source identity evidence.", Cleanup, InspectCleanupEvidence),
    PrimaryCheckoutBranchMismatch => ("primary_checkout_branch_mismatch", "The primary checkout is on a branch other than the configured target branch.", Merge, CheckoutTargetBranch),
    PrimaryCheckoutInvalid => ("primary_checkout_invalid", "The primary checkout could not be validated.", Merge, FixRepositoryConfiguration),
    SourceBranchTipMismatch => ("source_branch_tip_mismatch", "Local source branch and worktree tips differ.", Cleanup, InspectCheckout),
    SourceBranchAbsent => ("source_branch_absent", "Recorded local source branch is absent.", Cleanup, InspectCheckout),
    OnlyCleanupMetadataRemains => ("only_cleanup_metadata_remains", ONLY_CLEANUP_METADATA_REMAINS, Cleanup, ResumeCleanup),
    TargetReconfiguredUnmerged => ("target_reconfigured_unmerged", "Recorded target changed and the exact source revision is not an ancestor of the configured target; Stacks will not reinterpret unmerged work.", Cleanup, ReviewHistory),
    CompletionOutcomeMissing => ("completion_outcome_missing", "Done card has no recognized completion outcome.", Cleanup, ReviewHistory),
    RemoteDeletionEvidenceMissing => ("remote_deletion_evidence_missing", "Required remote deletion needs matching merged-PR repository, number, and exact head revision evidence.", Cleanup, MergeInTarget),
    RemoteBranchTipChanged => ("remote_branch_tip_changed", "Remote branch tip changed; it is retained and cannot be deleted with the captured lease.", Cleanup, InspectCheckout),
    RemoteBranchUnverifiable => ("remote_branch_unverifiable", "The required remote branch cannot be verified.", Cleanup, InspectCheckout),
    SourceHeadUnavailable => ("source_head_unavailable", "Source HEAD could not be inspected.", Cleanup, InspectCheckout),
    RemoteBranchDeletePending => ("remote_branch_delete_pending", "Remote branch deletion is required by the delivery workflow.", Cleanup, ResumeCleanup),
    MergedPrEvidenceUnavailable => ("merged_pr_evidence_unavailable", "Merged pull-request evidence could not be refreshed.", Cleanup, InspectCleanupEvidence),

    // ---- retention / hygiene vocabulary ----
    FinalizedParentWithoutChildren => ("finalized_parent_without_children", "A finalized aggregate has no linked children.", Work, RepairParentMetadata),
    StaleParentChildCount => ("stale_parent_child_count", "An aggregate still records a provider child count but has no linked children.", Work, RepairParentMetadata),
    EnvironmentWorktreeMissing => ("environment_worktree_missing", "The card environment's worktree is gone.", Cleanup, CleanupOrphanedEnvironment),
    OwningEnvironment => ("owning_environment", "owning environment", Cleanup, ResumeCleanup),
    IncompleteCleanupOperation => ("incomplete_cleanup_operation", "incomplete cleanup operation", Cleanup, ResumeCleanup),
    RetainedHierarchy => ("retained_hierarchy", "retained hierarchy", Delete, RetireChildren),
    UnresolvedProviderDeliveryOperation => ("unresolved_provider_delivery_operation", "unresolved provider/delivery operation", Cleanup, ResumeCleanup),
    UnactionableCard => ("unactionable_card", "No workflow action is available for the stored status and context.", Work, AssignProject),
    ProviderIncompatible => ("provider_incompatible", "The card provider is incompatible with its project", Work, AssignProject),
    StaleLifecycleProjection => ("stale_lifecycle_projection", STALE_LIFECYCLE_PROJECTION, Cleanup, ClearStaleLifecycle),
    ProviderSyncPending => ("provider_sync_pending", "A provider synchronization was queued and never drained.", Cleanup, RetryProviderSync),
}

/// The action a blocker affects. `Health` renders this as the banner's
/// "Affects …" chip; action gating matches it against the requested action.
macro_rules! gate_actions {
    ($( $variant:ident => $value:literal ),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
        #[serde(rename_all = "snake_case")]
        pub(in crate::kanban) enum GateAction { $($variant),+ }

        impl GateAction {
            pub(in crate::kanban) fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $value),+ }
            }
        }
    };
}

gate_actions! {
    Work => "work",
    Approval => "approval",
    Merge => "merge",
    Cleanup => "cleanup",
    Delete => "delete",
}

/// A repair that clears (or explains how a human clears) a blocker. `Automatic`
/// repairs are safe and idempotent and can be applied from the UI in one click;
/// `NeedsUser` repairs are an explicit instruction, never a silent mutation.
macro_rules! repair_ids {
    ($( $variant:ident => ($id:literal, $label:literal, $kind:ident, $effect:literal) ),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub(in crate::kanban) enum RepairId { $($variant),+ }

        impl RepairId {
            pub(in crate::kanban) const ALL: &'static [RepairId] = &[$(RepairId::$variant),+];

            pub(in crate::kanban) const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $id),+ }
            }

            pub(in crate::kanban) fn label(self) -> &'static str {
                match self { $(Self::$variant => $label),+ }
            }

            pub(in crate::kanban) fn kind(self) -> RepairKind {
                match self { $(Self::$variant => RepairKind::$kind),+ }
            }

            pub(in crate::kanban) fn effect(self) -> &'static str {
                match self { $(Self::$variant => $effect),+ }
            }

            pub(in crate::kanban) fn repair(self) -> Repair {
                Repair {
                    id: self.as_str().to_string(),
                    label: self.label().to_string(),
                    kind: self.kind(),
                    effect: self.effect().to_string(),
                }
            }

            pub(in crate::kanban) fn from_str(value: &str) -> Option<Self> {
                Self::ALL.iter().copied().find(|id| id.as_str() == value)
            }
        }
    };
}

repair_ids! {
    RepairParentMetadata => ("repair_parent_metadata", "Repair", Automatic, "Clear stale aggregate metadata that cannot describe any existing child."),
    ClearStaleLifecycle => ("clear_stale_lifecycle", "Clear stale lifecycle", Automatic, "Delete the Pi lifecycle projection that has no running session."),
    CleanupOrphanedEnvironment => ("cleanup_orphaned_environment", "Clean up environment", Automatic, "Remove the orphaned environment, its exact branch tip and its metadata."),
    RetryProviderSync => ("retry_provider_sync", "Retry provider sync", Automatic, "Drain the queued Superthread update."),
    PullTargetCheckout => ("pull_target_checkout", "Pull target checkout", Automatic, "Fast-forward the target checkout when it is clean and behind its remote."),
    ResumeCleanup => ("resume_cleanup", "Resume cleanup", NeedsUser, "Open Clean up environment to finish the interrupted cleanup operation."),
    RetryRuntimeCleanup => ("retry_runtime_cleanup", "Retry process cleanup", NeedsUser, "Stop the card's terminal and Pi processes, then retry."),
    InspectCleanupEvidence => ("inspect_cleanup_evidence", "Inspect cleanup evidence", NeedsUser, "Review the cleanup operation and the resources on disk before deciding what to remove."),
    ReconcileParent => ("reconcile_parent", "Reconcile parent", NeedsUser, "Resolve the remote hierarchy and the card's own resources separately, then reconcile parent state."),
    MergeInTarget => ("merge_in_target", "Merge in target & resolve", NeedsUser, "Finish or recover the target merge from the card's Merge action."),
    StartWork => ("start_work", "Start work", NeedsUser, "Create (or retry) the card's environment from Start work."),
    AssignProject => ("assign_project", "Assign a project", NeedsUser, "Give the card its owning project again."),
    SetMergeTarget => ("set_merge_target", "Set merge target", NeedsUser, "Record the target checkout and branch for this environment."),
    FixRepositoryConfiguration => ("fix_repository_configuration", "Fix repository configuration", NeedsUser, "Point the project or environment at the correct Git repository."),
    CheckoutRecordedBranch => ("checkout_recorded_branch", "Check out the recorded branch", NeedsUser, "Restore the branch recorded on the card environment."),
    CheckoutTargetBranch => ("checkout_target_branch", "Check out the target branch", NeedsUser, "Check the configured target branch out in the primary checkout."),
    FinishGitOperation => ("finish_git_operation", "Finish or abort the Git operation", NeedsUser, "Complete or abort the merge/rebase/cherry-pick in the named checkout."),
    InspectCheckout => ("inspect_checkout", "Inspect the checkout", NeedsUser, "Look at the worktree/repository state Stacks could not read."),
    RegisterWorktree => ("register_worktree", "Register the worktree", NeedsUser, "Re-register the recorded source path as a worktree of the target repository."),
    ReviewHistory => ("review_history", "Review Git history", NeedsUser, "Confirm the merge/ancestry manually before removing anything."),
    RetireChildren => ("retire_children", "Retire the children first", NeedsUser, "Retire the linked children before treating this card as a leaf."),
    ResolveStorageCollision => ("resolve_storage_collision", "Resolve the storage collision", NeedsUser, "Two cards share one local storage key; move or delete one before purging files."),
    ResolveWorktree => ("resolve_worktree", "Move the worktree", NeedsUser, "The source path is the primary checkout; it cannot be removed."),
    CommitOrStash => ("commit_or_stash", "Commit, stash or discard", NeedsUser, "Leave the source worktree clean before cleanup."),
    MergeOrClosePullRequest => ("merge_or_close_pull_request", "Merge or close the pull request", NeedsUser, "Resolve the open pull request before removing resources."),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepairKind {
    Automatic,
    NeedsUser,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Repair {
    pub id: String,
    pub label: String,
    pub kind: RepairKind,
    pub effect: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(in crate::kanban) struct Blocker {
    pub(in crate::kanban) code: BlockerCode,
    pub(in crate::kanban) message: String,
    pub(in crate::kanban) step: GateAction,
    pub(in crate::kanban) repair: Repair,
}

/// Facts the gate already loaded. Consumers (retirement) use them instead of
/// re-reading the same row and re-inventing the same query.
#[derive(Debug, Clone, Default)]
pub(in crate::kanban) struct GateFacts {
    pub(in crate::kanban) status: String,
    pub(in crate::kanban) completion_outcome: Option<String>,
    pub(in crate::kanban) workflow_revision: i64,
    pub(in crate::kanban) project_id: Option<String>,
    pub(in crate::kanban) environment_id: Option<String>,
    pub(in crate::kanban) environment_revision: i64,
    pub(in crate::kanban) worktree_path: Option<String>,
    pub(in crate::kanban) branch: Option<String>,
    pub(in crate::kanban) repository_id: Option<String>,
    pub(in crate::kanban) target_path: Option<String>,
    pub(in crate::kanban) source_revision: Option<String>,
    pub(in crate::kanban) merged: bool,
    pub(in crate::kanban) has_resources: bool,
    pub(in crate::kanban) override_available: bool,
}

#[derive(Debug, Clone, Default)]
pub(in crate::kanban) struct GateVerdict {
    pub(in crate::kanban) code_strings: Vec<String>,
    pub(in crate::kanban) blockers: Vec<Blocker>,
    pub(in crate::kanban) repairs: Vec<Repair>,
    pub(in crate::kanban) facts: GateFacts,
}

impl GateVerdict {
    pub(in crate::kanban) fn new() -> Self {
        Self::default()
    }

    /// Record a blocker. The repair comes from the code table, so a new invariant
    /// cannot ship without an action.
    pub(in crate::kanban) fn push(
        &mut self,
        code: BlockerCode,
        message: impl Into<String>,
        step: GateAction,
    ) {
        let message = message.into();
        if self
            .blockers
            .iter()
            .any(|blocker| blocker.code == code && blocker.message == message)
        {
            return;
        }
        let repair = code.repair().repair();
        if !self.repairs.iter().any(|item| item.id == repair.id) {
            self.repairs.push(repair.clone());
        }
        if !self.code_strings.iter().any(|value| value == code.as_str()) {
            self.code_strings.push(code.as_str().to_string());
        }
        self.blockers.push(Blocker {
            code,
            message,
            step,
            repair,
        });
    }

    pub(in crate::kanban) fn push_code(&mut self, code: BlockerCode) {
        self.push(code, code.message(), code.step());
    }

    pub(in crate::kanban) fn blocked(&self) -> bool {
        !self.blockers.is_empty()
    }

    pub(in crate::kanban) fn codes(&self) -> Vec<String> {
        self.code_strings.clone()
    }

    /// The first blocker that affects `action`, following the same mapping the
    /// workflow capability layer uses. Used at the mutation boundary so the banner
    /// and `disabled_reason` cannot disagree.
    pub(in crate::kanban) fn blocker_for(&self, action: WorkflowAction) -> Option<&Blocker> {
        let steps = gate_steps_for_action(action)?;
        self.blockers
            .iter()
            .find(|blocker| steps.contains(&blocker.step))
    }

    /// Health's response shape: copy, step and repair for every blocker.
    pub(in crate::kanban) fn issues(&self, card_id: &str) -> CardEnvironmentHealth {
        CardEnvironmentHealth {
            card_id: card_id.to_string(),
            issues: self
                .blockers
                .iter()
                .map(|blocker| EnvironmentHealthIssue {
                    code: blocker.code.as_str().to_string(),
                    message: blocker.message.clone(),
                    step: blocker.step.as_str().to_string(),
                    repair: Some(blocker.repair.clone()),
                })
                .collect(),
        }
    }
}

/// Which actions a blocker step can disable. Deliberately narrow: human decision
/// actions (request changes, close, refinement) and `Delete` stay available so a
/// broken environment never removes the escape hatch.
pub(in crate::kanban) fn gate_steps_for_action(action: WorkflowAction) -> Option<&'static [GateAction]> {
    use WorkflowAction::*;
    match action {
        StartWork | ReturnToRefinement => Some(&[GateAction::Work]),
        FinishRefinement | OpenRefinement | StopRefinement => None,
        RequestChanges => None,
        Ship | MergeLocal | Push | Deploy | RetryPush | RetryDeploy | ConfirmDeployed
        | RunDeploymentAgain | CancelDeployment | CreatePr | CreatePrWithFe | OpenPr | MergePr
        | MergeTarget => Some(&[GateAction::Merge, GateAction::Approval]),
        Cleanup => Some(&[GateAction::Cleanup]),
        // Recovery paths must stay available: they are the repairs for the states
        // the gate reports, so gating them would recreate the dead end.
        CleanupCreation | RetryRuntimeCleanup | Close | Delete => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::kanban) enum GateMode {
    /// The environment banner and the general "is this card blocked" question.
    Health,
    /// The checks that can disable one workflow action.
    Action(WorkflowAction),
    /// The retirement invariant checklist for a resource mode.
    Retire(RetirementMode),
    /// Why Done retention defers this card.
    Retention,
}

#[derive(Debug, Clone)]
pub(in crate::kanban) struct GateContext {
    pub(in crate::kanban) mode: GateMode,
    pub(in crate::kanban) overrides: RetirementOverride,
    pub(in crate::kanban) runtime_ids: Vec<String>,
}

impl GateContext {
    pub(in crate::kanban) fn health() -> Self {
        Self {
            mode: GateMode::Health,
            overrides: RetirementOverride::default(),
            runtime_ids: Vec::new(),
        }
    }

    pub(in crate::kanban) fn action(action: WorkflowAction) -> Self {
        Self {
            mode: GateMode::Action(action),
            overrides: RetirementOverride::default(),
            runtime_ids: Vec::new(),
        }
    }

    pub(in crate::kanban) fn retire(
        mode: RetirementMode,
        overrides: RetirementOverride,
        runtime_ids: &[String],
    ) -> Self {
        Self {
            mode: GateMode::Retire(mode),
            overrides,
            runtime_ids: runtime_ids.to_vec(),
        }
    }

    pub(in crate::kanban) fn retention(overrides: RetirementOverride) -> Self {
        Self {
            mode: GateMode::Retention,
            overrides,
            runtime_ids: Vec::new(),
        }
    }
}

fn facts(connection: &Connection, card_id: &str) -> Result<GateFacts, String> {
    let row = connection
        .query_row(
            "SELECT c.status,COALESCE(c.completion_outcome,''),c.workflow_revision,c.project_id,
                    e.id,COALESCE(e.revision,0),e.worktree_path,e.branch,e.repository_id,
                    e.target_checkout_path,e.source_revision
             FROM kanban_cards c
             LEFT JOIN card_environments e ON e.card_id=c.id
             WHERE c.id=?1",
            [card_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                ))
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Kanban card was not found".to_string())?;
    let source_revision = row.10;
    Ok(GateFacts {
        status: row.0,
        completion_outcome: Some(row.1).filter(|value| !value.is_empty()),
        workflow_revision: row.2,
        project_id: row.3.clone(),
        environment_id: row.4.clone(),
        environment_revision: row.5,
        worktree_path: row.6,
        branch: row.7,
        repository_id: row.8,
        target_path: row.9.filter(|value| !value.trim().is_empty()),
        has_resources: row.4.is_some(),
        source_revision,
        ..GateFacts::default()
    })
}

/// The one evaluation. Callers never invent their own guard list; a mode only
/// selects which checks apply and how overrides are interpreted.
pub(in crate::kanban) fn evaluate(
    connection: &Connection,
    card_id: &str,
    context: GateContext,
) -> Result<GateVerdict, String> {
    match context.mode {
        GateMode::Health | GateMode::Action(_) => {
            evaluate_health(connection, card_id, &context)
        }
        GateMode::Retire(mode) => evaluate_retirement(connection, card_id, &context, mode),
        GateMode::Retention => evaluate_retention(connection, card_id, &context),
    }
}

fn evaluate_health(
    connection: &Connection,
    card_id: &str,
    context: &GateContext,
) -> Result<GateVerdict, String> {
    let mut verdict = GateVerdict {
        facts: facts(connection, card_id)?,
        ..GateVerdict::new()
    };
    let card = get_card(connection, card_id)?
        .ok_or_else(|| format!("Kanban card {card_id} was not found"))?;
    let cleanup: Option<(String, String, String, i64, bool)> = connection.query_row(
        "SELECT environment_id,status,phase,environment_revision,registration_validated FROM card_cleanup_operations WHERE card_id=?1",
        [card_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get::<_, i64>(4)? != 0)),
    ).optional().map_err(db_error)?;
    if let Some((id, status, phase, revision, validated)) = cleanup {
        let actual = card.environment.as_ref();
        if actual.is_some_and(|env| env.id != id || env.revision != revision) {
            verdict.push_code(BlockerCode::CleanupEnvironmentReplaced);
        } else if actual.is_none() && status != "completed" && !(validated && matches!(phase.as_str(), "remove_metadata" | "record_completion")
            && connection.query_row("SELECT EXISTS(SELECT 1 FROM card_cleanup_phase_outcomes WHERE card_id=?1 AND phase='remove_metadata' AND outcome='success')", [card_id], |r| r.get::<_, i64>(0)).map_err(db_error)? != 0) {
            verdict.push_code(BlockerCode::CleanupEnvironmentMissing);
        } else if actual.is_some() && status == "completed" {
            verdict.push_code(BlockerCode::CleanupEnvironmentRetained);
        }
    }
    let linked_children = repository::has_linked_children(connection, card_id)?;
    if linked_children || (card.provider == "superthread" && card.hierarchy_finalized) {
        let stored_flag: i64 = connection.query_row(
            "SELECT hierarchy_finalized FROM kanban_cards WHERE id=?1", [card_id], |row| row.get(0),
        ).map_err(db_error)?;
        let inconsistent = (card.provider == "superthread" && stored_flag == 0) || card.environment.is_some();
        if inconsistent {
            verdict.push_code(BlockerCode::ParentStateInconsistent);
        }
        return Ok(verdict);
    }
    if !linked_children && card.child_count != 0 {
        verdict.push_code(BlockerCode::StaleParentChildCount);
    }
    if card.hierarchy_finalized {
        // A finalized flag with no linked children is a stale projection, not an
        // aggregate. Report it with the one-click repair instead of hiding it.
        if !linked_children {
            verdict.push_code(BlockerCode::FinalizedParentWithoutChildren);
        }
        return Ok(verdict);
    }
    let pending_target_merge: Option<String> = connection
        .query_row(
            "SELECT phase FROM card_target_merge_operations WHERE card_id=?1",
            [card_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    if let Some(phase) = pending_target_merge {
        let merge_step = if card.status == "approved" {
            GateAction::Merge
        } else {
            GateAction::Approval
        };
        verdict.push(
            BlockerCode::TargetMergePending,
            if phase == "target_conflicted" {
                "The primary target checkout is awaiting reconciliation conflict resolution. Use Merge in target & resolve to resume or recover it."
            } else if phase == "source_conflicted" {
                "The card worktree is awaiting conflict resolution with the pushed target. Use Merge in target & resolve to resume or recover it."
            } else if phase == "source_merged" {
                "A synchronized and pushed target merge is awaiting final verification. Use Merge in target & resolve to resume it."
            } else {
                "Target synchronization is incomplete. Use Merge in target & resolve to resume or recover it."
            },
            merge_step,
        );
    }
    let required_step = match card.status.as_str() {
        "agent_working" => Some(GateAction::Work),
        "needs_human" => Some(GateAction::Approval),
        "approved" => Some(GateAction::Merge),
        _ => None,
    };
    if card.status == CardStatus::Done {
        let (lifecycle_rows, pending_provider_sync): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM card_pi_lifecycle WHERE card_id=?1),
                        (SELECT COUNT(*) FROM provider_sync_operations WHERE card_id=?1 AND state IN ('pending','failed','running'))",
                [card_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(db_error)?;
        if lifecycle_rows > 0 && context.runtime_ids.is_empty() {
            verdict.push_code(BlockerCode::StaleLifecycleProjection);
        }
        if pending_provider_sync > 0 {
            verdict.push_code(BlockerCode::ProviderSyncPending);
        }
    }

    let Some(environment) = card.environment.clone() else {
        if let Some(step) = required_step {
            verdict.push(
                BlockerCode::EnvironmentMissing,
                format!("This card needs a usable environment before {}.", step.as_str()),
                step,
            );
        }
        // Stale lifecycle rows never block an environment that does not exist; the
        // card already reports the actionable missing environment.
        return Ok(verdict);
    };

    let source_step = match card.status.as_str() {
        "needs_human" => GateAction::Approval,
        "approved" => GateAction::Merge,
        "done" => GateAction::Cleanup,
        _ => GateAction::Work,
    };
    let target_step = if card.status == CardStatus::Done {
        GateAction::Cleanup
    } else {
        GateAction::Merge
    };
    if environment.lifecycle_state != EnvironmentLifecycle::Ready {
        verdict.push(
            BlockerCode::EnvironmentNotReady,
            BlockerCode::EnvironmentNotReady.message(),
            source_step,
        );
    }
    let card_project_id = card.project_id.as_deref().unwrap_or_default();
    if environment.project_id.trim().is_empty() {
        verdict.push_code(BlockerCode::ProjectMetadataMissing);
    } else if environment.project_id != card_project_id {
        verdict.push_code(BlockerCode::EnvironmentProjectMismatch);
    }
    let project_path: Option<String> = connection
        .query_row(
            "SELECT path FROM projects WHERE id=?1",
            [card_project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    if project_path.is_none() {
        verdict.push_code(BlockerCode::CardProjectMissing);
    }
    if environment.branch.trim().is_empty() {
        verdict.push_code(BlockerCode::SourceBranchMissing);
    }
    let repository_id = environment
        .repository_id
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    if repository_id.is_none() {
        let step = if card.status == CardStatus::AgentWorking || card.status == CardStatus::NeedsHuman {
            GateAction::Approval
        } else {
            target_step
        };
        verdict.push(
            BlockerCode::RepositoryMetadataMissing,
            BlockerCode::RepositoryMetadataMissing.message(),
            step,
        );
    }
    let target_path = environment
        .target_checkout_path
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    if target_path.is_none() {
        verdict.push_code(BlockerCode::TargetCheckoutMissing);
    }
    let target_branch = environment
        .target_branch
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    if target_branch.is_none() {
        verdict.push_code(BlockerCode::TargetBranchMissing);
    } else if target_branch == Some(environment.branch.as_str()) {
        verdict.push_code(BlockerCode::SourceTargetBranchSame);
    }
    if card.status == CardStatus::Done
        && card.completion_outcome == Some(CompletionOutcome::Merged)
        && environment
            .source_revision
            .as_deref()
            .is_none_or(str::is_empty)
    {
        verdict.push_code(BlockerCode::SourceRevisionMissing);
    }

    if let (Some(project_path), Some(expected_repository)) =
        (project_path.as_deref(), repository_id)
    {
        match repository_identity(project_path) {
            Ok(actual) if actual != expected_repository => {
                verdict.push_code(BlockerCode::ProjectRepositoryMismatch)
            }
            Err(_) => verdict.push_code(BlockerCode::ProjectCheckoutUnavailable),
            _ => {}
        }
    }

    let source_path = environment.worktree_path.as_str();
    let source_canonical = match Path::new(source_path).canonicalize() {
        Ok(path) => Some(path),
        Err(_) if card.status == CardStatus::Done => {
            // A Done card whose worktree is gone is the orphaned-environment case:
            // removing the environment metadata is the repair, not recreating work.
            verdict.push_code(BlockerCode::EnvironmentWorktreeMissing);
            None
        }
        Err(_) => {
            verdict.push(
                BlockerCode::SourceCheckoutUnavailable,
                format!("The source checkout is missing or inaccessible at {source_path}."),
                source_step,
            );
            None
        }
    };
    let mut source_tip = None;
    if let Some(source) = source_canonical.as_ref().and_then(|path| path.to_str()) {
        match repository_identity(source) {
            Ok(actual) if repository_id.is_some_and(|expected| expected != actual) => {
                verdict.push_code(BlockerCode::SourceRepositoryMismatch)
            }
            Err(_) => verdict.push_code(BlockerCode::SourceRepositoryUnavailable),
            _ => {}
        }
        match git_output(source, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
            Ok(branch) if !environment.branch.is_empty() && branch != environment.branch => {
                verdict.push(
                    BlockerCode::SourceBranchMismatch,
                    format!(
                        "The source checkout is on {branch}, expected {}.",
                        environment.branch
                    ),
                    source_step,
                )
            }
            Err(_) => verdict.push(
                BlockerCode::SourceCheckoutDetached,
                BlockerCode::SourceCheckoutDetached.message(),
                source_step,
            ),
            _ => {}
        }
        match has_git_operation(source) {
            Ok(true) => verdict.push(
                BlockerCode::SourceGitOperationInProgress,
                BlockerCode::SourceGitOperationInProgress.message(),
                source_step,
            ),
            Err(_) => verdict.push(
                BlockerCode::SourceGitStateUnavailable,
                BlockerCode::SourceGitStateUnavailable.message(),
                source_step,
            ),
            _ => {}
        }
        match git_output(source, &["rev-parse", "HEAD"]) {
            Ok(revision) => source_tip = Some(revision),
            Err(_) => verdict.push(
                BlockerCode::SourceRevisionUnavailable,
                BlockerCode::SourceRevisionUnavailable.message(),
                source_step,
            ),
        }
    }

    let target_canonical = if let Some(target_path) = target_path {
        match Path::new(target_path).canonicalize() {
            Ok(path) => Some(path),
            Err(_) => {
                verdict.push(
                    BlockerCode::TargetCheckoutUnavailable,
                    format!("The target checkout is missing or inaccessible at {target_path}."),
                    target_step,
                );
                None
            }
        }
    } else {
        None
    };
    if let Some(target) = target_canonical.as_ref().and_then(|path| path.to_str()) {
        match repository_identity(target) {
            Ok(actual) if repository_id.is_some_and(|expected| expected != actual) => {
                verdict.push_code(BlockerCode::TargetRepositoryMismatch)
            }
            Err(_) => verdict.push_code(BlockerCode::TargetRepositoryUnavailable),
            _ => {}
        }
        match git_output(target, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
            Ok(branch) if target_branch.is_some_and(|expected| expected != branch) => {
                verdict.push(
                    BlockerCode::TargetBranchMismatch,
                    format!(
                        "The target checkout is on {branch}, expected {}.",
                        target_branch.unwrap_or_default()
                    ),
                    target_step,
                )
            }
            Err(_) => verdict.push(
                BlockerCode::TargetCheckoutDetached,
                BlockerCode::TargetCheckoutDetached.message(),
                target_step,
            ),
            _ => {}
        }
        match has_git_operation(target) {
            Ok(true) => verdict.push(
                BlockerCode::TargetGitOperationInProgress,
                BlockerCode::TargetGitOperationInProgress.message(),
                target_step,
            ),
            Err(_) => verdict.push(
                BlockerCode::TargetGitStateUnavailable,
                BlockerCode::TargetGitStateUnavailable.message(),
                target_step,
            ),
            _ => {}
        }
    }

    if let (Some(target), Some(source)) = (
        target_canonical.as_ref().and_then(|path| path.to_str()),
        source_canonical.as_ref().and_then(|path| path.to_str()),
    ) {
        let registered = ensure_registered_distinct_worktree(target, source).is_ok();
        if !registered {
            verdict.push_code(BlockerCode::SourceWorktreeNotRegistered);
        }
        if card.status == CardStatus::Done
            && card.completion_outcome == Some(CompletionOutcome::Merged)
            && registered
        {
            if let (Some(recorded), Some(current)) = (
                environment.source_revision.as_deref(),
                source_tip.as_deref(),
            ) {
                if recorded != current {
                    verdict.push_code(BlockerCode::SourceRevisionChanged);
                } else {
                    match git_status_success(target, &["merge-base", "--is-ancestor", current, "HEAD"]) {
                        // Pull requests are merged on the forge, so a primary checkout that has
                        // not been pulled yet still reports the merge as missing. Distinguish
                        // "behind upstream" from "the revision is gone": the first is a pull,
                        // the second is a rewritten history and genuinely needs a human.
                        Ok(false) if target_branch.is_some_and(|branch| {
                            let remote = format!("origin/{branch}");
                            git_status_success(target, &["merge-base", "--is-ancestor", current, &remote]).unwrap_or(false)
                        }) => verdict.push(
                            BlockerCode::TargetCheckoutBehind,
                            format!(
                                "The merged revision is on origin/{}, but the target checkout is behind it; pull {0} before cleaning up.",
                                target_branch.unwrap_or_default()
                            ),
                            GateAction::Cleanup,
                        ),
                        Ok(false) => verdict.push_code(BlockerCode::SourceRevisionNotMerged),
                        Err(_) => verdict.push_code(BlockerCode::AncestryCheckFailed),
                        _ => {}
                    }
                }
            }
        }
    }

    Ok(verdict)
}

fn evaluate_retirement(
    connection: &Connection,
    card_id: &str,
    context: &GateContext,
    mode: RetirementMode,
) -> Result<GateVerdict, String> {
    let mut verdict = GateVerdict {
        facts: facts(connection, card_id)?,
        ..GateVerdict::new()
    };
    let overloads = context.overrides;
    let row = verdict.facts.clone();
    let has_resources = row.environment_id.is_some();
    let linked_children = has_linked_children(connection, card_id)?;
    let mut merged = false;

    if linked_children && !overloads.linked_children_discard {
        verdict.push_code(BlockerCode::LinkedChildren);
    }

    // Environment ownership is immutable and must match the card's project.
    if let Some(environment_project) = connection
        .query_row(
            "SELECT project_id FROM card_environments WHERE card_id=?1",
            [card_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?
    {
        if row.project_id.as_deref() != Some(environment_project.as_str()) {
            verdict.push_code(BlockerCode::InvalidEnvironmentOwnership);
        }
    }

    if mode == RetirementMode::DeleteRecord
        && storage_safety(connection, card_id).is_err()
        && !overloads.linked_children_discard
    {
        verdict.push_code(BlockerCode::SharedStorageKey);
    }

    // Preserve/Remove stop processes themselves; only DeleteRecord and the
    // orphaned-environment repair require them already stopped.
    if !context.runtime_ids.is_empty()
        && mode == RetirementMode::DeleteRecord
        && !overloads.runtime_discard
    {
        verdict.push_code(BlockerCode::RuntimeProcesses);
    }

    let project_path = connection
        .query_row(
            "SELECT path FROM projects WHERE id=?1",
            [row.project_id.as_deref().unwrap_or_default()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();
    let target_path = row.target_path.clone().or(project_path.clone());

    if mode == RetirementMode::RemoveResources {
        if let Some(worktree) = row.worktree_path.as_deref() {
            if Path::new(worktree).exists() {
                let canonical_worktree = Path::new(worktree).canonicalize().ok();
                let canonical_project = project_path
                    .as_deref()
                    .and_then(|value| Path::new(value).canonicalize().ok());
                if canonical_worktree.is_some() && canonical_worktree == canonical_project {
                    verdict.push_code(BlockerCode::PrimaryCheckout);
                } else {
                    if let Some(repository) = row.repository_id.as_deref() {
                        if repository_identity(worktree).ok().as_deref() != Some(repository) {
                            verdict.push_code(BlockerCode::ForeignRepository);
                        }
                    }
                    if let Some(target) = target_path.as_deref() {
                        if ensure_registered_distinct_worktree(target, worktree).is_err()
                            && !overloads.unregistered_discard
                        {
                            verdict.push_code(BlockerCode::SourceWorktreeNotRegistered);
                        }
                    }
                    if git_output(
                        worktree,
                        &["status", "--porcelain=v1", "--untracked-files=all"],
                    )
                    .map(|value| !value.is_empty())
                    .unwrap_or(false)
                        && !overloads.dirty_discard
                    {
                        verdict.push_code(BlockerCode::DirtyWorktree);
                    }
                    if has_git_operation(worktree).unwrap_or(false) && !overloads.dirty_discard {
                        verdict.push_code(BlockerCode::ActiveGitOperation);
                    }
                    if let Some(branch) = row.branch.as_deref().filter(|value| !value.is_empty()) {
                        match git_output(worktree, &["symbolic-ref", "--quiet", "--short", "HEAD"])
                        {
                            Ok(actual) if actual == branch => {}
                            Ok(actual) => verdict.push(
                                BlockerCode::SourceWorktreeNotRegistered,
                                format!("Source worktree is on {actual}, expected {branch}."),
                                GateAction::Cleanup,
                            ),
                            Err(_) => verdict.push(
                                BlockerCode::SourceWorktreeNotRegistered,
                                "Source worktree is detached; restore its recorded branch before cleanup.",
                                GateAction::Cleanup,
                            ),
                        }
                    }
                }
            }
        }

        // Merge proof: ancestry or a merged PR with the exact head revision.
        if has_resources {
            if let (Some(target), Some(revision)) =
                (target_path.as_deref(), row.source_revision.clone())
            {
                let ancestry = git_status_success(
                    target,
                    &["merge-base", "--is-ancestor", &revision, "HEAD"],
                )
                .unwrap_or(false);
                let merged_pr: bool = connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM card_pull_requests WHERE card_id=?1 AND state='merged' AND head_revision=?2)",
                        params![card_id, revision],
                        |r| r.get::<_, i64>(0),
                    )
                    .map_err(db_error)?
                    != 0;
                merged = ancestry || merged_pr;
            }
            if !merged && !overloads.unmerged_discard {
                verdict.push_code(BlockerCode::UnmergedRevision);
            }
        }

        let open_pull_request: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM card_pull_requests WHERE card_id=?1 AND state='open')",
                [card_id],
                |r| r.get::<_, i64>(0),
            )
            .map_err(db_error)?
            != 0;
        if open_pull_request && !overloads.open_pull_request_discard {
            verdict.push_code(BlockerCode::OpenPullRequest);
        }
    }

    // Unresolved provider/delivery/cleanup operations. The cleanup and creation
    // journals ARE the resumable path for RemoveResources, so they are expected.
    if mode != RetirementMode::PreserveResources {
        for operation in operations::in_flight_for_card(connection, card_id)? {
            if operation.kind.is_retirement()
                || operation.kind.is_lifecycle_projection()
                || overloads.unresolved_operation_discard
            {
                continue;
            }
            // Provider synchronization touches the remote card, never local resources.
            if mode == RetirementMode::RemoveResources
                && matches!(
                    operation.kind,
                    OperationKind::Cleanup | OperationKind::Creation | OperationKind::ProviderSync
                )
            {
                continue;
            }
            verdict.push(
                BlockerCode::UnresolvedOperation,
                format!(
                    "An incomplete {} operation must be resumed instead of retiring the card.",
                    operation.kind.as_str()
                ),
                GateAction::Cleanup,
            );
        }
    }

    let overriding_codes = [
        BlockerCode::LinkedChildren,
        BlockerCode::InvalidEnvironmentOwnership,
        BlockerCode::SharedStorageKey,
        BlockerCode::UnresolvedOperation,
        BlockerCode::PrimaryCheckout,
        BlockerCode::ForeignRepository,
    ];
    verdict.facts.merged = merged;
    verdict.facts.has_resources = has_resources;
    verdict.facts.target_path = target_path;
    verdict.facts.override_available = mode == RetirementMode::RemoveResources
        && has_resources
        && !merged
        && verdict
            .blockers
            .iter()
            .all(|blocker| !overriding_codes.contains(&blocker.code));
    Ok(verdict)
}

fn evaluate_retention(
    connection: &Connection,
    card_id: &str,
    context: &GateContext,
) -> Result<GateVerdict, String> {
    let mut verdict = GateVerdict {
        facts: facts(connection, card_id)?,
        ..GateVerdict::new()
    };
    let discard = context.overrides.retention_discard;
    if verdict.facts.status != "done" {
        return Ok(verdict);
    }
    let owns_environment: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM card_environments WHERE card_id=?1)",
            [card_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(db_error)?
        != 0;
    if owns_environment && !discard {
        verdict.push_code(BlockerCode::OwningEnvironment);
    }
    let incomplete_cleanup: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM card_cleanup_operations WHERE card_id=?1 AND status!='completed') OR EXISTS(SELECT 1 FROM card_retirements WHERE card_id=?1)",
            [card_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(db_error)?
        != 0;
    if incomplete_cleanup && !discard {
        verdict.push_code(BlockerCode::IncompleteCleanupOperation);
    }
    let retained_hierarchy: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM kanban_cards WHERE parent_id=?1)",
            [card_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(db_error)?
        != 0;
    if retained_hierarchy && !discard {
        verdict.push_code(BlockerCode::RetainedHierarchy);
    }
    let unresolved: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM environment_creation_operations WHERE card_id=?1)
                OR EXISTS(SELECT 1 FROM card_target_merge_operations WHERE card_id=?1)
                OR EXISTS(SELECT 1 FROM scripted_delivery_operations WHERE card_id=?1)
                OR EXISTS(SELECT 1 FROM provider_sync_operations WHERE card_id=?1 AND state IN ('pending','running','failed'))
                OR EXISTS(SELECT 1 FROM kanban_cards WHERE id=?1 AND delivery_operation_stage IS NOT NULL)
                OR EXISTS(SELECT 1 FROM card_pull_requests WHERE card_id=?1 AND state!='merged')",
            [card_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(db_error)?
        != 0;
    if unresolved && !discard {
        verdict.push_code(BlockerCode::UnresolvedProviderDeliveryOperation);
        if connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM provider_sync_operations WHERE card_id=?1 AND state IN ('pending','failed'))",
                [card_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(db_error)?
            != 0
        {
            verdict.push_code(BlockerCode::ProviderSyncPending);
        }
    }
    Ok(verdict)
}

/// The mutation-boundary check. It reads the same verdict as the banner, so a
/// disabled action and the banner can never disagree. Unmapped actions (close,
/// request-changes, refinement) stay available: a broken environment must not remove
/// the escape hatch.
pub(in crate::kanban) fn enforce_action(
    connection: &Connection,
    card_id: &str,
    action: WorkflowAction,
) -> Result<(), String> {
    if gate_steps_for_action(action).is_none() {
        return Ok(());
    }
    let verdict = evaluate(connection, card_id, GateContext::action(action))?;
    verdict
        .blocker_for(action)
        .map(|blocker| blocker.message.clone())
        .map_or(Ok(()), Err)
}

/// Health's response, from the gate. Kept here so the banner cannot grow a second
/// checklist again.
pub(in crate::kanban) fn environment_health(
    connection: &Connection,
    card_id: &str,
) -> Result<CardEnvironmentHealth, String> {
    let verdict = evaluate(connection, card_id, GateContext::health())?;
    Ok(verdict.issues(card_id))
}

pub(in crate::kanban) struct RepairContext {
    pub(in crate::kanban) runtime_ids: Vec<String>,
}

impl RepairContext {
    pub(in crate::kanban) fn with_runtime_ids(runtime_ids: Vec<String>) -> Self {
        Self { runtime_ids }
    }
}

/// Apply one automatic repair. Needs-user repairs are instructions, not silent
/// mutations, and return their label/effect instead of doing anything.
pub(in crate::kanban) fn apply_repair(
    card_id: &str,
    repair_id: &str,
    context: &RepairContext,
) -> Result<GateVerdict, String> {
    let id = RepairId::from_str(repair_id)
        .ok_or_else(|| format!("Unknown card repair {repair_id:?}"))?;
    match id.kind() {
        RepairKind::NeedsUser => {
            return Err(format!(
                "{} needs you: {}",
                id.label(),
                id.effect()
            ))
        }
        RepairKind::Automatic => {}
    }
    match id {
        RepairId::RepairParentMetadata => {
            with_board_mutation(super::hygiene::repair_stale_parent_metadata)?;
        }
        RepairId::ClearStaleLifecycle => {
            if !context.runtime_ids.clone().is_empty() {
                return Err(
                    "A Pi session is still running for this card; stop it before clearing the lifecycle projection."
                        .to_string(),
                );
            }
            with_board_mutation(|connection| {
                let removed = connection
                    .execute("DELETE FROM card_pi_lifecycle WHERE card_id=?1", [card_id])
                    .map_err(db_error)?;
                if removed > 0 {
                    connection
                        .execute(
                            "UPDATE kanban_cards SET workflow_revision=workflow_revision+1,updated_at=?1 WHERE id=?2",
                            params![unix_timestamp(), card_id],
                        )
                        .map_err(db_error)?;
                    connection
                        .execute(
                            "INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,summary)
                             VALUES (?1,?2,'user','clear_stale_lifecycle','success',?3)",
                            params![
                                card_id,
                                unix_timestamp(),
                                format!("Cleared {removed} stale Pi lifecycle projection(s)")
                            ],
                        )
                        .map_err(db_error)?;
                }
                Ok(())
            })?;
        }
        RepairId::CleanupOrphanedEnvironment => {
            let facts = with_read_connection(|connection| facts(connection, card_id))?;
            let (Some(environment_id), true) = (facts.environment_id, facts.has_resources) else {
                return Err("This card no longer owns an environment; refresh board health.".into());
            };
            let outcome = super::retirement::retire(
                super::retirement::RetirementRequest::RemoveOrphanedEnvironment {
                    card_id: card_id.to_string(),
                    environment_id,
                    expected_environment_revision: facts.environment_revision,
                    confirmed: true,
                },
                super::retirement::RetirementContext::none(),
            )?;
            if !matches!(
                outcome,
                super::retirement::RetirementOutcome::RemovedResources
            ) {
                return Err("Orphaned environment cleanup did not run".to_string());
            }
        }
        RepairId::PullTargetCheckout => {
            with_board_mutation(|connection| pull_target_checkout(connection, card_id))?;
        }
        RepairId::RetryProviderSync => {
            return Err(
                "Retry provider sync is dispatched by the repair command, not applied here."
                    .to_string(),
            )
        }
        _ => return Err(format!("{} cannot be applied automatically", id.label())),
    }
    with_read_connection(|connection| evaluate(connection, card_id, GateContext::health()))
}

pub(in crate::kanban) fn pull_target_checkout(
    connection: &Connection,
    card_id: &str,
) -> Result<(), String> {
    let (target_path, target_branch, source) = connection
        .query_row(
            "SELECT COALESCE(e.target_checkout_path,p.path),COALESCE(e.target_branch,p.target_branch,'main'),e.worktree_path
             FROM kanban_cards c JOIN projects p ON p.id=c.project_id
             LEFT JOIN card_environments e ON e.card_id=c.id WHERE c.id=?1",
            [card_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .map_err(db_error)?;
    let dirty = git_output(&target_path, &["status", "--porcelain=v1", "--untracked-files=all"])
        .map(|value| !value.is_empty())
        .unwrap_or(true);
    if dirty {
        return Err(format!(
            "The target checkout at {target_path} has local changes; commit, stash or discard them, then pull {target_branch}."
        ));
    }
    let current = git_output(&target_path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map_err(|error| format!("The target checkout is detached or unreadable: {error}"))?;
    if current != target_branch {
        return Err(format!(
            "The target checkout is on {current}, expected {target_branch}. Check out {target_branch} before pulling."
        ));
    }
    let remote = format!("origin/{target_branch}");
    let ancestor = git_status_success(
        &target_path,
        &["merge-base", "--is-ancestor", &remote, "HEAD"],
    )?;
    if ancestor {
        return Ok(());
    }
    let fast_forward = git_status_success(
        &target_path,
        &["merge-base", "--is-ancestor", "HEAD", &remote],
    )?;
    if !fast_forward {
        return Err(format!(
            "The target checkout and {remote} have diverged; reconcile them by hand before cleanup."
        ));
    }
    git_output(
        &target_path,
        &["merge", "--ff-only", &remote],
    )
    .map_err(|error| format!("Could not fast-forward the target checkout: {error}"))?;
    let summary = match source.as_deref() {
        Some(source) => format!(
            "Pulled {remote} into the target checkout while cleaning up {source}"
        ),
        None => format!("Pulled {remote} into the target checkout"),
    };
    connection
        .execute(
            "INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,summary)
             VALUES (?1,?2,'user','pull_target_checkout','success',?3)",
            params![card_id, unix_timestamp(), summary],
        )
        .map(|_| ())
        .map_err(db_error)
}

#[cfg(test)]
#[path = "gate_tests.rs"]
mod tests;
