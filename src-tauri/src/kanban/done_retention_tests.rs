use super::*;

fn database() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    super::super::repository::migrate(&connection).unwrap();
    connection
}
fn card(connection: &Connection, id: &str, provider: &str, project: &str, status: &str, age: i64) {
    connection.execute("INSERT INTO kanban_cards(id,external_provider,external_id,title,project_id,status,created_at,updated_at) VALUES (?1,?2,?1,?1,?3,?4,1,1)", params![id,provider,project,status]).unwrap();
    if status == "done" {
        connection
            .execute(
                "UPDATE kanban_cards SET done_entered_at=?2 WHERE id=?1",
                params![id, unix_timestamp() - age],
            )
            .unwrap();
    }
}
fn remove(connection: &mut Connection, id: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM kanban_cards WHERE id=?1", [id])
        .map(|_| ())
        .map_err(db_error)
}
fn timestamp(connection: &Connection, id: &str) -> Option<i64> {
    connection
        .query_row(
            "SELECT done_entered_at FROM kanban_cards WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .unwrap()
}
fn count(connection: &Connection) -> i64 {
    connection
        .query_row("SELECT COUNT(*) FROM kanban_cards", [], |row| row.get(0))
        .unwrap()
}

#[test]
fn strict_boundary_all_providers_projects_outcomes_and_non_done_exclusion() {
    let mut db = database();
    let now = unix_timestamp();
    for (id, provider, project, status, age) in [
        ("under", "local:p1", "p1", "done", RETENTION_SECONDS - 1),
        ("exact", "superthread", "p2", "done", RETENTION_SECONDS),
        ("over", "superthread", "p2", "done", RETENTION_SECONDS + 1),
        ("closed", "local:p3", "p3", "done", RETENTION_SECONDS + 2),
        ("merged", "local:p4", "p4", "done", RETENTION_SECONDS + 3),
        ("active", "local:p5", "p5", "ready", RETENTION_SECONDS + 4),
    ] {
        card(&db, id, provider, project, status, age);
    }
    db.execute(
        "UPDATE kanban_cards SET completion_outcome='closed',in_scope=0 WHERE id='closed'",
        [],
    )
    .unwrap();
    db.execute(
        "UPDATE kanban_cards SET completion_outcome='merged' WHERE id='merged'",
        [],
    )
    .unwrap();
    // Pin against a clock tick between fixture creation and preview.
    db.execute(
        "UPDATE kanban_cards SET done_entered_at=?1 WHERE id='exact'",
        [now - RETENTION_SECONDS],
    )
    .unwrap();
    let preview = preview(&db, now).unwrap();
    assert_eq!(
        preview
            .candidates
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>(),
        vec!["closed", "merged", "over"]
    );
    let result = delete_candidates(&mut db, &preview.candidates, now, |_| Ok(()), remove).unwrap();
    assert_eq!((result.deleted, result.skipped, result.failed), (3, 0, 0));
    assert_eq!(count(&db), 3);
    let repeat = delete_candidates(&mut db, &preview.candidates, now, |_| Ok(()), remove).unwrap();
    assert_eq!((repeat.deleted, repeat.skipped), (0, 3));
}

#[test]
fn timestamp_stable_on_edit_sync_and_done_outcome_changes_but_cleared_on_exit() {
    let db = database();
    card(&db, "a", "superthread", "p", "done", RETENTION_SECONDS + 10);
    let original = timestamp(&db, "a");
    db.execute("UPDATE kanban_cards SET title='edited',updated_at=unixepoch(),status='done',completion_outcome='closed',in_scope=0 WHERE id='a'", []).unwrap();
    assert_eq!(timestamp(&db, "a"), original);
    // Provider suspension and reconciliation use SQL too; the trigger is universal.
    db.execute("UPDATE kanban_cards SET status='needs_human',scope_suspended=1,scope_prior_status='done' WHERE id='a'", []).unwrap();
    assert_eq!(timestamp(&db, "a"), None);
    db.execute(
        "UPDATE kanban_cards SET status='done',scope_suspended=0 WHERE id='a'",
        [],
    )
    .unwrap();
    assert!(timestamp(&db, "a").unwrap() > original.unwrap());
}

#[test]
fn conservative_backfill_uses_only_reliable_current_period_history() {
    let db = database();
    for id in ["known", "unknown", "interrupted", "failed"] {
        card(&db, id, "local:p", "p", "done", 1000);
    }
    db.execute_batch("DROP TRIGGER card_done_insert; DROP TRIGGER card_done_transition; DROP INDEX kanban_done_retention_idx; ALTER TABLE kanban_cards DROP COLUMN done_entered_at;
        INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,from_status,to_status) VALUES
          ('known',100,'human','transition','success','approved','done'),
          ('known',200,'human','edit','success','done','done'),
          ('interrupted',100,'human','transition','success','approved','done'),
          ('interrupted',200,'human','transition','success','done','ready'),
          ('failed',100,'human','transition','failure','approved','done');").unwrap();
    let before = unix_timestamp();
    super::super::repository::migrate(&db).unwrap();
    assert_eq!(timestamp(&db, "known"), Some(100));
    for id in ["unknown", "interrupted", "failed"] {
        assert!(timestamp(&db, id).unwrap() >= before);
    }
    super::super::repository::migrate(&db).unwrap();
    assert_eq!(timestamp(&db, "known"), Some(100));
}

#[test]
fn execution_revalidates_status_timestamp_and_new_hierarchy() {
    let mut db = database();
    for id in ["changed", "reentered", "newchild", "parent"] {
        card(&db, id, "local:p", "p", "done", RETENTION_SECONDS + 100);
    }
    let preview = preview(&db, unix_timestamp()).unwrap();
    db.execute(
        "UPDATE kanban_cards SET status='ready' WHERE id='changed'",
        [],
    )
    .unwrap();
    db.execute(
        "UPDATE kanban_cards SET status='ready' WHERE id='reentered'",
        [],
    )
    .unwrap();
    db.execute(
        "UPDATE kanban_cards SET status='done' WHERE id='reentered'",
        [],
    )
    .unwrap();
    card(&db, "retained", "local:p", "p", "ready", 0);
    db.execute(
        "UPDATE kanban_cards SET parent_id='parent' WHERE id='retained'",
        [],
    )
    .unwrap();
    db.execute(
        "UPDATE kanban_cards SET parent_id='retained' WHERE id='newchild'",
        [],
    )
    .unwrap();
    let result = delete_candidates(
        &mut db,
        &preview.candidates,
        unix_timestamp(),
        |_| Ok(()),
        remove,
    )
    .unwrap();
    assert_eq!((result.deleted, result.skipped), (0, 4));
    assert_eq!(count(&db), 5);
}

#[test]
fn fully_eligible_groups_delete_leaf_first_and_cascade_local_history() {
    let mut db = database();
    for id in ["parent", "child", "grandchild"] {
        card(&db, id, "local:p", "p", "done", RETENTION_SECONDS + 100);
    }
    db.execute_batch("UPDATE kanban_cards SET parent_id='parent' WHERE id='child'; UPDATE kanban_cards SET parent_id='child' WHERE id='grandchild';
        INSERT INTO card_events(card_id,created_at,actor,event_type,outcome) VALUES ('child',1,'human','test','success');
        INSERT INTO card_pi_lifecycle(card_id,thread,generation) VALUES ('child','planning','generation');
        INSERT INTO card_pi_lifecycle_events(card_id,thread,generation,event_id) VALUES ('child','planning','generation','event');").unwrap();
    let preview = preview(&db, unix_timestamp()).unwrap();
    let mut order = Vec::new();
    let result = delete_candidates(
        &mut db,
        &preview.candidates,
        unix_timestamp(),
        |_| Ok(()),
        |db, id| {
            order.push(id.to_owned());
            remove(db, id)
        },
    )
    .unwrap();
    assert_eq!(result.deleted, 3);
    assert_eq!(order, vec!["grandchild", "child", "parent"]);
    for table in [
        "card_events",
        "card_pi_lifecycle",
        "card_pi_lifecycle_events",
    ] {
        assert_eq!(
            db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[test]
fn unsafe_resources_and_runtimes_retain_the_entire_hierarchy() {
    let mut db = database();
    for id in [
        "parent", "child", "runtime", "cleanup", "provider", "delivery",
    ] {
        card(&db, id, "local:p", "p", "done", RETENTION_SECONDS + 100);
    }
    db.execute_batch("UPDATE kanban_cards SET parent_id='parent' WHERE id='child';
        INSERT INTO card_environments(id,card_id,project_id,worktree_path,created_at,updated_at) VALUES ('e','child','p','/never/remove',1,1);
        UPDATE kanban_cards SET runtime_cleanup_status='failed' WHERE id='cleanup';
        UPDATE kanban_cards SET delivery_error='unresolved' WHERE id='delivery';
        INSERT INTO provider_sync_operations(id,card_id,kind,provider,external_id,board_id,source_column_id,source_column_name,destination_column_id,destination_column_name,workflow_revision,integration_revision,project_id,api_token_env_var,state,created_at,updated_at)
          VALUES ('op','provider','done','superthread','remote','board','from','from','to','to',1,1,'p','TOKEN','failed',1,1);").unwrap();
    let preview = preview(&db, unix_timestamp()).unwrap();
    let result = delete_candidates(
        &mut db,
        &preview.candidates,
        unix_timestamp(),
        |id| {
            if id == "runtime" {
                Err("active runtime".into())
            } else {
                Ok(())
            }
        },
        remove,
    )
    .unwrap();
    assert_eq!((result.deleted, result.skipped), (0, 6));
    assert_eq!(count(&db), 6);
    assert!(result
        .details
        .iter()
        .any(|detail| detail.contains("unresolved provider")));
}

#[test]
fn group_failure_rolls_back_children_and_keeps_unrelated_successes() {
    let mut db = database();
    for id in ["parent", "child", "sibling", "unrelated"] {
        card(&db, id, "local:p", "p", "done", RETENTION_SECONDS + 100);
    }
    db.execute(
        "UPDATE kanban_cards SET parent_id='parent' WHERE id IN ('child','sibling')",
        [],
    )
    .unwrap();
    let preview = preview(&db, unix_timestamp()).unwrap();
    let result = delete_candidates(
        &mut db,
        &preview.candidates,
        unix_timestamp(),
        |_| Ok(()),
        |db, id| {
            if id == "parent" {
                Err("database failure".into())
            } else {
                remove(db, id)
            }
        },
    )
    .unwrap();
    assert_eq!((result.deleted, result.failed), (1, 3));
    assert_eq!(count(&db), 3);
}

#[test]
fn staging_preserves_files_on_database_failure_and_supports_crash_retry() {
    let mut db = database();
    card(&db, "a", "local:p", "p", "done", RETENTION_SECONDS + 100);
    let root = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("stacks-retention-{}", uuid::Uuid::new_v4()));
    let directory = root.join("a");
    let staged = root.join(".done-cleanup-a");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("history"), "retained history").unwrap();
    db.execute_batch("CREATE TRIGGER fail_delete BEFORE DELETE ON kanban_cards BEGIN SELECT RAISE(ABORT,'test database failure'); END;").unwrap();
    assert!(stage_and_delete_at(&mut db, "a", &directory, &staged).is_err());
    assert!(directory.join("history").exists());
    db.execute_batch("DROP TRIGGER fail_delete").unwrap();
    // Simulate a crash after staging but before the DB transaction committed.
    fs::rename(&directory, &staged).unwrap();
    stage_and_delete_at(&mut db, "a", &directory, &staged).unwrap();
    assert_eq!(count(&db), 0);
    assert!(staged.join("history").exists());
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM local_card_purge_jobs", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        1
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn partial_file_failure_keeps_a_retryable_job_without_recreating_card_records() {
    let mut db = database();
    card(&db, "a", "local:p", "p", "done", RETENTION_SECONDS + 100);
    let root = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("stacks-retention-{}", uuid::Uuid::new_v4()));
    let directory = root.join("a");
    let staged = root.join(".done-cleanup-a");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("one"), "one").unwrap();
    fs::write(directory.join("two"), "two").unwrap();
    stage_and_delete_at(&mut db, "a", &directory, &staged).unwrap();
    let failed = finish_purge(&db, "a", &staged, |path| {
        fs::remove_file(path.join("one")).unwrap();
        Err("simulated partial filesystem failure".into())
    });
    assert!(failed.unwrap_err().contains("partial filesystem failure"));
    assert_eq!(count(&db), 0);
    assert!(staged.join("two").exists());
    assert_eq!(preview(&db, unix_timestamp()).unwrap().pending_artifacts, 1);
    finish_purge(&db, "a", &staged, |path| {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    })
    .unwrap();
    assert!(!staged.exists());
    assert_eq!(preview(&db, unix_timestamp()).unwrap().pending_artifacts, 0);
    // Idempotent after storage is already gone.
    finish_purge(&db, "a", &staged, |_| panic!("must not remove twice")).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn store_identity_rebuild_preserves_retention_and_restores_triggers() {
    let db = database();
    card(&db, "a", "local:p", "p", "done", RETENTION_SECONDS + 100);
    let old = timestamp(&db, "a");
    crate::store::migrate_store_schema(&db).unwrap();
    assert_eq!(timestamp(&db, "a"), old);
    db.execute("UPDATE kanban_cards SET status='ready' WHERE id='a'", [])
        .unwrap();
    assert_eq!(timestamp(&db, "a"), None);
    db.execute("UPDATE kanban_cards SET status='done' WHERE id='a'", [])
        .unwrap();
    assert!(timestamp(&db, "a").unwrap() > old.unwrap());
}

#[test]
fn refuses_unsafe_storage_and_lossy_directory_collisions() {
    let mut db = database();
    for id in ["local:a/b", "local:a_b"] {
        card(&db, id, "local:p", "p", "done", RETENTION_SECONDS + 100);
    }
    let preview = preview(&db, unix_timestamp()).unwrap();
    let result = delete_candidates(
        &mut db,
        &preview.candidates,
        unix_timestamp(),
        |_| Ok(()),
        remove,
    )
    .unwrap();
    assert_eq!(result.skipped, 2);
    let root = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("stacks-retention-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("outside")).unwrap();
    std::os::unix::fs::symlink(root.join("outside"), root.join("link")).unwrap();
    assert!(validate_directory(&root.join("link/card")).is_err());
    fs::write(root.join("not-a-directory"), "x").unwrap();
    assert!(validate_directory(&root.join("not-a-directory")).is_err());
    fs::create_dir_all(root.join("owned/nested")).unwrap();
    fs::write(root.join("owned/nested/.git"), "gitdir: /never/remove").unwrap();
    assert!(validate_owned_storage(&root.join("owned"))
        .unwrap_err()
        .contains("Git checkout"));
    assert!(root.join("owned/nested/.git").exists());
    fs::remove_dir_all(root).unwrap();
}
