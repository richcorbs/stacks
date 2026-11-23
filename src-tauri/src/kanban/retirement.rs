//! One retirement path for cards (card #341).
//!
//! A card used to be ended by seven commands, each with its own invariants, guards
//! and resume loop. This module owns the decision and the durable intent:
//!
//! ```text
//! PreserveResources  stop processes, keep the worktree and branch
//! RemoveResources    stop processes, remove worktree and branch, keep the record
//! DeleteRecord       remove the local record after resources are gone
//! ```
//!
//! The invariant checklist below is the single answer to "is it safe to retire this
//! card?" and uses the exact blocker strings the UI already surfaces. Execution still
//! delegates to the feature machinery whose behaviour is covered by the existing
//! tests (close/runtime cleanup, the cleanup phase journal, creation compensation,
//! the Done-retention journal and local deletion), but those are implementation
//! details now: every caller enters through [`retire`].
//!
//! Every retirement writes a `retire_<mode>` row into the unified operations journal
//! (card #340). An interruption therefore leaves a reportable in-flight operation and
//! the next call resumes the same idempotent machinery instead of inventing a second
//! path.

use super::health::{db_error, unix_timestamp};
use super::*;
#[allow(unused_imports)]
use super::{
    cards::*, cleanup::*, domain::*, done_retention::*, environment::*, git_effects::*,
    hygiene::*, local_delivery::*, operations::*, repository::*, sync::*, workflow::*,
};
use rusqlite::{params, Connection, OptionalExtension};

/// Canonical blocker strings. These are the reasons the UI already shows; defining
/// them once is the point of the single checklist.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::kanban) enum RetirementMode {
    PreserveResources,
    RemoveResources,
    DeleteRecord,
}

impl RetirementMode {
    pub(in crate::kanban) fn as_str(self) -> &'static str {
        match self {
            RetirementMode::PreserveResources => "preserve_resources",
            RetirementMode::RemoveResources => "remove_resources",
            RetirementMode::DeleteRecord => "delete_record",
        }
    }

    pub(in crate::kanban) fn operation_kind(self) -> OperationKind {
        match self {
            RetirementMode::PreserveResources => OperationKind::RetirePreserve,
            RetirementMode::RemoveResources => OperationKind::RetireRemove,
            RetirementMode::DeleteRecord => OperationKind::RetireDelete,
        }
    }
}

/// Explicit permission to bypass a check. Retention is the documented global discard
/// and passes [`RetirementOverride::discard`]; ordinary UI flows only pass the narrow
/// overrides whose availability the checklist reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(in crate::kanban) struct RetirementOverride {
    pub unmerged_discard: bool,
    pub dirty_discard: bool,
    pub unregistered_discard: bool,
    pub open_pull_request_discard: bool,
    pub linked_children_discard: bool,
    pub unresolved_operation_discard: bool,
    pub runtime_discard: bool,
}

impl RetirementOverride {
    /// Ordinary "clean up with an explicit override" checkbox.
    pub(in crate::kanban) fn explicit(unmerged: bool) -> Self {
        Self {
            // A checked override already permits a dirty or unregistered worktree in
            // the existing cleanup UI; keep that behavioural contract.
            unmerged_discard: unmerged,
            dirty_discard: unmerged,
            unregistered_discard: unmerged,
            ..Self::default()
        }
    }

    /// The explicit global Done-retention discard. Every blocker is a deliberate
    /// exclusion rather than an accidental one.
    pub(in crate::kanban) fn discard() -> Self {
        Self {
            unmerged_discard: true,
            dirty_discard: true,
            unregistered_discard: true,
            open_pull_request_discard: true,
            linked_children_discard: true,
            unresolved_operation_discard: true,
            runtime_discard: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(in crate::kanban) struct RetirementBlocker {
    pub code: &'static str,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(in crate::kanban) struct RetirementChecklist {
    pub card_id: String,
    pub mode: RetirementMode,
    pub status: String,
    pub completion_outcome: Option<String>,
    pub workflow_revision: i64,
    pub project_id: Option<String>,
    pub environment_id: Option<String>,
    pub environment_revision: i64,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub repository_id: Option<String>,
    pub target_path: Option<String>,
    pub source_revision: Option<String>,
    pub merged: bool,
    pub has_resources: bool,
    pub override_available: bool,
    pub blockers: Vec<RetirementBlocker>,
}

impl RetirementChecklist {
    pub(in crate::kanban) fn blocked(&self) -> bool {
        !self.blockers.is_empty()
    }

    pub(in crate::kanban) fn first_reason(&self) -> Option<String> {
        self.blockers
            .first()
            .map(|blocker| blocker.reason.clone())
    }
}

#[derive(Debug, Clone)]
struct RetirementCardRow {
    status: String,
    completion_outcome: Option<String>,
    workflow_revision: i64,
    project_id: Option<String>,
    project_path: Option<String>,
    environment_id: Option<String>,
    environment_project_id: Option<String>,
    environment_revision: i64,
    worktree_path: Option<String>,
    branch: Option<String>,
    repository_id: Option<String>,
    target_checkout_path: Option<String>,
    source_revision: Option<String>,
}

fn card_row(connection: &Connection, card_id: &str) -> Result<Option<RetirementCardRow>, String> {
    connection
        .query_row(
            "SELECT c.status,c.completion_outcome,c.workflow_revision,c.project_id,
                    p.path,
                    e.id,e.project_id,COALESCE(e.revision,0),
                    e.worktree_path,e.branch,e.repository_id,
                    e.target_checkout_path,e.source_revision
             FROM kanban_cards c
             LEFT JOIN projects p ON p.id=c.project_id
             LEFT JOIN card_environments e ON e.card_id=c.id
             WHERE c.id=?1",
            [card_id],
            |row| {
                Ok(RetirementCardRow {
                    status: row.get(0)?,
                    completion_outcome: row.get(1)?,
                    workflow_revision: row.get(2)?,
                    project_id: row.get(3)?,
                    project_path: row.get(4)?,
                    environment_id: row.get(5)?,
                    environment_project_id: row.get(6)?,
                    environment_revision: row.get(7)?,
                    worktree_path: row.get(8)?,
                    branch: row.get(9)?,
                    repository_id: row.get(10)?,
                    target_checkout_path: row.get(11)?,
                    source_revision: row.get(12)?,
                })
            },
        )
        .optional()
        .map_err(db_error)
}

fn push_blocker(
    blockers: &mut Vec<RetirementBlocker>,
    code: &'static str,
    reason: impl Into<String>,
) {
    let reason = reason.into();
    if blockers.iter().any(|blocker| blocker.reason == reason) {
        return;
    }
    blockers.push(RetirementBlocker { code, reason });
}

/// The one invariant checklist, evaluated in a fixed order. Callers never invent
/// their own guard list; a mode only decides which checks apply and which overrides
/// are authorised.
pub(in crate::kanban) fn evaluate(
    connection: &Connection,
    card_id: &str,
    mode: RetirementMode,
    overrides: RetirementOverride,
    runtime_ids: &[String],
) -> Result<RetirementChecklist, String> {
    let row = card_row(connection, card_id)?
        .ok_or_else(|| "Kanban card was not found".to_string())?;
    let has_resources = row.environment_id.is_some();
    let linked_children = has_linked_children(connection, card_id)?;
    let mut blockers = Vec::new();

    // 1. Linked children: an aggregate is not a leaf retirement unit.
    if linked_children && !overrides.linked_children_discard {
        push_blocker(&mut blockers, LINKED_CHILDREN, LINKED_CHILDREN);
    }

    // 2. Environment ownership is immutable and must match the card's project.
    if let Some(environment_project) = row.environment_project_id.as_deref() {
        if row.project_id.as_deref() != Some(environment_project) {
            push_blocker(
                &mut blockers,
                INVALID_ENVIRONMENT_OWNERSHIP,
                INVALID_ENVIRONMENT_OWNERSHIP,
            );
        }
    }

    // 3. Shared storage identity (only relevant once the record is removed).
    if mode == RetirementMode::DeleteRecord
        && storage_safety(connection, card_id).is_err()
        && !overrides.linked_children_discard
    {
        push_blocker(&mut blockers, SHARED_STORAGE_KEY, SHARED_STORAGE_KEY);
    }

    // 4. Runtime processes. Preserve/Remove stop them themselves; only DeleteRecord
    //    and the orphaned-environment repair require them already stopped.
    if !runtime_ids.is_empty()
        && mode == RetirementMode::DeleteRecord
        && !overrides.runtime_discard
    {
        push_blocker(&mut blockers, RUNTIME_PROCESSES, RUNTIME_PROCESSES);
    }

    let project_path = row.project_path.clone();
    let target_path = row
        .target_checkout_path
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| project_path.clone());
    let mut merged = false;

    if mode == RetirementMode::RemoveResources {
        // 5. The worktree must be registered, clean, on its recorded branch, and
        //    owned by the configured repository before anything is removed.
        // 6. A missing registered worktree alone is not a blocker: branch and
        //    metadata may still be reconcilable (orphaned tombstones).
        if let Some(worktree) = row.worktree_path.as_deref() {
            if Path::new(worktree).exists() {
                let canonical_worktree = Path::new(worktree).canonicalize().ok();
                let canonical_project = project_path
                    .as_deref()
                    .and_then(|value| Path::new(value).canonicalize().ok());
                if canonical_worktree.is_some() && canonical_worktree == canonical_project {
                    push_blocker(&mut blockers, PRIMARY_CHECKOUT, PRIMARY_CHECKOUT);
                } else {
                    if let Some(repository) = row.repository_id.as_deref() {
                        if repository_identity(worktree).ok().as_deref() != Some(repository) {
                            push_blocker(&mut blockers, FOREIGN_REPOSITORY, FOREIGN_REPOSITORY);
                        }
                    }
                    if let Some(target) = target_path.as_deref() {
                        if ensure_registered_distinct_worktree(target, worktree).is_err()
                            && !overrides.unregistered_discard
                        {
                            push_blocker(
                                &mut blockers,
                                UNREGISTERED_WORKTREE,
                                UNREGISTERED_WORKTREE,
                            );
                        }
                    }
                    if git_output(
                        worktree,
                        &["status", "--porcelain=v1", "--untracked-files=all"],
                    )
                    .map(|value| !value.is_empty())
                    .unwrap_or(false)
                        && !overrides.dirty_discard
                    {
                        push_blocker(&mut blockers, DIRTY_WORKTREE, DIRTY_WORKTREE);
                    }
                    if has_git_operation(worktree).unwrap_or(false) && !overrides.dirty_discard {
                        push_blocker(
                            &mut blockers,
                            ACTIVE_GIT_OPERATION,
                            ACTIVE_GIT_OPERATION,
                        );
                    }
                    if let Some(branch) = row.branch.as_deref().filter(|value| !value.is_empty()) {
                        match git_output(worktree, &["symbolic-ref", "--quiet", "--short", "HEAD"])
                        {
                            Ok(actual) if actual == branch => {}
                            Ok(actual) => push_blocker(
                                &mut blockers,
                                UNREGISTERED_WORKTREE,
                                format!("Source worktree is on {actual}, expected {branch}."),
                            ),
                            Err(_) => push_blocker(
                                &mut blockers,
                                UNREGISTERED_WORKTREE,
                                "Source worktree is detached; restore its recorded branch before cleanup.",
                            ),
                        }
                    }
                }
            }
        }

        // 7. Merge proof (ancestry or a merged PR with the exact head revision).
        if has_resources {
            let revision = row.source_revision.clone();
            if let (Some(target), Some(revision)) = (target_path.as_deref(), revision) {
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
            if !merged && !overrides.unmerged_discard {
                push_blocker(&mut blockers, UNMERGED_REVISION, UNMERGED_REVISION);
            }
        }

        // 8. An open pull request is unresolved delivery, not disposable work.
        let open_pull_request: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM card_pull_requests WHERE card_id=?1 AND state='open')",
                [card_id],
                |r| r.get::<_, i64>(0),
            )
            .map_err(db_error)?
            != 0;
        if open_pull_request && !overrides.open_pull_request_discard {
            push_blocker(&mut blockers, OPEN_PULL_REQUEST, OPEN_PULL_REQUEST);
        }
    }

    // 9. Unresolved provider/delivery/cleanup operations. The cleanup and creation
    //    journals ARE the resumable path for RemoveResources, so they are expected.
    //    Preserving resources does not depend on them; closing was always allowed.
    if mode != RetirementMode::PreserveResources {
        for operation in operations::in_flight_for_card(connection, card_id)? {
            if operation.kind.is_retirement()
                || operation.kind.is_lifecycle_projection()
                || overrides.unresolved_operation_discard
            {
                continue;
            }
            if mode == RetirementMode::RemoveResources
                && matches!(operation.kind, OperationKind::Cleanup | OperationKind::Creation)
            {
                continue;
            }
            push_blocker(
                &mut blockers,
                UNRESOLVED_OPERATION,
                format!(
                    "An incomplete {} operation must be resumed instead of retiring the card.",
                    operation.kind.as_str()
                ),
            );
        }
    }

    let override_available = mode == RetirementMode::RemoveResources
        && has_resources
        && !merged
        && blockers.iter().all(|blocker| {
            !matches!(
                blocker.code,
                LINKED_CHILDREN
                    | INVALID_ENVIRONMENT_OWNERSHIP
                    | SHARED_STORAGE_KEY
                    | UNRESOLVED_OPERATION
                    | PRIMARY_CHECKOUT
                    | FOREIGN_REPOSITORY
            )
        });

    Ok(RetirementChecklist {
        card_id: card_id.to_string(),
        mode,
        status: row.status,
        completion_outcome: row.completion_outcome,
        workflow_revision: row.workflow_revision,
        project_id: row.project_id,
        environment_id: row.environment_id,
        environment_revision: row.environment_revision,
        worktree_path: row.worktree_path,
        branch: row.branch,
        repository_id: row.repository_id,
        target_path,
        source_revision: row.source_revision,
        merged,
        has_resources,
        override_available,
        blockers,
    })
}

/// Preserve unmerged work before a destructive override. A Git bundle written under
/// the app data directory is the recovery evidence; "we removed it" stays reversible.
pub(in crate::kanban) fn preserve_evidence(
    checklist: &RetirementChecklist,
) -> Result<Option<String>, String> {
    let Some(branch) = checklist
        .branch
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(None);
    };
    let Some(target) = checklist.target_path.as_deref() else {
        return Ok(None);
    };
    if local_ref_tip(target, branch)?.is_none() {
        // The branch is already gone: there is no unmerged work left to preserve.
        return Ok(None);
    }
    let directory = app_data_dir()?.join("retirement-evidence");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the retirement evidence directory: {error}"))?;
    let safe_branch = branch
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let path = directory.join(format!(
        "{}-{safe_branch}.bundle",
        safe_card_key(&checklist.card_id)
    ));
    let path_text = path.to_string_lossy().to_string();
    if path.exists() {
        fs::remove_file(&path).map_err(|error| {
            format!("Could not replace the previous retirement evidence bundle: {error}")
        })?;
    }
    let reference = format!("refs/heads/{branch}");
    let output = Command::new("git")
        .args([
            "-C",
            target,
            "bundle",
            "create",
            &path_text,
            &reference,
        ])
        .output()
        .map_err(|error| format!("Could not write retirement evidence: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Could not preserve unmerged work before retirement: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(Some(path_text))
}

fn record_evidence_event(card_id: &str, path: &str) -> Result<(), String> {
    with_board_mutation(|connection| {
        connection
            .execute(
                "INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,summary)
                 VALUES (?1,?2,'user','retirement_evidence','success',?3)",
                params![
                    card_id,
                    unix_timestamp(),
                    format!("Unmerged work preserved as a Git bundle at {path}")
                ],
            )
            .map(|_| ())
            .map_err(db_error)
    })
}

#[derive(Debug)]
pub(in crate::kanban) enum RetirementOutcome {
    Preserved(CardRuntimeCleanupResult),
    Removed(KanbanCard),
    RemovedResources,
    Deleted(BoardChange),
    Nothing,
}

pub(in crate::kanban) struct RetirementContext<'a> {
    pub pty: Option<&'a Mutex<PtyRegistry>>,
    pub pi: Option<&'a Mutex<PiRpcRegistry>>,
    pub setup: Option<&'a crate::workspace_setup::WorkspaceSetupState>,
}

impl<'a> RetirementContext<'a> {
    pub(in crate::kanban) fn none() -> Self {
        Self {
            pty: None,
            pi: None,
            setup: None,
        }
    }

    fn pty(&self) -> Result<&Mutex<PtyRegistry>, String> {
        self.pty
            .ok_or_else(|| "Retirement requires the terminal registry".to_string())
    }

    fn pi(&self) -> Result<&Mutex<PiRpcRegistry>, String> {
        self.pi
            .ok_or_else(|| "Retirement requires the Pi session registry".to_string())
    }
}

pub(in crate::kanban) enum RetirementRequest {
    Preserve {
        card_id: String,
        expected_revision: Option<i64>,
    },
    RemoveEnvironment {
        card_id: String,
        expected_workflow_revision: i64,
        expected_environment_revision: i64,
        expected_source_revision: Option<String>,
        expected_target_revision: Option<String>,
        expected_repository_id: Option<String>,
        expected_primary_checkout: Option<String>,
        expected_target_branch: Option<String>,
        override_authorized: bool,
    },
    RemoveCreation {
        card_id: String,
    },
    RemoveOrphanedEnvironment {
        card_id: String,
        environment_id: String,
        expected_environment_revision: i64,
        confirmed: bool,
    },
    /// Done retention: remove resources under the global discard authorization.
    DiscardResources(DoneCleanupCandidate),
    /// Done retention: remove the local record and purge its files.
    DiscardRecord(DoneCleanupCandidate),
    DeleteRecord {
        card_id: String,
    },
}

impl RetirementRequest {
    pub(in crate::kanban) fn card_id(&self) -> &str {
        match self {
            RetirementRequest::Preserve { card_id, .. }
            | RetirementRequest::RemoveEnvironment { card_id, .. }
            | RetirementRequest::RemoveCreation { card_id }
            | RetirementRequest::RemoveOrphanedEnvironment { card_id, .. }
            | RetirementRequest::DeleteRecord { card_id } => card_id,
            RetirementRequest::DiscardResources(candidate)
            | RetirementRequest::DiscardRecord(candidate) => &candidate.id,
        }
    }

    pub(in crate::kanban) fn mode(&self) -> RetirementMode {
        match self {
            RetirementRequest::Preserve { .. } => RetirementMode::PreserveResources,
            RetirementRequest::RemoveEnvironment { .. }
            | RetirementRequest::RemoveCreation { .. }
            | RetirementRequest::RemoveOrphanedEnvironment { .. }
            | RetirementRequest::DiscardResources(_) => RetirementMode::RemoveResources,
            RetirementRequest::DiscardRecord(_) | RetirementRequest::DeleteRecord { .. } => {
                RetirementMode::DeleteRecord
            }
        }
    }

    fn overrides(&self) -> RetirementOverride {
        match self {
            RetirementRequest::RemoveEnvironment {
                override_authorized, ..
            } => RetirementOverride::explicit(*override_authorized),
            RetirementRequest::DiscardResources(_) | RetirementRequest::DiscardRecord(_) => {
                RetirementOverride::discard()
            }
            _ => RetirementOverride::default(),
        }
    }
}

fn runtime_ids_for(context: &RetirementContext<'_>, card_id: &str) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(pty) = context.pty {
        if let Ok(mut values) = crate::pty::card_pty_runtime_ids(pty, card_id) {
            ids.append(&mut values);
        }
    }
    if let Some(pi) = context.pi {
        if let Ok(mut values) = crate::pi_rpc::card_pi_runtime_ids(pi, card_id) {
            ids.append(&mut values);
        }
    }
    ids
}

/// The single entry point. Journal the intent, evaluate the invariant checklist once,
/// then apply the mode. A second call with an interrupted operation resumes it.
pub(in crate::kanban) fn retire(
    request: RetirementRequest,
    context: RetirementContext<'_>,
) -> Result<RetirementOutcome, String> {
    let card_id = request.card_id().to_string();
    let mode = request.mode();
    let overrides = request.overrides();
    let runtime_ids = runtime_ids_for(&context, &card_id);

    // Policy evaluation happens before the journal so a refusal is an ordinary error,
    // not an in-flight retirement. The orphaned-environment repair validates against
    // its existing cleanup/retention journals instead.
    let compares_checklist = !matches!(
        request,
        RetirementRequest::RemoveCreation { .. } | RetirementRequest::RemoveOrphanedEnvironment { .. }
    );
    let checklist = if compares_checklist {
        with_read_connection(|connection| {
            evaluate(connection, &card_id, mode, overrides, &runtime_ids)
        })?
    } else {
        with_read_connection(|connection| {
            evaluate(
                connection,
                &card_id,
                mode,
                RetirementOverride::discard(),
                &runtime_ids,
            )
        })?
    };
    if mode != RetirementMode::PreserveResources && checklist.blocked() {
        let override_ok = matches!(
            request,
            RetirementRequest::RemoveEnvironment {
                override_authorized: true,
                ..
            }
        ) && checklist.override_available;
        if !override_ok {
            return Err(checklist
                .first_reason()
                .unwrap_or_else(|| "Card retirement is blocked".to_string()));
        }
    }

    let operation_kind = mode.operation_kind();
    let payload = OperationPayload::Retirement(RetirementPayload {
        card_id: card_id.clone(),
        mode: mode.as_str().to_string(),
        workflow_revision: checklist.workflow_revision,
        override_authorized: overrides.unmerged_discard,
        evidence_path: None,
    });
    let operation_id = with_board_mutation(|connection| {
        operations::begin(connection, operation_kind, &card_id, "execute", &payload)
    })?;

    let result = apply(request, &checklist, &context);

    match &result {
        Ok(_) => {
            let _ = with_board_mutation(|connection| {
                operations::complete(connection, &operation_id, "execute")
            });
        }
        Err(error) => {
            let _ = with_board_mutation(|connection| {
                operations::record_failure(
                    connection,
                    &operation_id,
                    "execute",
                    "retirement_failed",
                    error,
                )
            });
        }
    }
    result
}

fn apply(
    request: RetirementRequest,
    checklist: &RetirementChecklist,
    context: &RetirementContext<'_>,
) -> Result<RetirementOutcome, String> {
    match request {
        RetirementRequest::Preserve {
            card_id,
            expected_revision,
        } => preserve(&card_id, expected_revision, context).map(RetirementOutcome::Preserved),
        RetirementRequest::RemoveEnvironment {
            card_id,
            expected_workflow_revision,
            expected_environment_revision,
            expected_source_revision,
            expected_target_revision,
            expected_repository_id,
            expected_primary_checkout,
            expected_target_branch,
            override_authorized,
        } => {
            // Repository identity must match what the user inspected, exactly as the
            // seven former commands each checked. The checklist already ran, so a
            // changed repository is a conflict rather than a new policy decision.
            let contract = cleanup_preflight(&card_id, context.pty()?, context.pi()?)?;
            if contract.source_revision != expected_source_revision
                || contract.target_revision != expected_target_revision
                || contract.repository_id != expected_repository_id
                || contract.primary_checkout != expected_primary_checkout
                || contract.current_target_branch != expected_target_branch
            {
                return Err(
                    "Repository state changed after cleanup preflight; inspect it again".into(),
                );
            }
            let evidence = if override_authorized && !checklist.merged {
                preserve_evidence(checklist)?
            } else {
                None
            };
            if let Some(path) = evidence.as_deref() {
                record_evidence_event(&card_id, path)?;
            }
            let card = run_cleanup(
                &card_id,
                expected_workflow_revision,
                expected_environment_revision,
                expected_source_revision.as_deref().unwrap_or_default(),
                override_authorized,
                evidence.as_deref(),
                context.pty()?,
                context.pi()?,
            )?;
            Ok(RetirementOutcome::Removed(card))
        }
        RetirementRequest::RemoveCreation { card_id } => {
            remove_creation(&card_id).map(RetirementOutcome::Removed)
        }
        RetirementRequest::RemoveOrphanedEnvironment {
            card_id,
            environment_id,
            expected_environment_revision,
            confirmed,
        } => with_board_mutation(|connection| {
            remove_orphaned_environment_in(
                connection,
                &card_id,
                &environment_id,
                expected_environment_revision,
                confirmed,
            )
        })
        .map(|_| RetirementOutcome::RemovedResources),
        RetirementRequest::DiscardResources(candidate) => {
            let setup = context
                .setup
                .ok_or_else(|| "Retention requires supervised setup state".to_string())?;
            done_retention::retire_resources(candidate, context.pi()?, context.pty()?, setup)
                .map(|()| RetirementOutcome::RemovedResources)
        }
        RetirementRequest::DiscardRecord(candidate) => {
            let setup = context
                .setup
                .ok_or_else(|| "Retention requires supervised setup state".to_string())?;
            done_retention::retire_record(candidate, context.pi()?, context.pty()?, setup)
                .map(|_| RetirementOutcome::Nothing)
        }
        RetirementRequest::DeleteRecord { card_id } => {
            delete_record(&card_id).map(RetirementOutcome::Deleted)
        }
    }
}

fn preserve(
    card_id: &str,
    expected_revision: Option<i64>,
    context: &RetirementContext<'_>,
) -> Result<CardRuntimeCleanupResult, String> {
    let pi = context.pi()?;
    let pty = context.pty()?;
    let retry = with_read_connection(|connection| {
        let status = connection
            .query_row(
                "SELECT status,runtime_cleanup_status FROM kanban_cards WHERE id=?1",
                [card_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map_err(db_error)?;
        Ok::<_, String>(match status {
            None => return Err("Kanban card was not found".to_string()),
            Some((status, runtime)) => {
                status == "done" && matches!(runtime.as_deref(), Some("pending" | "failed"))
            }
        })
    })?;
    let targets = if retry {
        with_board_mutation(|connection| {
            require_structural_capability(connection, card_id, WorkflowAction::RetryRuntimeCleanup)?;
            persisted_runtime_targets(connection, card_id)
        })?
    } else {
        let expected_revision =
            expected_revision.ok_or_else(|| "Card revision is required to close".to_string())?;
        with_board_mutation(|connection| {
            commit_card_close(connection, card_id, expected_revision)
        })?
    };
    finish_runtime_cleanup(card_id, targets, pi, pty)
}

fn remove_creation(card_id: &str) -> Result<KanbanCard, String> {
    coordinate_card_repository(card_id, false, || {
        let mut op = with_read_connection(|connection| {
            require_structural_capability(connection, card_id, WorkflowAction::CleanupCreation)?;
            load_creation_operation_row(connection, card_id)
        })?
        .ok_or_else(|| "No environment creation recovery is pending".to_string())?;
        if op.source_path.is_none() {
            // A failed setup may have created resources before recording its result.
            // Prove ownership once so cleanup targets exactly what it created.
            op = persist_validated_source(&op, None)?;
        }
        if !op.source_worktree_new {
            return Err(
                "Cleanup is unavailable because ownership of the source worktree is not proven"
                    .to_string(),
            );
        }
        update_creation_phase(
            card_id,
            "compensation_pending",
            op.source_path
                .as_ref()
                .map(|_| "User requested recovery cleanup"),
            true,
        )?;
        compensate_creation(&op)
    })
}

fn delete_record(card_id: &str) -> Result<BoardChange, String> {
    with_board_mutation(|connection| {
        if !validate_card_deletion(connection, card_id)? {
            return Ok(());
        }
        let directory = card_directory(card_id)?;
        if directory.exists() {
            fs::remove_dir_all(&directory)
                .map_err(|error| format!("Could not remove card directory: {error}"))?;
        }
        let transaction = connection.savepoint().map_err(db_error)?;
        transaction
            .execute("DELETE FROM kanban_cards WHERE id = ?1", [card_id])
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)
    })?;
    with_read_connection(|connection| {
        Ok(BoardChange {
            upserts: Vec::new(),
            removed_ids: vec![card_id.to_string()],
            detail_invalidated_ids: Vec::new(),
            board_revision: board_revision(connection)?,
        })
    })
}

/// Repair for the orphaned-environment finding. Detection stays in `hygiene.rs`; the
/// repair itself is the same RemoveResources operation every other caller uses.
pub(in crate::kanban) fn remove_orphaned_environment_in(
    connection: &mut Connection,
    card_id: &str,
    environment_id: &str,
    expected_environment_revision: i64,
    confirmed: bool,
) -> Result<(), String> {
    if !confirmed {
        return Err("Explicit confirmation is required before cleaning up an environment".into());
    }
    let row = environment_rows(connection)?
        .into_iter()
        .find(|row| row.card_id == card_id && row.id == environment_id)
        .ok_or_else(|| "The environment is already gone; refresh board health.".to_string())?;
    if row.revision != expected_environment_revision {
        return Err("The environment changed after inspection; refresh board health.".into());
    }
    let evidence = inspect_environment(connection, &row)?.ok_or_else(|| {
        "The environment is still present or cannot be treated as orphaned.".to_string()
    })?;
    if !evidence.cleanup_available {
        return Err(format!(
            "Environment cleanup is not available: {}",
            evidence.reasons.join("; ")
        ));
    }
    let target_path = row
        .target_checkout_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or(row.project_path.as_deref())
        .ok_or_else(|| "The environment has no target checkout to verify.".to_string())?;
    let target_branch = row
        .target_branch
        .as_deref()
        .or(row.project_target_branch.as_deref())
        .unwrap_or("main");
    let mut branch_disposition = "no local branch remained";
    if evidence.branch_exists && row.branch != target_branch {
        let checked_out = worktree_inventory(target_path)?
            .iter()
            .any(|worktree| worktree.branch.as_deref() == Some(row.branch.as_str()));
        if checked_out {
            branch_disposition = "local branch retained: checked out in another worktree";
        } else if branch_is_claimed_elsewhere(connection, &row.id, &row.branch)? {
            branch_disposition = "local branch retained: another resource ledger still claims it";
        } else if let Some(tip) = evidence.branch_tip.as_deref() {
            git_output(
                target_path,
                &[
                    "update-ref",
                    "-d",
                    &format!("refs/heads/{}", row.branch),
                    tip,
                ],
            )?;
            branch_disposition = "local branch deleted with exact-tip merge proof";
        }
    }
    let removed = connection
        .execute(
            "DELETE FROM card_environments WHERE id=?1 AND card_id=?2 AND revision=?3",
            params![row.id, row.card_id, row.revision],
        )
        .map_err(db_error)?;
    if removed != 1 {
        return Err("The environment changed during cleanup; refresh board health.".into());
    }
    connection
        .execute(
            "DELETE FROM card_pi_lifecycle WHERE card_id=?1",
            [&row.card_id],
        )
        .map_err(db_error)?;
    let updated = connection
        .execute(
            "UPDATE kanban_cards SET workflow_revision=workflow_revision+1,updated_at=?1 WHERE id=?2",
            params![unix_timestamp(), row.card_id],
        )
        .map_err(db_error)?;
    if updated != 1 {
        return Err("The card changed during environment cleanup; refresh board health.".into());
    }
    connection
        .execute(
            "INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,summary)
             VALUES (?1,?2,'user','board_hygiene_cleanup_environment','success',?3)",
            params![
                row.card_id,
                unix_timestamp(),
                format!(
                    "Board hygiene removed orphaned environment {} ({branch_disposition})",
                    row.id
                )
            ],
        )
        .map_err(db_error)?;
    Ok(())
}

#[cfg(test)]
#[path = "retirement_tests.rs"]
mod tests;
