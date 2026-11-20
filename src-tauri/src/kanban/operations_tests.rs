//! Contract tests for the single operations journal (card #340).
//!
//! The legacy tables remain the write surface during the migration. These tests pin
//! the mirroring, the typed payload round-trip and the single resume dispatcher so the
//! follow-up cards can move reads without losing the state machine.

use super::health::db_error;
use super::operations::*;
use super::repository::configure_connection;
use super::*;

fn connection() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .unwrap();
    connection
        .execute(
            "INSERT INTO kanban_cards (id,external_provider,external_id,title,status,feature_environment,workflow_revision,project_id,workspace_id,created_at,updated_at,sort_order,in_scope)
             VALUES ('local:op','local:p','1','Operation','needs_refinement',0,1,'project','workspace',1,1,0,1)",
            [],
        )
        .unwrap();
    connection
}

fn cleanup_payload() -> CleanupPayload {
    CleanupPayload {
        environment_id: "environment".into(),
        workflow_revision: 1,
        environment_revision: 1,
        status: "pending".into(),
        completion_outcome: "merged".into(),
        repository_id: "repo".into(),
        source_path: "/source".into(),
        target_path: "/target".into(),
        source_branch: "feature".into(),
        target_branch: "main".into(),
        source_revision: "source-tip".into(),
        target_revision: Some("target-tip".into()),
        delete_local_branch: true,
        delete_remote_branch: false,
        merged_pr_repository: None,
        merged_pr_number: None,
        merged_pr_head_revision: None,
        pane_ids: "[]".into(),
        override_authorized: false,
        registration_validated: false,
        validation_completed_at: None,
        evidence: None,
    }
}

fn creation_payload() -> CreationPayload {
    CreationPayload {
        operation_id: "creation-operation".into(),
        card_id: "local:op".into(),
        project_id: "project".into(),
        repository_id: "repo".into(),
        expected_workflow_revision: 1,
        target_checkout_path: "/target".into(),
        target_branch: "main".into(),
        observed_target_revision: "target-tip".into(),
        setup_command: "setup".into(),
        custom_command: false,
        attempt_token: None,
        result_path: "/result".into(),
        pre_worktrees: "[]".into(),
        pre_branches: "{}".into(),
        post_worktrees: None,
        post_branches: None,
        setup_result_cwd: None,
        setup_output: None,
        source_path: None,
        source_branch: None,
        source_revision: None,
        source_worktree_new: false,
        source_branch_new: false,
        worktree_removed: false,
        error: None,
        cleanup_available: false,
        revision: 1,
    }
}

fn target_merge_payload() -> TargetMergePayload {
    TargetMergePayload {
        operation_id: "target-merge-operation".into(),
        card_id: "local:op".into(),
        environment_id: "environment".into(),
        workflow_revision: 1,
        environment_revision: 1,
        initial_status: "needs_human".into(),
        repository_id: "repo".into(),
        source_path: "/source".into(),
        source_branch: "feature".into(),
        target_checkout_path: "/target".into(),
        target_branch: "main".into(),
        upstream_remote: "origin".into(),
        upstream_merge_ref: "refs/heads/main".into(),
        source_revision: "source-tip".into(),
        initial_target_revision: "target-tip".into(),
        target_revision: "target-tip".into(),
        remote_revision: None,
        pushed_target_revision: None,
        push_attempts: 0,
        conflict_paths: "[]".into(),
        target_source: "remote".into(),
    }
}

fn scripted_payload() -> ScriptedDeliveryPayload {
    ScriptedDeliveryPayload {
        card_id: "local:op".into(),
        project_id: "project".into(),
        environment_id: "environment".into(),
        repository_id: "repo".into(),
        primary_checkout_path: "/target".into(),
        target_branch: "main".into(),
        source_revision: "source-tip".into(),
        merge_revision: "merge-tip".into(),
        verified_push_revision: None,
        deployed_revision: None,
        upstream_remote: None,
        upstream_ref: None,
        attempt_token: None,
        failure_class: None,
        summary: None,
        started_at: 1,
        revision: 1,
    }
}

fn provider_payload() -> ProviderSyncPayload {
    ProviderSyncPayload {
        operation_id: "provider-operation".into(),
        card_id: "local:op".into(),
        sync_kind: "start_work".into(),
        provider: "superthread".into(),
        external_id: "external".into(),
        board_id: "board".into(),
        source_column_id: "todo".into(),
        source_column_name: "Todo".into(),
        destination_column_id: "doing".into(),
        destination_column_name: "Doing".into(),
        workflow_revision: 1,
        integration_revision: 1,
        project_id: "project".into(),
        api_token_env_var: "ST_TOKEN".into(),
        logical_revision: 0,
    }
}

fn purge_payload() -> PurgePayload {
    PurgePayload {
        card_id: "local:op".into(),
        storage_key: "local_op".into(),
    }
}

fn pi_payload() -> PiLifecyclePayload {
    PiLifecyclePayload {
        card_id: "local:op".into(),
        thread: "planning".into(),
        generation: "generation".into(),
        latest_event_order: -1,
        latest_event_id: String::new(),
    }
}

fn encode(payload: &OperationPayload) -> String {
    match payload {
        OperationPayload::Cleanup(value) => serde_json::to_string(value),
        OperationPayload::Creation(value) => serde_json::to_string(value),
        OperationPayload::TargetMerge(value) => serde_json::to_string(value),
        OperationPayload::ScriptedDelivery(value) => serde_json::to_string(value),
        OperationPayload::ProviderSync(value) => serde_json::to_string(value),
        OperationPayload::Purge(value) => serde_json::to_string(value),
        OperationPayload::PiLifecycle(value) => serde_json::to_string(value),
        OperationPayload::Retirement(value) => serde_json::to_string(value),
    }
    .unwrap()
}

fn insert_operation(
    connection: &Connection,
    id: &str,
    kind: OperationKind,
    phase: &str,
    payload: OperationPayload,
) {
    connection
        .execute(
            "INSERT INTO operations(id,card_id,kind,phase,attempt,error_code,error_detail,payload,created_at,updated_at,completed_at)
             VALUES (?1,'local:op',?2,?3,0,NULL,NULL,?4,1,1,NULL)",
            params![id, kind.as_str(), phase, encode(&payload)],
        )
        .unwrap();
}

#[test]
fn every_legacy_journal_mirrors_into_the_operations_table() {
    let connection = connection();
    connection
        .execute(
            "INSERT INTO card_cleanup_operations
             (card_id,environment_id,workflow_revision,environment_revision,status,phase,completion_outcome,repository_id,source_path,target_path,source_branch,target_branch,source_revision,delete_local_branch,delete_remote_branch,started_at,updated_at)
             VALUES ('local:op','environment',1,1,'pending','runtime_sessions','merged','repo','/source','/target','feature','main','source-tip',1,0,1,1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO environment_creation_operations
             (id,card_id,project_id,repository_id,expected_workflow_revision,target_checkout_path,target_branch,observed_target_revision,setup_command,phase,result_path,pre_worktrees,pre_branches,created_at,updated_at)
             VALUES ('creation-operation','local:op','project','repo',1,'/target','main','target-tip','setup','prepared','/result','[]','{}',1,1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO card_target_merge_operations
             (id,card_id,environment_id,workflow_revision,environment_revision,initial_status,repository_id,source_path,source_branch,target_checkout_path,target_branch,upstream_remote,upstream_merge_ref,source_revision,initial_target_revision,target_revision,phase,conflict_paths,created_at,updated_at)
             VALUES ('target-merge-operation','local:op','environment',1,1,'needs_human','repo','/source','feature','/target','main','origin','refs/heads/main','source-tip','target-tip','target-tip','target_sync','[]',1,1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO scripted_delivery_operations
             (card_id,project_id,environment_id,repository_id,primary_checkout_path,target_branch,source_revision,merge_revision,stage,started_at,updated_at)
             VALUES ('local:op','project','environment','repo','/target','main','source-tip','merge-tip','merged',1,1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO provider_sync_operations
             (id,card_id,kind,provider,external_id,board_id,source_column_id,source_column_name,destination_column_id,destination_column_name,workflow_revision,integration_revision,project_id,api_token_env_var,state,created_at,updated_at)
             VALUES ('provider-operation','local:op','start_work','superthread','external','board','todo','Todo','doing','Doing',1,1,'project','ST_TOKEN','pending',1,1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO local_card_purge_jobs(card_id,storage_key) VALUES ('local:op','local_op')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO card_pi_lifecycle(card_id,thread,generation) VALUES ('local:op','planning','generation')",
            [],
        )
        .unwrap();

    let operations = list_operations(&connection, None).unwrap();
    assert_eq!(operations.len(), 7, "every journal kind must be mirrored");
    for operation in &operations {
        assert_eq!(
            operation.payload.kind(),
            operation.kind,
            "payload kind must match the row kind for {}",
            operation.id
        );
        operation.payload.validate().unwrap();
    }
    let in_flight = in_flight_for_card(&connection, "local:op").unwrap();
    assert_eq!(in_flight.len(), 7);
    assert!(in_flight
        .iter()
        .any(|operation| operation.kind == OperationKind::Cleanup));
    assert!(in_flight
        .iter()
        .any(|operation| operation.kind == OperationKind::Purge));
}

#[test]
fn unknown_and_mismatched_payloads_fail_loudly() {
    let connection = connection();
    connection
        .execute(
            "INSERT INTO operations(id,card_id,kind,phase,payload,created_at,updated_at)
             VALUES ('unknown','local:op','mystery','anything','{}',1,1)",
            [],
        )
        .unwrap();
    let error = load_operation(&connection, "unknown").unwrap_err();
    assert!(error.contains("Unknown operation kind"), "{error}");

    connection
        .execute(
            "INSERT INTO operations(id,card_id,kind,phase,payload,created_at,updated_at)
             VALUES ('mismatch','local:op','provider_sync','pending',?1,1,1)",
            [encode(&OperationPayload::Cleanup(cleanup_payload()))],
        )
        .unwrap();
    let error = load_operation(&connection, "mismatch").unwrap_err();
    assert!(error.contains("cannot be decoded"), "{error}");

    connection
        .execute(
            "INSERT INTO operations(id,card_id,kind,phase,payload,created_at,updated_at)
             VALUES ('bad-phase','local:op','cleanup','not-a-phase',?1,1,1)",
            [encode(&OperationPayload::Cleanup(cleanup_payload()))],
        )
        .unwrap();
    let error = load_operation(&connection, "bad-phase").unwrap_err();
    assert!(error.contains("no phase"), "{error}");

    connection
        .execute(
            "INSERT INTO operations(id,card_id,kind,phase,payload,created_at,updated_at)
             VALUES ('bad-field','local:op','cleanup','runtime_sessions',?1,1,1)",
            [encode(&OperationPayload::Cleanup(CleanupPayload {
                source_revision: String::new(),
                ..cleanup_payload()
            }))],
        )
        .unwrap();
    let error = load_operation(&connection, "bad-field").unwrap_err();
    assert!(error.contains("source_revision"), "{error}");
}

struct RecordingDriver {
    phases: Vec<String>,
}

impl OperationDriver for RecordingDriver {
    fn apply_phase(&mut self, _operation: &Operation, phase: &str) -> Result<PhaseOutcome, String> {
        self.phases.push(phase.to_string());
        Ok(PhaseOutcome::Completed)
    }
}

#[test]
fn every_interrupted_operation_resumes_from_its_phase_through_one_dispatcher() {
    let connection = connection();
    let cases = [
        (
            "cleanup",
            OperationKind::Cleanup,
            "runtime_sessions",
            OperationPayload::Cleanup(cleanup_payload()),
        ),
        (
            "creation",
            OperationKind::Creation,
            "setup_complete",
            OperationPayload::Creation(creation_payload()),
        ),
        (
            "target-merge",
            OperationKind::TargetMerge,
            "target_sync",
            OperationPayload::TargetMerge(target_merge_payload()),
        ),
        (
            "scripted",
            OperationKind::ScriptedDelivery,
            "merged",
            OperationPayload::ScriptedDelivery(scripted_payload()),
        ),
        (
            "provider",
            OperationKind::ProviderSync,
            "pending",
            OperationPayload::ProviderSync(provider_payload()),
        ),
        (
            "purge",
            OperationKind::Purge,
            "pending",
            OperationPayload::Purge(purge_payload()),
        ),
        (
            "pi",
            OperationKind::PiLifecycle,
            "active",
            OperationPayload::PiLifecycle(pi_payload()),
        ),
    ];

    for (id, kind, phase, payload) in cases {
        insert_operation(&connection, id, kind, phase, payload);
        let mut driver = RecordingDriver { phases: Vec::new() };
        let outcome = resume_with(&connection, id, &mut driver).unwrap();
        assert_eq!(
            outcome,
            ResumeOutcome::Applied {
                phase: phase.to_string()
            },
            "kind {} must resume from its stored phase",
            kind.as_str()
        );
        assert_eq!(driver.phases, vec![phase.to_string()]);
        let operation = load_operation(&connection, id).unwrap().unwrap();
        assert!(operation.completed_at.is_some());
        assert_eq!(operation.attempt, 1);
        let attempts = attempts(&connection, id).unwrap();
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].phase.as_deref(), Some(phase));
        assert_eq!(attempts[0].outcome.as_deref(), Some("success"));
    }
}

#[test]
fn terminal_and_human_phases_are_never_applied() {
    let connection = connection();
    insert_operation(
        &connection,
        "deployed",
        OperationKind::ScriptedDelivery,
        "deployed",
        OperationPayload::ScriptedDelivery(scripted_payload()),
    );
    insert_operation(
        &connection,
        "uncertain",
        OperationKind::ScriptedDelivery,
        "uncertain",
        OperationPayload::ScriptedDelivery(scripted_payload()),
    );
    let mut driver = RecordingDriver { phases: Vec::new() };
    assert_eq!(
        resume_with(&connection, "deployed", &mut driver).unwrap(),
        ResumeOutcome::Completed
    );
    assert!(matches!(
        resume_with(&connection, "uncertain", &mut driver).unwrap(),
        ResumeOutcome::NeedsHuman { .. }
    ));
    assert!(driver.phases.is_empty());
    let in_flight = in_flight_for_card(&connection, "local:op").unwrap();
    assert!(in_flight
        .iter()
        .any(|operation| operation.id == "uncertain"));
    assert!(!in_flight.iter().any(|operation| operation.id == "deployed"));
}

#[test]
fn reinstall_backfills_evidence_and_stays_idempotent() {
    let connection = connection();
    connection
        .execute(
            "INSERT INTO card_cleanup_operations
             (card_id,environment_id,workflow_revision,environment_revision,status,phase,completion_outcome,repository_id,source_path,target_path,source_branch,target_branch,source_revision,delete_local_branch,delete_remote_branch,started_at,updated_at)
             VALUES ('local:op','environment',1,1,'failed','remove_metadata','merged','repo','/source','/target','feature','main','source-tip',1,0,1,1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO card_cleanup_evidence
             (card_id,reconciled_target_path,reconciled_target_branch,merge_proof_type,merge_proof_detail,local_branch_disposition,remote_branch_disposition,runtime_inventory,metadata_inventory,captured_at)
             VALUES ('local:op','/target','main','revision','proof','deleted','retained','[]','[]',5)",
            [],
        )
        .unwrap();
    // Simulate a database whose journal was recreated from the legacy tables.
    connection.execute("DELETE FROM operations", []).unwrap();
    install(&connection).unwrap();
    let operation = load_operation(&connection, "cleanup:local:op")
        .unwrap()
        .unwrap();
    let OperationPayload::Cleanup(payload) = &operation.payload else {
        panic!("expected cleanup payload");
    };
    assert!(payload.evidence.is_some(), "evidence must be backfilled");

    let before: i64 = connection
        .query_row("SELECT COUNT(*) FROM operations", [], |row| row.get(0))
        .unwrap();
    install(&connection).unwrap();
    let after: i64 = connection
        .query_row("SELECT COUNT(*) FROM operations", [], |row| row.get(0))
        .unwrap();
    assert_eq!(before, after, "backfill must be idempotent");
}

#[test]
fn child_journals_become_queryable_attempts() {
    let connection = connection();
    connection
        .execute(
            "INSERT INTO provider_sync_operations
             (id,card_id,kind,provider,external_id,board_id,source_column_id,source_column_name,destination_column_id,destination_column_name,workflow_revision,integration_revision,project_id,api_token_env_var,state,created_at,updated_at)
             VALUES ('provider-operation','local:op','start_work','superthread','external','board','todo','Todo','doing','Doing',1,1,'project','ST_TOKEN','pending',1,1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO provider_sync_attempts(operation_id,attempt_number,started_at,outcome) VALUES ('provider-operation',1,10,'running')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO card_cleanup_operations
             (card_id,environment_id,workflow_revision,environment_revision,status,phase,completion_outcome,repository_id,source_path,target_path,source_branch,target_branch,source_revision,delete_local_branch,delete_remote_branch,started_at,updated_at)
             VALUES ('local:op','environment',1,1,'pending','runtime_sessions','merged','repo','/source','/target','feature','main','source-tip',1,0,1,1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO card_cleanup_phase_outcomes(card_id,phase,outcome,detail,completed_at) VALUES ('local:op','validate_repository','success','ok',12)",
            [],
        )
        .unwrap();

    let provider = attempts(&connection, "provider_sync:provider-operation").unwrap();
    assert_eq!(provider.len(), 1);
    assert_eq!(provider[0].attempt, 1);
    assert_eq!(provider[0].outcome.as_deref(), Some("running"));

    let cleanup = attempts(&connection, "cleanup:local:op").unwrap();
    assert_eq!(cleanup.len(), 1);
    assert_eq!(cleanup[0].attempt, 1);
    assert_eq!(cleanup[0].phase.as_deref(), Some("validate_repository"));
    assert_eq!(cleanup[0].detail.as_deref(), Some("ok"));
}

#[test]
fn updates_and_evidence_are_mirrored_without_losing_payload() {
    let connection = connection();
    connection
        .execute(
            "INSERT INTO card_cleanup_operations
             (card_id,environment_id,workflow_revision,environment_revision,status,phase,completion_outcome,repository_id,source_path,target_path,source_branch,target_branch,source_revision,delete_local_branch,delete_remote_branch,started_at,updated_at)
             VALUES ('local:op','environment',1,1,'pending','validate_repository','merged','repo','/source','/target','feature','main','source-tip',1,0,1,1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO card_cleanup_evidence
             (card_id,reconciled_target_path,reconciled_target_branch,merge_proof_type,merge_proof_detail,local_branch_disposition,remote_branch_disposition,runtime_inventory,metadata_inventory,captured_at)
             VALUES ('local:op','/target','main','revision','source-tip is contained','deleted','retained','[]','[]',5)",
            [],
        )
        .unwrap();
    let operation = load_operation(&connection, "cleanup:local:op")
        .unwrap()
        .unwrap();
    let OperationPayload::Cleanup(payload) = &operation.payload else {
        panic!("expected cleanup payload");
    };
    assert!(payload.evidence.is_some());

    connection
        .execute(
            "UPDATE card_cleanup_operations SET phase='runtime_sessions',status='failed',error_code='cleanup_runtime_sessions_failed',error_detail='boom',updated_at=9 WHERE card_id='local:op'",
            [],
        )
        .unwrap();
    let operation = load_operation(&connection, "cleanup:local:op")
        .unwrap()
        .unwrap();
    assert_eq!(operation.phase, "runtime_sessions");
    assert_eq!(
        operation.error_code.as_deref(),
        Some("cleanup_runtime_sessions_failed")
    );
    let OperationPayload::Cleanup(payload) = &operation.payload else {
        panic!("expected cleanup payload");
    };
    assert!(
        payload.evidence.is_some(),
        "evidence must survive a parent update"
    );

    connection
        .execute(
            "DELETE FROM card_cleanup_operations WHERE card_id='local:op'",
            [],
        )
        .unwrap();
    assert!(load_operation(&connection, "cleanup:local:op")
        .unwrap()
        .is_none());
}

#[test]
fn purge_tombstone_survives_card_deletion() {
    let connection = connection();
    connection
        .execute(
            "INSERT INTO local_card_purge_jobs(card_id,storage_key) VALUES ('local:op','local_op')",
            [],
        )
        .unwrap();
    connection
        .execute("DELETE FROM kanban_cards WHERE id='local:op'", [])
        .unwrap();

    let operation = load_operation(&connection, "purge:local:op")
        .unwrap()
        .expect("purge tombstone must outlive the card");
    assert!(operation.card_id.is_none());
    let OperationPayload::Purge(payload) = &operation.payload else {
        panic!("expected purge payload");
    };
    assert_eq!(payload.card_id, "local:op");
    assert_eq!(payload.storage_key, "local_op");
}

#[test]
fn unreadable_operations_are_reported_not_resumed() {
    let connection = connection();
    connection
        .execute(
            "INSERT INTO operations(id,card_id,kind,phase,payload,created_at,updated_at)
             VALUES ('broken','local:op','cleanup','runtime_sessions','{not-json',1,1)",
            [],
        )
        .unwrap();
    let errors = unreadable_operations(&connection);
    assert_eq!(errors.len(), 1);
    assert!(errors[0].contains("broken"));
    // A report must not mutate or delete the row.
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM operations WHERE id='broken'",
            [],
            |row| row.get(0),
        )
        .map_err(db_error)
        .unwrap();
    assert_eq!(count, 1);
}

/// Rehearsal helper: run the real migration against a copy of a production database
/// and print the mirrored row count per kind. Run with:
/// `KANBAN_MIGRATE_COPY=/path/to/copy.sqlite3 cargo test --lib
///  kanban::operations_tests::migrate_a_database_copy_for_rehearsal -- --ignored --nocapture`
#[test]
#[ignore]
fn migrate_a_database_copy_for_rehearsal() {
    let path = std::env::var("KANBAN_MIGRATE_COPY").expect("set KANBAN_MIGRATE_COPY");
    let mut connection = Connection::open(&path).unwrap();
    configure_connection(&connection).unwrap();
    let before_integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .unwrap();
    let before_foreign_keys: Vec<String> = connection
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    initialize_connection(&mut connection).unwrap();
    let after_integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .unwrap();
    let after_foreign_keys: Vec<String> = connection
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(before_integrity, "ok");
    assert_eq!(after_integrity, "ok");
    assert!(before_foreign_keys.is_empty());
    assert!(after_foreign_keys.is_empty(), "{after_foreign_keys:?}");
    let mut statement = connection
        .prepare("SELECT kind,COUNT(*) FROM operations GROUP BY kind ORDER BY kind")
        .unwrap();
    for row in statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .unwrap()
    {
        let (kind, count) = row.unwrap();
        println!("OPERATIONS {kind} {count}");
    }
    for kind in OperationKind::ALL {
        let count = list_operations(&connection, Some(kind)).unwrap().len();
        println!("VALIDATED {} {count}", kind.as_str());
    }
}
