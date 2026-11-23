//! Regression fixtures for card #341: every historical stuck-card class must be
//! handled by the single retirement path, and the old hard refusals must not return.

use super::*;
use crate::kanban::migrate;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn database(project_path: &Path) -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    crate::store::migrate_store_schema(&connection).unwrap();
    connection
        .execute(
            "INSERT INTO projects (id,name,path,kanban_source,superthread_spaces,superthread_board_id,superthread_incoming_columns,sort_order)
             VALUES ('p','p',?1,'local','[]','', '[]',0)",
            [project_path.to_string_lossy().to_string()],
        )
        .unwrap();
    connection
}

fn card(connection: &Connection, id: &str, status: &str, revision: i64) {
    connection
        .execute(
            "INSERT INTO kanban_cards (id,external_provider,external_id,title,status,workflow_revision,project_id,in_scope,created_at,updated_at)
             VALUES (?1,'local:p',?1,?1,?2,?3,'p',1,1,1)",
            params![id, status, revision],
        )
        .unwrap();
}

fn git_ok(path: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// A target checkout on `main` with a `feature` worktree that has one commit.
fn repository() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target");
    let source = root.path().join("source");
    fs::create_dir_all(&target).unwrap();
    git_ok(&target, &["init", "-b", "main"]);
    git_ok(&target, &["config", "user.email", "stacks@example.com"]);
    git_ok(&target, &["config", "user.name", "Stacks Tests"]);
    fs::write(target.join("base.txt"), "base\n").unwrap();
    git_ok(&target, &["add", "."]);
    git_ok(&target, &["commit", "-m", "base"]);
    git_ok(
        &target,
        &["worktree", "add", "-b", "feature", source.to_str().unwrap()],
    );
    fs::write(source.join("feature.txt"), "feature\n").unwrap();
    git_ok(&source, &["add", "."]);
    git_ok(&source, &["commit", "-m", "feature"]);
    (root, target, source)
}

fn environment(
    connection: &Connection,
    card_id: &str,
    target: &Path,
    worktree: &Path,
    revision: &str,
) {
    connection
        .execute(
            "INSERT INTO card_environments
             (id,card_id,project_id,worktree_path,branch,repository_id,target_checkout_path,target_branch,source_revision,created_at,updated_at)
             VALUES ('env',?1,'p',?2,'feature',?3,?4,'main',?5,1,1)",
            params![
                card_id,
                worktree.to_string_lossy().to_string(),
                repository_identity(target.to_str().unwrap()).unwrap(),
                target.to_string_lossy().to_string(),
                revision
            ],
        )
        .unwrap();
}

/// 1. A finalized aggregate with no linked children must be closeable. The stale
///    A card/thread lifecycle row is a projection of live Pi state, not work in
///    flight. The journal migration backfilled one per card+thread in phase
///    `active` (its only valid phase, never completed), which used to block
///    removing resources forever with "must be resumed instead of retiring".
#[test]
fn lifecycle_projection_does_not_block_removing_resources() {
    let root = tempfile::tempdir().unwrap();
    let connection = database(root.path());
    card(&connection, "local:done", "done", 2);
    connection
        .execute(
            "UPDATE kanban_cards SET completion_outcome='merged' WHERE id='local:done'",
            [],
        )
        .unwrap();
    for thread in ["planning", "work"] {
        connection
            .execute(
                "INSERT INTO card_pi_lifecycle(card_id,thread,generation,latest_event_order,latest_event_id) VALUES (?1,?2,'gen',0,'gen:0')",
                rusqlite::params!["local:done", thread],
            )
            .unwrap();
    }
    let in_flight = operations::in_flight_for_card(&connection, "local:done").unwrap();
    assert_eq!(in_flight.len(), 2, "the projection rows exist");
    assert!(in_flight.iter().all(|operation| operation.kind.is_lifecycle_projection()));

    let checklist = evaluate(
        &connection,
        "local:done",
        RetirementMode::RemoveResources,
        RetirementOverride::default(),
        &[],
    )
    .unwrap();
    assert!(
        !checklist.blockers.iter().any(|blocker| blocker.code == UNRESOLVED_OPERATION),
        "a lifecycle projection must not block retirement: {:?}",
        checklist.blockers
    );

    // A real unfinished operation of another kind still blocks, so the gate is intact.
    connection
        .execute(
            "INSERT INTO operations(id,card_id,kind,phase,attempt,payload,created_at,updated_at)
             VALUES ('purge:test','local:done','purge','pending',0,'{\"card_id\":\"local:done\",\"storage_key\":\"local_done\"}',1,1)",
            [],
        )
        .unwrap();
    let blocked = evaluate(
        &connection,
        "local:done",
        RetirementMode::RemoveResources,
        RetirementOverride::default(),
        &[],
    )
    .unwrap();
    assert!(blocked.blockers.iter().any(|blocker| blocker.code == UNRESOLVED_OPERATION));
}

///    metadata is repaired and the close event recorded; the card is never bricked.
#[test]
fn finalized_parent_without_children_is_retirement_ready_and_repaired() {
    let root = tempfile::tempdir().unwrap();
    let connection = database(root.path());
    card(&connection, "local:zombie", "ready", 1);
    connection
        .execute(
            "UPDATE kanban_cards SET hierarchy_finalized=1,provider_child_count=3,completion_outcome=NULL WHERE id='local:zombie'",
            [],
        )
        .unwrap();

    let checklist = evaluate(
        &connection,
        "local:zombie",
        RetirementMode::PreserveResources,
        RetirementOverride::default(),
        &[],
    )
    .unwrap();
    assert!(!checklist.blocked(), "{:?}", checklist.blockers);

    let mut connection = connection;
    commit_card_close(&mut connection, "local:zombie", 1).unwrap();
    let closed = get_card(&connection, "local:zombie").unwrap().unwrap();
    assert_eq!(closed.status, "done");
    assert_eq!(
        closed.completion_outcome,
        Some(CompletionOutcome::Closed)
    );
    assert_eq!(
        closed
            .events
            .iter()
            .filter(|event| event.event_type == "close" && event.outcome == "success")
            .count(),
        1
    );

    // Hygiene still owns detection, but its repair is the same local flag clear.
    crate::kanban::hygiene::repair_stale_parent_metadata(&mut connection).unwrap();
    let repaired = get_card(&connection, "local:zombie").unwrap().unwrap();
    assert_eq!(repaired.hierarchy_finalized, false);
}

/// 2. A Done card whose recorded worktree is gone must lose the orphaned tombstone
///    rather than being refused forever.
#[test]
fn missing_worktree_orphan_is_removed_by_the_shared_retirement_repair() {
    let (root, target, source) = repository();
    // Remove the worktree but keep the (merged) branch and the environment tombstone.
    let tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    git_ok(&target, &["merge", "--no-ff", "feature", "-m", "merge"]);
    git_ok(
        &target,
        &["worktree", "remove", "--force", source.to_str().unwrap()],
    );
    let connection = database(&target);
    card(&connection, "local:orphan", "done", 3);
    connection
        .execute(
            "UPDATE kanban_cards SET completion_outcome='merged',done_entered_at=1 WHERE id='local:orphan'",
            [],
        )
        .unwrap();
    environment(&connection, "local:orphan", &target, &source, &tip);

    let checklist = evaluate(
        &connection,
        "local:orphan",
        RetirementMode::RemoveResources,
        RetirementOverride::default(),
        &[],
    )
    .unwrap();
    assert!(!checklist.blocked(), "{:?}", checklist.blockers);
    assert!(checklist.has_resources);

    let mut connection = connection;
    let revision: i64 = connection
        .query_row(
            "SELECT revision FROM card_environments WHERE card_id='local:orphan'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    remove_orphaned_environment_in(
        &mut connection,
        "local:orphan",
        "env",
        revision,
        true,
    )
    .unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM card_environments WHERE card_id='local:orphan'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let event: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM card_events WHERE card_id='local:orphan' AND event_type='board_hygiene_cleanup_environment'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(event, 1);
    fs::remove_dir_all(root.path()).ok();
}

/// 3. Unmerged work with an explicit override preserves a recovery bundle before any
///    worktree or branch is removed. The path is reported to the user.
#[test]
fn unmerged_override_preserves_a_recovery_bundle() {
    let (_root, target, source) = repository();
    // Remove the worktree so only the unmerged branch remains.
    let tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    git_ok(
        &target,
        &["worktree", "remove", "--force", source.to_str().unwrap()],
    );
    let connection = database(&target);
    card(&connection, "local:spike", "done", 2);
    connection
        .execute(
            "UPDATE kanban_cards SET completion_outcome='closed' WHERE id='local:spike'",
            [],
        )
        .unwrap();
    environment(&connection, "local:spike", &target, &source, &tip);

    let blocked = evaluate(
        &connection,
        "local:spike",
        RetirementMode::RemoveResources,
        RetirementOverride::default(),
        &[],
    )
    .unwrap();
    assert!(blocked.blocked());
    assert!(blocked
        .blockers
        .iter()
        .any(|blocker| blocker.reason == UNMERGED_REVISION));
    assert!(blocked.override_available);

    let overridden = evaluate(
        &connection,
        "local:spike",
        RetirementMode::RemoveResources,
        RetirementOverride::explicit(true),
        &[],
    )
    .unwrap();
    assert!(!overridden.blocked(), "{:?}", overridden.blockers);
    assert!(!overridden.merged);
    let evidence = preserve_evidence(&overridden).unwrap().expect("bundle");
    assert!(Path::new(&evidence).is_file(), "{evidence}");
    let verify = Command::new("git")
        .args(["-C", target.to_str().unwrap(), "bundle", "verify", &evidence])
        .output()
        .unwrap();
    assert!(
        verify.status.success(),
        "{}",
        String::from_utf8_lossy(&verify.stderr)
    );
    fs::remove_file(&evidence).ok();
}

/// 3b. The destructive branch step accepts the explicit override and uses `-D`, while
///     a normal cleanup still refuses unmerged work.
#[test]
fn unmerged_branch_is_only_deleted_under_an_explicit_override() {
    let (_root, target, source) = repository();
    let tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    let mut operation = CleanupSnapshot {
        card_id: "local:spike".into(),
        environment_id: "env".into(),
        workflow_revision: 1,
        environment_revision: 1,
        status: "pending".into(),
        phase: "validate_repository".into(),
        completion_outcome: "closed".into(),
        repository_id: repository_identity(target.to_str().unwrap()).unwrap(),
        source_path: source.to_string_lossy().to_string(),
        target_path: target.to_string_lossy().to_string(),
        source_branch: "feature".into(),
        target_branch: "main".into(),
        source_revision: tip.clone(),
        delete_local_branch: true,
        delete_remote_branch: false,
        merged_pr_head_revision: None,
        pane_ids: Vec::new(),
        override_authorized: false,
        registration_validated: false,
    };
    assert!(delete_cleanup_local_branch(&operation)
        .unwrap_err()
        .contains("not safely merged"));
    assert!(local_ref_tip(target.to_str().unwrap(), "feature")
        .unwrap()
        .is_some());

    operation.override_authorized = true;
    validate_cleanup_repository(&operation).unwrap();
    remove_cleanup_worktree(&operation).unwrap();
    delete_cleanup_local_branch(&operation).unwrap();
    assert!(local_ref_tip(target.to_str().unwrap(), "feature")
        .unwrap()
        .is_none());
}

/// 4. A dirty worktree is refused with the exact blocker text and nothing is removed.
#[test]
fn dirty_worktree_refuses_the_single_path_without_touching_resources() {
    let (_root, target, source) = repository();
    git_ok(&target, &["merge", "--no-ff", "feature", "-m", "merge"]);
    let tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    fs::write(source.join("dirty.txt"), "unsaved\n").unwrap();
    let connection = database(&target);
    card(&connection, "local:dirty", "done", 2);
    connection
        .execute(
            "UPDATE kanban_cards SET completion_outcome='merged' WHERE id='local:dirty'",
            [],
        )
        .unwrap();
    environment(&connection, "local:dirty", &target, &source, &tip);

    let checklist = evaluate(
        &connection,
        "local:dirty",
        RetirementMode::RemoveResources,
        RetirementOverride::default(),
        &[],
    )
    .unwrap();
    assert!(checklist
        .blockers
        .iter()
        .any(|blocker| blocker.reason == DIRTY_WORKTREE));
    assert!(source.exists());
    assert!(local_ref_tip(target.to_str().unwrap(), "feature")
        .unwrap()
        .is_some());
}

/// 5. An interrupted retirement leaves one reportable operation and the same API
///    resumes it instead of creating a second intent.
#[test]
fn interrupted_retirement_resumes_the_same_journal_row() {
    let root = tempfile::tempdir().unwrap();
    let connection = database(root.path());
    card(&connection, "local:draft", "needs_refinement", 1);
    let payload = OperationPayload::Retirement(RetirementPayload {
        card_id: "local:draft".into(),
        mode: RetirementMode::DeleteRecord.as_str().into(),
        workflow_revision: 1,
        override_authorized: false,
        evidence_path: None,
    });
    let first = operations::begin(
        &connection,
        OperationKind::RetireDelete,
        "local:draft",
        "execute",
        &payload,
    )
    .unwrap();
    let second = operations::begin(
        &connection,
        OperationKind::RetireDelete,
        "local:draft",
        "execute",
        &payload,
    )
    .unwrap();
    assert_eq!(first, second);
    let in_flight = operations::in_flight_for_card(&connection, "local:draft").unwrap();
    assert_eq!(in_flight.len(), 1);
    assert_eq!(in_flight[0].kind, OperationKind::RetireDelete);

    // Resuming completes the same row; nothing is orphaned in flight.
    operations::complete(&connection, &first, "execute").unwrap();
    let in_flight = operations::in_flight_for_card(&connection, "local:draft").unwrap();
    assert!(in_flight.is_empty());
    let loaded = operations::load_operation(&connection, &first)
        .unwrap()
        .unwrap();
    assert!(loaded.completed_at.is_some());
}

/// 6. The retention discard is the same checklist under a complete override: the same
///    card is blocked normally and allowed for the sweep.
#[test]
fn retention_discard_uses_the_same_invariant_list_with_a_complete_override() {
    let (_root, target, source) = repository();
    let tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    git_ok(
        &target,
        &["worktree", "remove", "--force", source.to_str().unwrap()],
    );
    let connection = database(&target);
    card(&connection, "local:mixed", "done", 2);
    card(&connection, "local:mixed-child", "done", 1);
    connection
        .execute(
            "UPDATE kanban_cards SET parent_id='local:mixed' WHERE id='local:mixed-child'",
            [],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE kanban_cards SET completion_outcome='closed' WHERE id='local:mixed'",
            [],
        )
        .unwrap();
    environment(&connection, "local:mixed", &target, &source, &tip);
    connection
        .execute(
            "INSERT INTO card_pull_requests(card_id,repository,number,title,url,state,updated_at)
             VALUES ('local:mixed','owner/repo',1,'Open','https://example.invalid', 'open',1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO provider_sync_operations(id,card_id,kind,provider,external_id,board_id,source_column_id,source_column_name,destination_column_id,destination_column_name,workflow_revision,integration_revision,project_id,api_token_env_var,state,created_at,updated_at)
             VALUES ('op','local:mixed','done','superthread','remote','board','from','from','to','to',1,1,'p','TOKEN','failed',1,1)",
            [],
        )
        .unwrap();

    let normal = evaluate(
        &connection,
        "local:mixed",
        RetirementMode::RemoveResources,
        RetirementOverride::default(),
        &[],
    )
    .unwrap();
    assert!(normal
        .blockers
        .iter()
        .any(|blocker| blocker.code == LINKED_CHILDREN));
    assert!(normal
        .blockers
        .iter()
        .any(|blocker| blocker.code == UNMERGED_REVISION));

    let discard = evaluate(
        &connection,
        "local:mixed",
        RetirementMode::RemoveResources,
        RetirementOverride::discard(),
        &[],
    )
    .unwrap();
    assert!(!discard.blocked(), "{:?}", discard.blockers);
}

/// 4b. A failing setup command keeps the worktree, records ownership, and offers the
///     in-place retry plus the explicit cleanup action instead of deleting evidence.
#[test]
fn failed_setup_keeps_worktree_and_exposes_retry_and_cleanup() {
    let (_root, target, source) = repository();
    let tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    let connection = database(&target);
    card(&connection, "local:setup", "ready", 1);
    let operation_id = format!("environment-creation:{}", uuid::Uuid::new_v4());
    let result_path = target.join("setup-result.cwd");
    connection
        .execute(
            "INSERT INTO environment_creation_operations
             (id,card_id,project_id,repository_id,expected_workflow_revision,target_checkout_path,target_branch,observed_target_revision,setup_command,custom_command,phase,attempt_token,result_path,pre_worktrees,pre_branches,created_at,updated_at)
             VALUES (?1,'local:setup','p',?2,1,?3,'main',?4,'exit 1',1,'setup_running','token',?5,'[]','{}',1,1)",
            params![
                operation_id,
                repository_identity(target.to_str().unwrap()).unwrap(),
                target.to_string_lossy().to_string(),
                git_output(target.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap(),
                result_path.to_string_lossy().to_string()
            ],
        )
        .unwrap();
    let op = load_creation_operation_row(&connection, "local:setup")
        .unwrap()
        .unwrap();
    let mut connection = connection;
    let recovered = crate::kanban::environment::setup_failed_recovery_in(
        &mut connection,
        &op,
        "Command failed: bundle install",
    )
    .unwrap();
    assert!(source.exists(), "worktree evidence must be preserved");
    assert!(local_ref_tip(target.to_str().unwrap(), "feature")
        .unwrap()
        .is_some());
    assert_eq!(
        recovered.creation_operation.as_ref().unwrap().phase,
        "recovery_required"
    );
    let cleanup_available: i64 = connection
        .query_row(
            "SELECT cleanup_available FROM environment_creation_operations WHERE card_id='local:setup'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cleanup_available, 1);
    let context = workflow_context_for_card(&connection, &recovered).unwrap();
    let actions = workflow::capabilities(&context)
        .into_iter()
        .map(|capability| capability.action)
        .collect::<Vec<_>>();
    assert!(actions.contains(&WorkflowAction::StartWork));
    assert!(actions.contains(&WorkflowAction::CleanupCreation));
    assert_eq!(tip.len(), 40);
}
