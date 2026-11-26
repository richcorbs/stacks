//! Contract for the single gate (card #350).
//!
//! One table enumerates every `BlockerCode`; one table pins the historical stuck
//! states and the repair that clears each; one scenario asserts the banner, action
//! gating and retention all read the same verdict.

use super::super::repository::initialize_connection;
use super::*;
use rusqlite::params;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn git(path: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn database() -> Connection {
    let mut connection = Connection::open_in_memory().unwrap();
    initialize_connection(&mut connection).unwrap();
    connection
}

fn project(connection: &Connection, id: &str, path: &str) {
    connection
        .execute(
            "INSERT INTO projects(id,name,path,kanban_source,target_branch,delivery_workflow)
             VALUES (?1,?1,?2,'local','main','local_merge')",
            params![id, path],
        )
        .unwrap();
}

fn card(connection: &Connection, id: &str, project_id: Option<&str>, status: &str) {
    connection
        .execute(
            "INSERT INTO kanban_cards(id,external_provider,external_id,title,project_id,status,created_at,updated_at,in_scope)
             VALUES (?1,'local:p',?1,?1,?2,?3,1,1,1)",
            params![id, project_id, status],
        )
        .unwrap();
}

fn environment(
    connection: &Connection,
    card_id: &str,
    project_id: &str,
    worktree: &str,
    branch: &str,
    target: Option<&str>,
    repository: Option<&str>,
) {
    connection
        .execute(
            "INSERT INTO card_environments(id,card_id,project_id,worktree_path,branch,target_checkout_path,target_branch,repository_id,revision,created_at,updated_at)
             VALUES ('env-'||?1,?1,?2,?3,?4,?5,'main',?6,1,1,1)",
            params![card_id, project_id, worktree, branch, target, repository],
        )
        .unwrap();
}

fn code_set(verdict: &GateVerdict) -> Vec<&'static str> {
    verdict.blockers.iter().map(|blocker| blocker.code.as_str()).collect()
}

fn repair_ids(verdict: &GateVerdict) -> Vec<&str> {
    verdict.repairs.iter().map(|repair| repair.id.as_str()).collect()
}

fn git_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target");
    fs::create_dir(&target).unwrap();
    git(&target, &["init", "-b", "main"]);
    git(&target, &["config", "user.name", "Test"]);
    git(&target, &["config", "user.email", "test@example.invalid"]);
    fs::write(target.join("base"), "base").unwrap();
    git(&target, &["add", "."]);
    git(&target, &["commit", "-m", "base"]);
    let source = root.path().join("source");
    git(
        &target,
        &["worktree", "add", "-b", "feature", source.to_str().unwrap()],
    );
    fs::write(source.join("card"), "card work").unwrap();
    git(&source, &["add", "."]);
    git(&source, &["commit", "-m", "card work"]);
    (root, target, source)
}

#[test]
fn every_blocker_code_is_stable_and_names_one_repair() {
    let mut seen = std::collections::HashSet::new();
    for code in BlockerCode::ALL {
        let text = code.as_str();
        assert!(!text.is_empty(), "a blocker code must be machine-readable");
        assert!(
            text.chars().all(|character| character.is_ascii_lowercase() || character == '_'),
            "{text:?} is not a stable snake_case code"
        );
        assert!(seen.insert(text), "duplicate blocker code {text}");
        assert_eq!(BlockerCode::from_str(text), Some(*code));
        assert!(
            !code.message().trim().is_empty(),
            "{text} has no message"
        );

        let repair = code.repair().repair();
        assert!(!repair.id.is_empty(), "{text} has no repair id");
        assert!(!repair.label.trim().is_empty(), "{text} has no repair label");
        assert!(!repair.effect.trim().is_empty(), "{text} has no repair effect");
        assert!(
            RepairId::ALL
                .iter()
                .any(|candidate| candidate.as_str() == repair.id),
            "{text} names unknown repair {}",
            repair.id
        );
        // Every code either has an automatic action or an explicit needs-you reason.
        if repair.kind == RepairKind::NeedsUser {
            assert!(
                repair.effect.len() > 10,
                "{text} needs a human but does not explain what to do"
            );
        }
    }
}

#[test]
fn historical_stuck_states_report_the_same_code_plus_a_working_repair() {
    // 1. hierarchy_finalized=1 with no children: stale projection, one-click repair.
    let db = database();
    project(&db, "p", "/tmp/gate-stale-parent");
    card(&db, "stale-parent", Some("p"), "ready");
    db.execute(
        "UPDATE kanban_cards SET hierarchy_finalized=1 WHERE id='stale-parent'",
        [],
    )
    .unwrap();
    let verdict = evaluate(&db, "stale-parent", GateContext::health()).unwrap();
    assert!(code_set(&verdict).contains(&"finalized_parent_without_children"));
    assert!(repair_ids(&verdict).contains(&"repair_parent_metadata"));
    assert_eq!(
        verdict.blockers[0].repair.kind,
        RepairKind::Automatic,
        "the stale flag must be repairable in one click"
    );

    // 2. Done card whose environment worktree is gone: orphaned-environment repair.
    let db = database();
    project(&db, "p", "/tmp/gate-orphan");
    card(&db, "orphan", Some("p"), "done");
    environment(&db, "orphan", "p", "/missing/gate/orphan", "feature", None, None);
    let verdict = evaluate(&db, "orphan", GateContext::health()).unwrap();
    assert!(code_set(&verdict).contains(&"environment_worktree_missing"));
    assert!(repair_ids(&verdict).contains(&"cleanup_orphaned_environment"));

    // 3. pi_lifecycle backfilled as active with no session: clear the projection.
    let db = database();
    project(&db, "p", "/tmp/gate-lifecycle");
    card(&db, "lifecycle", Some("p"), "done");
    db.execute(
        "INSERT INTO card_pi_lifecycle(card_id,thread,generation,latest_event_order,latest_event_id)
         VALUES ('lifecycle','work','g1',0,'e1')",
        [],
    )
    .unwrap();
    let verdict = evaluate(&db, "lifecycle", GateContext::health()).unwrap();
    assert!(code_set(&verdict).contains(&"stale_lifecycle_projection"));
    assert!(repair_ids(&verdict).contains(&"clear_stale_lifecycle"));

    // 5. Provider sync queued and never drained: retry it, never "resume retirement".
    let db = database();
    project(&db, "p", "/tmp/gate-provider");
    card(&db, "sync", Some("p"), "done");
    db.execute(
        "INSERT INTO provider_sync_operations(id,card_id,kind,provider,external_id,board_id,
            source_column_id,source_column_name,destination_column_id,destination_column_name,
            workflow_revision,integration_revision,project_id,api_token_env_var,state,attempts,
            error,created_at,updated_at)
         VALUES ('op-sync','sync','done','superthread','1','b','l','List','d','Done',1,1,'p','ST','pending',0,NULL,1,1)",
        [],
    )
    .unwrap();
    let verdict = evaluate(&db, "sync", GateContext::health()).unwrap();
    assert!(code_set(&verdict).contains(&"provider_sync_pending"));
    assert!(repair_ids(&verdict).contains(&"retry_provider_sync"));
}

#[test]
fn stale_target_checkout_offers_a_pull_not_a_rewritten_history() {
    // 4. A merged-on-the-forge revision that the primary checkout has not pulled yet.
    let (root, target, source) = git_fixture();
    let remote = root.path().join("remote.git");
    git(&target, &["init", "--bare", remote.to_str().unwrap()]);
    git(&target, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&target, &["push", "-u", "origin", "main"]);

    let db = database();
    project(&db, "p", target.to_str().unwrap());
    card(&db, "stale-target", Some("p"), "done");
    db.execute(
        "UPDATE kanban_cards SET completion_outcome='merged' WHERE id='stale-target'",
        [],
    )
    .unwrap();
    let repository = repository_identity(target.to_str().unwrap()).unwrap();
    let source_tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    environment(
        &db,
        "stale-target",
        "p",
        source.to_str().unwrap(),
        "feature",
        Some(target.to_str().unwrap()),
        Some(&repository),
    );
    db.execute(
        "UPDATE card_environments SET source_revision=?1 WHERE card_id='stale-target'",
        [&source_tip],
    )
    .unwrap();

    // Merge on the forge, then leave the primary checkout one commit behind.
    git(&target, &["push", "origin", "feature"]);
    git(&target, &["fetch", "-q", "origin"]);
    git(
        &target,
        &["merge", "--no-ff", "origin/feature", "-m", "Merge pull request #1"],
    );
    git(&target, &["push", "origin", "main"]);
    git(&target, &["reset", "--hard", "-q", "origin/main~1"]);

    let verdict = evaluate(&db, "stale-target", GateContext::health()).unwrap();
    assert!(code_set(&verdict).contains(&"target_checkout_behind"), "{:?}", code_set(&verdict));
    assert!(!code_set(&verdict).contains(&"source_revision_not_merged"));
    assert!(repair_ids(&verdict).contains(&"pull_target_checkout"));
    assert_eq!(
        verdict
            .blockers
            .iter()
            .find(|blocker| blocker.code == BlockerCode::TargetCheckoutBehind)
            .unwrap()
            .repair
            .kind,
        RepairKind::Automatic
    );

    // One click: the repair is a fast-forward pull, and the blocker disappears.
    pull_target_checkout(&db, "stale-target").unwrap();
    let after = evaluate(&db, "stale-target", GateContext::health()).unwrap();
    assert!(!code_set(&after).contains(&"target_checkout_behind"));
    drop(root);
}

#[test]
fn no_blocker_is_emitted_without_an_action_or_a_needs_user_explanation() {
    // Exercise every reachable fixture class through the real database.
    let db = database();
    project(&db, "p", "/tmp/gate-no-dead-end");
    card(&db, "done", Some("p"), "done");
    card(&db, "working", Some("p"), "agent_working");
    card(&db, "finalized", Some("p"), "ready");
    db.execute(
        "UPDATE kanban_cards SET hierarchy_finalized=1 WHERE id='finalized'",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO card_pi_lifecycle(card_id,thread,generation,latest_event_order,latest_event_id)
         VALUES ('done','work','g',0,'e')",
        [],
    )
    .unwrap();
    for id in ["done", "working", "finalized"] {
        for context in [
            GateContext::health(),
            GateContext::retire(RetirementMode::PreserveResources, RetirementOverride::default(), &[]),
            GateContext::retire(RetirementMode::RemoveResources, RetirementOverride::default(), &[]),
            GateContext::retire(RetirementMode::DeleteRecord, RetirementOverride::default(), &[]),
            GateContext::retention(RetirementOverride::default()),
        ] {
            let verdict = evaluate(&db, id, context).unwrap();
            for blocker in &verdict.blockers {
                assert!(
                    !blocker.repair.id.is_empty(),
                    "{id}/{} has no repair",
                    blocker.code.as_str()
                );
                assert!(
                    !blocker.message.trim().is_empty() && !blocker.repair.effect.trim().is_empty(),
                    "{id}/{} needs a human but does not say what to do",
                    blocker.code.as_str()
                );
            }
        }
    }
}

#[test]
fn banner_action_gating_and_retention_read_one_verdict() {
    // A Done card whose environment worktree is gone is the shared scenario: the
    // banner shows the blocker, Cleanup is disabled with the same message, and
    // retention reports the same code.
    let db = database();
    project(&db, "p", "/tmp/gate-one-verdict");
    card(&db, "blocked", Some("p"), "done");
    environment(
        &db,
        "blocked",
        "p",
        "/missing/gate/one-verdict",
        "feature",
        None,
        None,
    );

    let verdict = evaluate(&db, "blocked", GateContext::health()).unwrap();
    let blocker = verdict
        .blockers
        .iter()
        .find(|blocker| blocker.code == BlockerCode::EnvironmentWorktreeMissing)
        .expect("the gate reports the orphaned environment");

    let banner = environment_health(&db, "blocked").unwrap();
    assert!(banner
        .issues
        .iter()
        .any(|issue| issue.code == blocker.code.as_str() && issue.message == blocker.message));
    assert_eq!(
        banner
            .issues
            .iter()
            .find(|issue| issue.code == blocker.code.as_str())
            .and_then(|issue| issue.repair.as_ref())
            .map(|repair| repair.id.as_str()),
        Some("cleanup_orphaned_environment")
    );

    // Action gating at the mutation boundary uses the same verdict and message.
    let cleanup = evaluate(&db, "blocked", GateContext::action(WorkflowAction::Cleanup)).unwrap();
    let gating = cleanup
        .blocker_for(WorkflowAction::Cleanup)
        .expect("cleanup is disabled");
    assert!(
        banner
            .issues
            .iter()
            .any(|issue| issue.message == gating.message),
        "the disabled reason must be one of the banner's own messages"
    );

    // Retention cites the gate's code, not a sixth reason string.
    let retention = evaluate(
        &db,
        "blocked",
        GateContext::retention(RetirementOverride::default()),
    )
    .unwrap();
    assert!(code_set(&retention).contains(&"owning_environment"));
}

/// Rehearsal against a copy of the production database. Run with:
/// `STACKS_GATE_REHEARSAL_DB=/path/to/workflow.sqlite3 cargo test --lib gate::tests::rehearsal -- --ignored --nocapture`
///
/// It is ignored by default because it reads a user database, and it never mutates:
/// every mode is evaluated read-only and printed so the known-bad cards show their
/// code and repair.
#[test]
#[ignore = "requires STACKS_GATE_REHEARSAL_DB pointing at a copy of workflow.sqlite3"]
fn rehearsal_against_a_production_database_copy() {
    let path = std::env::var("STACKS_GATE_REHEARSAL_DB")
        .expect("set STACKS_GATE_REHEARSAL_DB to a workflow.sqlite3 copy");
    let connection = Connection::open(path).unwrap();
    let mut statement = connection
        .prepare("SELECT id FROM kanban_cards ORDER BY id")
        .unwrap();
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let mut blocked = 0;
    for id in ids {
        for context in [
            GateContext::health(),
            GateContext::retire(
                RetirementMode::RemoveResources,
                RetirementOverride::default(),
                &[],
            ),
            GateContext::retention(RetirementOverride::default()),
        ] {
            let mode = context.mode;
            let verdict = evaluate(&connection, &id, context).unwrap();
            if verdict.blocked() {
                blocked += 1;
                eprintln!(
                    "{id} {mode:?}: {:?} -> {:?}",
                    code_set(&verdict),
                    repair_ids(&verdict)
                );
            }
        }
    }
    eprintln!("rehearsal: {blocked} blocked card/mode verdicts");
}
