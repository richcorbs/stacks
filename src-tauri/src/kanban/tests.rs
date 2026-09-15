use super::*;
#[allow(unused_imports)]
use super::{
    cards::*, cleanup::*, domain::*, environment::*, git_effects::*, github_delivery::*, health::*,
    local_delivery::*, repository::*, sync::*,
};

use std::sync::atomic::{AtomicUsize, Ordering};

static TRACED_READS: AtomicUsize = AtomicUsize::new(0);

fn count_traced_reads(sql: &str) {
    let sql = sql.trim_start();
    if sql.starts_with("SELECT") || sql.starts_with("WITH") {
        TRACED_READS.fetch_add(1, Ordering::Relaxed);
    }
}

fn test_project(connection: &Connection, id: &str, source: &str, path: &str) {
    crate::store::migrate_store_schema(connection).unwrap();
    connection.execute(
        "INSERT OR REPLACE INTO projects (id, name, path, kanban_source, superthread_spaces, sort_order) VALUES (?1, ?1, ?2, ?3, ?4, 0)",
        params![id, path, source, (source == "superthread").then_some("Product")],
    ).unwrap();
}

fn test_superthread_snapshot(
    cards: Vec<KanbanCardSnapshot>,
    complete: bool,
) -> SuperthreadSyncSnapshot {
    SuperthreadSyncSnapshot {
        cards,
        successful_scope_ids: vec!["space".into()],
        successful_board_ids: vec!["board".into()],
        failed_scopes: Vec::new(),
        complete,
    }
}

fn superthread_card(
    id: &str,
    content: Option<&str>,
    board: &str,
    list: &str,
    in_scope: bool,
) -> KanbanCardSnapshot {
    KanbanCardSnapshot {
        id: id.into(),
        title: format!("Card {id}"),
        content: content.map(str::to_string),
        board_id: board.into(),
        board_title: board.into(),
        list_id: list.into(),
        list_title: list.into(),
        card_url: String::new(),
        assignee_names: Vec::new(),
        task_parent_id: None,
        task_parent_title: None,
        total_task_children: 0,
        in_scope: Some(in_scope),
    }
}

fn local_card(connection: &mut Connection) -> KanbanCard {
    let transaction = connection.transaction().unwrap();
    let now = unix_timestamp();
    transaction.execute(
            "INSERT INTO kanban_cards
             (id, external_provider, external_id, title, content, status, project_id, created_at, updated_at)
             VALUES ('local:test', 'local:project', '1', 'Draft', 'Old description', 'needs_refinement', 'project', ?1, ?1)",
            [now],
        ).unwrap();
    transaction.commit().unwrap();
    get_card(connection, "local:test").unwrap().unwrap()
}

fn insert_ordered_card(
    connection: &Connection,
    id: &str,
    status: &str,
    order: i64,
    updated_at: i64,
) {
    connection.execute(
            "INSERT INTO kanban_cards (id,external_provider,external_id,title,status,created_at,updated_at,sort_order,in_scope)
             VALUES (?1,'local:p',?1,?1,?2,?3,?4,?3,1)",
            params![id, status, order, updated_at],
        ).unwrap();
}

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn reorder_retry_is_idempotent_and_uses_one_timestamp() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    crate::store::migrate_store_schema(&connection).unwrap();
    for (index, id) in ["a", "hidden", "b"].iter().enumerate() {
        insert_ordered_card(&connection, id, "ready", index as i64, 10 + index as i64);
    }
    let expected = ids(&["a", "hidden", "b"]);
    let desired = ids(&["b", "hidden", "a"]);
    reorder_cards(&mut connection, "ready", &expected, &desired).unwrap();
    let first = connection
        .prepare("SELECT id,sort_order,updated_at FROM kanban_cards ORDER BY sort_order,id")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        first.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(),
        vec!["b", "hidden", "a"]
    );
    assert!(first.iter().all(|row| row.2 == first[0].2));

    reorder_cards(&mut connection, "ready", &expected, &desired).unwrap();
    let retried = connection
        .prepare("SELECT id,sort_order,updated_at FROM kanban_cards ORDER BY sort_order,id")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(retried, first);
}

#[test]
fn concurrent_reorder_conflicts_without_overwriting_first_order() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    crate::store::migrate_store_schema(&connection).unwrap();
    for (index, id) in ["a", "b", "c"].iter().enumerate() {
        insert_ordered_card(&connection, id, "ready", index as i64, 1);
    }
    let expected = ids(&["a", "b", "c"]);
    reorder_cards(&mut connection, "ready", &expected, &ids(&["b", "a", "c"])).unwrap();
    let before_conflict = connection
        .prepare("SELECT id,sort_order,updated_at FROM kanban_cards ORDER BY sort_order,id")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let error =
        reorder_cards(&mut connection, "ready", &expected, &ids(&["c", "b", "a"])).unwrap_err();
    assert!(error.starts_with(REORDER_CONFLICT_CODE));
    let after_conflict = connection
        .prepare("SELECT id,sort_order,updated_at FROM kanban_cards ORDER BY sort_order,id")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(after_conflict, before_conflict);
}

#[test]
fn reorder_rejects_invalid_payloads_without_mutation() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    insert_ordered_card(&connection, "a", "ready", 0, 1);
    insert_ordered_card(&connection, "b", "ready", 1, 2);
    insert_ordered_card(&connection, "other", "approved", 0, 3);
    insert_ordered_card(&connection, "hidden", "ready", 2, 4);
    connection
        .execute("UPDATE kanban_cards SET in_scope=0 WHERE id='hidden'", [])
        .unwrap();
    let original = connection
        .prepare("SELECT id,sort_order,updated_at FROM kanban_cards ORDER BY id")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    let cases = [
        (
            ids(&["a", "a", "b"]),
            ids(&["a", "b"]),
            "expected_card_ids contains duplicate",
        ),
        (
            ids(&["a", "b"]),
            ids(&["a", "a", "b"]),
            "card_ids contains duplicate",
        ),
        (ids(&["a", "b"]), ids(&["a"]), "exactly the same IDs"),
        (ids(&["a"]), ids(&["a"]), "incomplete"),
        (
            ids(&["a", "b", "missing"]),
            ids(&["a", "b", "missing"]),
            "Unknown reordered card ID",
        ),
        (
            ids(&["a", "b", "other"]),
            ids(&["a", "b", "other"]),
            "effective lane approved",
        ),
        (
            ids(&["a", "b", "hidden"]),
            ids(&["a", "b", "hidden"]),
            "not in scope",
        ),
    ];
    for (expected, desired, message) in cases {
        assert!(reorder_cards(&mut connection, "ready", &expected, &desired)
            .unwrap_err()
            .contains(message));
        let unchanged = connection
            .prepare("SELECT id,sort_order,updated_at FROM kanban_cards ORDER BY id")
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(unchanged, original);
    }
}

#[test]
fn reorder_uses_aggregate_parents_effective_child_lane() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    crate::store::migrate_store_schema(&connection).unwrap();
    insert_ordered_card(&connection, "parent", "ready", 0, 1);
    insert_ordered_card(&connection, "child", "needs_human", 1, 1);
    connection
        .execute(
            "UPDATE kanban_cards SET hierarchy_finalized=1 WHERE id='parent'",
            [],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE kanban_cards SET parent_id='parent' WHERE id='child'",
            [],
        )
        .unwrap();

    let error = reorder_cards(
        &mut connection,
        "ready",
        &ids(&["parent"]),
        &ids(&["parent"]),
    )
    .unwrap_err();
    assert!(error.contains("effective lane needs_human"));
    let cards = reorder_cards(
        &mut connection,
        "needs_human",
        &ids(&["parent", "child"]),
        &ids(&["child", "parent"]),
    )
    .unwrap();
    assert_eq!(
        cards
            .iter()
            .filter(|card| card.status == "needs_human")
            .map(|card| card.id.as_str())
            .collect::<Vec<_>>(),
        vec!["child", "parent"]
    );
}

#[test]
fn revision_schema_migrates_existing_cards_and_initializes_board_metadata() {
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch("CREATE TABLE kanban_cards (
            id TEXT PRIMARY KEY, external_provider TEXT NOT NULL, external_id TEXT NOT NULL,
            title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', board_id TEXT NOT NULL DEFAULT '',
            board_title TEXT NOT NULL DEFAULT '', list_id TEXT NOT NULL DEFAULT '', list_title TEXT NOT NULL DEFAULT '',
            card_url TEXT NOT NULL DEFAULT '', assignee_names TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'needs_refinement' CHECK(status IN ('needs_refinement','refining','needs_refinement_input','ready','agent_working','needs_human','approved','done')),
            completion_outcome TEXT, feature_environment INTEGER NOT NULL DEFAULT 0, delivery_operation_stage TEXT,
            delivery_error TEXT, workflow_revision INTEGER NOT NULL DEFAULT 1, project_id TEXT, workspace_id TEXT,
            parent_id TEXT, hierarchy_finalized INTEGER NOT NULL DEFAULT 0, provider_child_count INTEGER NOT NULL DEFAULT 0,
            provider_parent_title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0, in_scope INTEGER NOT NULL DEFAULT 1,
            UNIQUE(external_provider, external_id));
            INSERT INTO kanban_cards(id,external_provider,external_id,title,created_at,updated_at)
            VALUES ('legacy','local:p','1','Legacy',1,1);") .unwrap();
    migrate(&connection).unwrap();
    let record: i64 = connection
        .query_row(
            "SELECT record_revision FROM kanban_cards WHERE id='legacy'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(record, 1);
    assert_eq!(board_revision(&connection).unwrap(), 0);
}

#[test]
fn revision_bookkeeping_touches_derived_relationships_once_per_transaction() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    crate::store::migrate_store_schema(&connection).unwrap();
    connection
        .execute_batch(
            "INSERT INTO kanban_cards
            (id,external_provider,external_id,title,status,created_at,updated_at,parent_id)
            VALUES ('parent','local:p','1','Parent','needs_refinement',1,1,NULL),
                   ('child','local:p','2','Child','needs_refinement',1,1,'parent');",
        )
        .unwrap();
    let before = serialized_board_entities(&mut connection).unwrap();
    connection
        .execute(
            "UPDATE kanban_cards SET title='Changed', status='ready' WHERE id='child'",
            [],
        )
        .unwrap();
    connection.execute("INSERT INTO card_events(card_id,created_at,actor,event_type,outcome) VALUES ('child',2,'user','test','success')", []).unwrap();
    let after = serialized_board_entities(&mut connection).unwrap();
    let change = commit_board_revision(&mut connection, &before, &after)
        .unwrap()
        .unwrap();
    assert_eq!(change.board_revision, 1);
    assert_eq!(
        change
            .upserts
            .iter()
            .map(|card| card.id.as_str())
            .collect::<Vec<_>>(),
        vec!["child", "parent"]
    );
    let revisions = connection
        .prepare("SELECT id,record_revision FROM kanban_cards ORDER BY id")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(revisions, vec![("child".into(), 2), ("parent".into(), 2)]);
    assert!(commit_board_revision(&mut connection, &after, &after)
        .unwrap()
        .is_none());
    assert_eq!(board_revision(&connection).unwrap(), 1);
}

#[test]
fn revisions_report_deletion_and_card_order_has_stable_id_tie_breaker() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    crate::store::migrate_store_schema(&connection).unwrap();
    connection.execute_batch("INSERT INTO kanban_cards(id,external_provider,external_id,title,created_at,updated_at,sort_order)
            VALUES ('z','local:p','1','Z',1,1,0), ('a','local:p','2','A',1,1,0);").unwrap();
    assert_eq!(
        list_cards(&mut connection)
            .unwrap()
            .iter()
            .map(|card| card.id.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "z"]
    );
    let before = serialized_board_entities(&mut connection).unwrap();
    connection
        .execute("DELETE FROM kanban_cards WHERE id='a'", [])
        .unwrap();
    let after = serialized_board_entities(&mut connection).unwrap();
    let change = commit_board_revision(&mut connection, &before, &after)
        .unwrap()
        .unwrap();
    assert_eq!(change.removed_ids, vec!["a"]);
    assert_eq!(change.board_revision, 1);
}

fn aggregate_test_connection() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    crate::store::migrate_store_schema(&connection).unwrap();
    test_project(&connection, "one", "local", "/one");
    test_project(&connection, "two", "local", "/two");
    connection
        .execute(
            "UPDATE projects SET require_passing_ci=1, require_approval=1 WHERE id='one'",
            [],
        )
        .unwrap();
    for (id, project, external_id, status, parent_id, finalized, created, order) in [
        ("local:parent", "one", "10", "approved", None, 1, 3, 0),
        (
            "local:child",
            "one",
            "2",
            "needs_human",
            Some("local:parent"),
            0,
            1,
            1,
        ),
        ("local:other", "two", "1", "ready", None, 0, 2, 1),
    ] {
        connection.execute(
                "INSERT INTO kanban_cards (id,external_provider,external_id,title,status,project_id,parent_id,hierarchy_finalized,created_at,updated_at,sort_order)
                 VALUES (?1,?2,?3,?1,?4,?5,?6,?7,?8,?8,?9)",
                params![id, format!("local:{project}"), external_id, status, project, parent_id, finalized, created, order],
            ).unwrap();
    }
    for (card_id, environment_id, project_id) in [
        ("local:child", "environment:child", "one"),
        ("local:other", "environment:other", "two"),
    ] {
        connection.execute(
                "INSERT INTO card_environments (id,card_id,project_id,worktree_path,branch,lifecycle_state,revision,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,'feature','ready',4,1,1)",
                params![environment_id, card_id, project_id, format!("/{project_id}/worktree")],
            ).unwrap();
    }
    connection.execute("INSERT INTO card_layouts (environment_id,split_layout,focused_pane_id,layout_revision,updated_at) VALUES ('environment:child','not-json','pane:second',7,1)", []).unwrap();
    for (id, environment, order) in [
        ("pane:second", "environment:child", 2),
        ("pane:first", "environment:child", 1),
    ] {
        connection.execute("INSERT INTO card_panes (id,environment_id,role,kind,sort_order) VALUES (?1,?2,'shell','terminal',?3)", params![id, environment, order]).unwrap();
    }
    connection.execute(
            "INSERT INTO card_pull_requests (card_id,repository,number,title,url,state,draft,ci_status,review_state,has_conflicts,mergeable,updated_at)
             VALUES ('local:child','org/repo',7,'PR','url','closed',1,'failure','changes_requested',1,0,1)", [],
        ).unwrap();
    connection.execute(
            "INSERT INTO card_pull_requests (card_id,repository,number,title,url,state,draft,ci_status,review_state,has_conflicts,mergeable,updated_at)
             VALUES ('local:other','org/other',8,'PR','url','open',0,'failure','unknown',0,1,1)", [],
        ).unwrap();
    for index in 0..101 {
        for card_id in ["local:child", "local:other"] {
            connection.execute(
                    "INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,summary) VALUES (?1,5,'agent','test','success',?2)",
                    params![card_id, index.to_string()],
                ).unwrap();
        }
    }
    // Keep one card's project metadata absent to exercise pull-request policy defaults.
    connection
        .execute("DELETE FROM projects WHERE id='two'", [])
        .unwrap();
    connection
}

#[test]
fn batched_list_preserves_aggregate_ownership_order_limits_and_defaults() {
    let mut connection = aggregate_test_connection();
    let cards = list_cards(&mut connection).unwrap();
    assert_eq!(
        cards
            .iter()
            .map(|card| card.id.as_str())
            .collect::<Vec<_>>(),
        vec!["local:parent", "local:child", "local:other"]
    );

    let parent = &cards[0];
    assert_eq!(parent.status, "needs_human");
    assert_eq!(parent.child_count, 1);
    assert_eq!(
        parent
            .children
            .iter()
            .map(|child| child.id.as_str())
            .collect::<Vec<_>>(),
        vec!["local:child"]
    );
    assert_eq!(cards[1].parent.as_ref().unwrap().title, "local:parent");

    let child_environment = cards[1].environment.as_ref().unwrap();
    assert_eq!(
        child_environment.split_layout,
        serde_json::json!({"kind":"empty"})
    );
    assert_eq!(child_environment.layout_revision, 7);
    assert_eq!(
        child_environment.focused_pane_id.as_deref(),
        Some("pane:second")
    );
    assert_eq!(
        child_environment
            .panes
            .iter()
            .map(|pane| pane.id.as_str())
            .collect::<Vec<_>>(),
        vec!["pane:first", "pane:second"]
    );
    let other_environment = cards[2].environment.as_ref().unwrap();
    assert_eq!(
        other_environment.split_layout,
        serde_json::json!({"kind":"empty"})
    );
    assert_eq!(other_environment.layout_revision, 1);
    assert_eq!(other_environment.focused_pane_id, None);

    assert_eq!(
        cards[1].pull_request.as_ref().unwrap().blockers,
        vec![
            "Pull request was closed without merging",
            "Pull request is a draft",
            "Pull request has merge conflicts",
            "GitHub merge readiness is unknown or blocked",
            "CI is failing",
            "A reviewer requested changes",
            "A current approval is required",
        ]
    );
    assert_eq!(
        cards[2].pull_request.as_ref().unwrap().blockers,
        vec!["CI is failing"]
    );
    for card in [&cards[1], &cards[2]] {
        assert_eq!(card.events.len(), 100);
        assert!(card
            .events
            .windows(2)
            .all(|events| events[0].id > events[1].id));
    }
}

#[test]
fn list_read_count_is_constant_and_get_card_remains_targeted() {
    let mut connection = aggregate_test_connection();
    connection.trace(Some(count_traced_reads));
    TRACED_READS.store(0, Ordering::Relaxed);
    list_cards(&mut connection).unwrap();
    let initial_reads = TRACED_READS.load(Ordering::Relaxed);
    // Cards, environments/panes, creation and cleanup operations, PRs,
    // events, relationships, and workflow capability project context are each loaded in constant-size batches.
    assert_eq!(initial_reads, 10);
    for index in 0..25 {
        connection.execute(
                "INSERT INTO kanban_cards (id,external_provider,external_id,title,project_id,created_at,updated_at,sort_order)
                 VALUES (?1,'local:two',?2,?1,'two',10,10,10)",
                params![format!("local:extra:{index}"), (index + 100).to_string()],
            ).unwrap();
    }
    TRACED_READS.store(0, Ordering::Relaxed);
    assert_eq!(list_cards(&mut connection).unwrap().len(), 28);
    assert_eq!(TRACED_READS.load(Ordering::Relaxed), initial_reads);

    let child = get_card(&connection, "local:child").unwrap().unwrap();
    assert_eq!(child.environment.as_ref().unwrap().card_id, "local:child");
    assert_eq!(child.events.len(), 100);
    assert_eq!(child.children.len(), 0);
}

#[test]
fn initialization_builds_all_schemas_and_connection_pragmas_and_is_guarded() {
    let path = std::env::temp_dir().join(format!("stacks-kanban-{}.sqlite3", uuid::Uuid::new_v4()));
    let mut connection = Connection::open(&path).unwrap();
    configure_connection(&connection).unwrap();
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .unwrap();
    initialize_connection(&mut connection, false).unwrap();
    for table in ["kanban_cards", "projects", "project_direct_work"] {
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }
    assert_eq!(
        connection
            .pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .pragma_query_value(None, "busy_timeout", |row| row.get::<_, i64>(0))
            .unwrap(),
        5000
    );
    assert_eq!(
        connection
            .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version=3",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    drop(connection);
    let _ = std::fs::remove_file(path);

    let state = OnceLock::new();
    let calls = AtomicUsize::new(0);
    assert!(initialize_once(&state, || {
        calls.fetch_add(1, Ordering::Relaxed);
        Ok(())
    })
    .is_ok());
    assert!(initialize_once(&state, || {
        calls.fetch_add(1, Ordering::Relaxed);
        Ok(())
    })
    .is_ok());
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    let failed = OnceLock::new();
    assert_eq!(
        initialize_once(&failed, || Err("broken migration".into())).unwrap_err(),
        "broken migration"
    );
    assert_eq!(
        initialize_once(&failed, || Ok(())).unwrap_err(),
        "broken migration"
    );
}

#[test]
fn pi_lifecycle_is_idempotent_ordered_and_generation_scoped() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    local_card(&mut connection);
    connection.execute(
            "INSERT INTO card_pi_lifecycle(card_id,thread,generation,latest_event_order,latest_event_id) VALUES ('local:test','planning','generation-2',-1,'')",
            [],
        ).unwrap();

    let started = apply_pi_lifecycle_intent(
        &mut connection,
        "local:test",
        PiThread::Planning,
        PiLifecycleIntent::AgentStarted,
        "generation-2",
        "start-1",
        Some(0),
    )
    .unwrap();
    assert_eq!(started.status, CardStatus::Refining);
    assert_eq!(started.workflow_revision, 2);
    let replay = apply_pi_lifecycle_intent(
        &mut connection,
        "local:test",
        PiThread::Planning,
        PiLifecycleIntent::AgentStarted,
        "generation-2",
        "start-1",
        Some(0),
    )
    .unwrap();
    assert_eq!(replay.workflow_revision, 2);

    let settled = apply_pi_lifecycle_intent(
        &mut connection,
        "local:test",
        PiThread::Planning,
        PiLifecycleIntent::AgentSettled,
        "generation-2",
        "settled-1",
        Some(2),
    )
    .unwrap();
    assert_eq!(settled.status, CardStatus::NeedsRefinementInput);
    assert_eq!(settled.workflow_revision, 3);
    let reordered = apply_pi_lifecycle_intent(
        &mut connection,
        "local:test",
        PiThread::Planning,
        PiLifecycleIntent::AgentStarted,
        "generation-2",
        "late-start",
        Some(1),
    )
    .unwrap();
    assert_eq!(reordered.status, CardStatus::NeedsRefinementInput);
    assert_eq!(reordered.workflow_revision, 3);
    let stale = apply_pi_lifecycle_intent(
        &mut connection,
        "local:test",
        PiThread::Planning,
        PiLifecycleIntent::AgentStarted,
        "generation-1",
        "stale",
        Some(99),
    )
    .unwrap();
    assert_eq!(stale.workflow_revision, 3);

    let second_turn = apply_pi_lifecycle_intent(
        &mut connection,
        "local:test",
        PiThread::Planning,
        PiLifecycleIntent::AgentStarted,
        "generation-2",
        "start-2",
        Some(3),
    )
    .unwrap();
    assert_eq!(second_turn.status, CardStatus::Refining);
    let requested = apply_pi_lifecycle_intent(
        &mut connection,
        "local:test",
        PiThread::Planning,
        PiLifecycleIntent::UiInputRequested,
        "generation-2",
        "ui:1",
        None,
    )
    .unwrap();
    let duplicate = apply_pi_lifecycle_intent(
        &mut connection,
        "local:test",
        PiThread::Planning,
        PiLifecycleIntent::UiInputRequested,
        "generation-2",
        "ui:1",
        None,
    )
    .unwrap();
    assert_eq!(requested.workflow_revision, duplicate.workflow_revision);
    assert_eq!(duplicate.status, CardStatus::NeedsRefinementInput);
    let history_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM card_events WHERE card_id='local:test'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(history_count, 4);
}

#[test]
fn project_reassignment_allows_only_refinement_statuses_and_renumbers_cards() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();

    for (index, status) in ["needs_refinement", "refining", "needs_refinement_input"]
        .iter()
        .enumerate()
    {
        let id = format!("local:source:{}", index + 1);
        connection.execute(
                "INSERT INTO kanban_cards (id,external_provider,external_id,title,status,project_id,created_at,updated_at) VALUES (?1,'local:source',?2,?1,?3,'source',1,1)",
                params![id, (index + 10).to_string(), status],
            ).unwrap();

        let updated = set_card_project(&mut connection, &id, "destination", "Destination").unwrap();
        assert_eq!(updated.status, *status);
        assert_eq!(updated.project_id.as_deref(), Some("destination"));
        assert_eq!(updated.external_id, (index + 1).to_string());
        assert_eq!(updated.board_title, "Destination");
    }
}

#[test]
fn project_reassignment_rejects_ready_and_later_statuses_without_changes() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();

    for (index, status) in ["ready", "agent_working", "needs_human", "approved", "done"]
        .iter()
        .enumerate()
    {
        let id = format!("local:source:{status}");
        let original_number = (index + 10).to_string();
        connection.execute(
                "INSERT INTO kanban_cards (id,external_provider,external_id,title,status,project_id,created_at,updated_at) VALUES (?1,'local:source',?2,?1,?3,'source',1,1)",
                params![id, original_number, status],
            ).unwrap();

        let error =
            set_card_project(&mut connection, &id, "destination", "Destination").unwrap_err();
        assert!(error.contains("only be reassigned during refinement"));
        let unchanged = get_card(&connection, &id).unwrap().unwrap();
        assert_eq!(unchanged.status, *status);
        assert_eq!(unchanged.project_id.as_deref(), Some("source"));
        assert_eq!(unchanged.external_id, original_number);
    }
}

#[test]
fn pi_can_update_only_local_card_fields() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    local_card(&mut connection);

    let updated = update_local_card(
        &connection,
        "local:test",
        Some("Final title"),
        Some("Final description"),
    )
    .unwrap();

    assert_eq!(updated.title, "Final title");
    assert_eq!(updated.content, "Final description");
    assert_eq!(updated.status, "needs_refinement");
    assert!(update_local_card(&connection, "superthread:1", None, Some("No")).is_err());
}

#[test]
fn finishing_refinement_persists_the_brief_and_marks_the_card_ready() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    local_card(&mut connection);

    let updated = finish_local_refinement(
        &mut connection,
        "local:test",
        Some("Implementation brief"),
        "Outcome and acceptance criteria",
        None,
    )
    .unwrap();

    assert_eq!(updated.title, "Implementation brief");
    assert_eq!(updated.content, "Outcome and acceptance criteria");
    assert_eq!(updated.status, "ready");
}

#[test]
fn refinement_requires_a_nonempty_final_description() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    local_card(&mut connection);

    assert!(finish_local_refinement(&mut connection, "local:test", None, "  ", None).is_err());
    assert_eq!(
        get_card(&connection, "local:test").unwrap().unwrap().status,
        "needs_refinement"
    );
}

#[test]
fn hierarchy_migration_defaults_are_additive() {
    let connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    connection.execute(
            "INSERT INTO kanban_cards (id,external_provider,external_id,title,created_at,updated_at) VALUES ('legacy','local:p','1','Legacy',1,1)",
            [],
        ).unwrap();
    let values: (Option<String>, i64, i64, Option<String>) = connection.query_row(
            "SELECT parent_id,hierarchy_finalized,provider_child_count,provider_parent_title FROM kanban_cards WHERE id='legacy'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
    assert_eq!(values, (None, 0, 0, None));
}

#[test]
fn hierarchy_assignment_enforces_same_project_and_two_levels() {
    let connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    for (id, project) in [("parent", "p1"), ("child", "p1"), ("other", "p2")] {
        connection.execute(
                "INSERT INTO kanban_cards (id,external_provider,external_id,title,status,project_id,created_at,updated_at) VALUES (?1,'local:' || ?2,?1,?1,'needs_refinement',?2,1,1)",
                params![id, project],
            ).unwrap();
    }
    let assigned = set_card_parent(&connection, "child", Some("parent")).unwrap();
    assert_eq!(
        assigned.parent.as_ref().map(|parent| parent.id.as_str()),
        Some("parent")
    );
    assert!(set_card_parent(&connection, "other", Some("parent"))
        .unwrap_err()
        .contains("same project"));
    assert!(set_card_parent(&connection, "parent", Some("child"))
        .unwrap_err()
        .contains("cannot itself have a parent"));
    assert!(set_card_parent(&connection, "child", Some("child"))
        .unwrap_err()
        .contains("own parent"));
    assert!(set_card_parent(&connection, "child", None)
        .unwrap()
        .parent
        .is_none());
}

#[test]
fn breakdown_is_atomic_numbers_children_and_derives_parent_status() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    test_project(&connection, "p", "local", "/tmp/p");
    let parent = create_local_card(&mut connection, "p", "P", "Parent", "Draft").unwrap();
    let draft = create_local_card(&mut connection, "p", "P", "Draft child", "Draft").unwrap();
    set_card_parent(&connection, &draft.id, Some(&parent.id)).unwrap();
    let specs = vec![
        ApprovedChildSpec {
            id: Some(draft.id.clone()),
            title: "Existing".into(),
            content: "Existing brief".into(),
        },
        ApprovedChildSpec {
            id: None,
            title: "New".into(),
            content: "New brief".into(),
        },
    ];
    let aggregate = finish_local_refinement(
        &mut connection,
        &parent.id,
        Some("Aggregate"),
        "Parent brief",
        Some(&specs),
    )
    .unwrap();
    assert!(aggregate.hierarchy_finalized);
    assert_eq!(aggregate.child_count, 2);
    assert_eq!(aggregate.status, "ready");
    assert!(aggregate
        .children
        .iter()
        .all(|child| child.status == "ready"));
    assert_eq!(
        aggregate
            .children
            .iter()
            .map(|child| child.external_id.as_str())
            .collect::<Vec<_>>(),
        vec!["2", "3"]
    );

    connection
        .execute(
            "UPDATE kanban_cards SET status='done' WHERE parent_id=?1",
            [&parent.id],
        )
        .unwrap();
    assert_eq!(
        get_card(&connection, &parent.id).unwrap().unwrap().status,
        "done"
    );
    connection
        .execute(
            "UPDATE kanban_cards SET status='needs_refinement' WHERE id=?1",
            [&draft.id],
        )
        .unwrap();
    assert_eq!(
        get_card(&connection, &parent.id).unwrap().unwrap().status,
        "needs_refinement"
    );
    assert!(update_local_card(&connection, &parent.id, Some("Unlocked"), None).is_err());
    assert!(validate_card_deletion(&connection, &parent.id)
        .unwrap_err()
        .contains("children"));
}

#[test]
fn invalid_breakdown_rolls_back_parent_and_children() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    test_project(&connection, "p", "local", "/tmp/p");
    let parent = create_local_card(&mut connection, "p", "P", "Parent", "Original").unwrap();
    let draft = create_local_card(&mut connection, "p", "P", "Draft", "Original child").unwrap();
    set_card_parent(&connection, &draft.id, Some(&parent.id)).unwrap();
    let invalid = vec![ApprovedChildSpec {
        id: None,
        title: "Replacement".into(),
        content: "Brief".into(),
    }];
    assert!(
        finish_local_refinement(&mut connection, &parent.id, None, "Changed", Some(&invalid))
            .is_err()
    );
    let unchanged = get_card(&connection, &parent.id).unwrap().unwrap();
    assert_eq!(unchanged.content, "Original");
    assert!(!unchanged.hierarchy_finalized);
    assert_eq!(
        get_card(&connection, &draft.id).unwrap().unwrap().content,
        "Original child"
    );
}

#[test]
fn finishing_external_refinement_marks_the_card_ready_and_is_idempotent() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    let now = unix_timestamp();
    connection.execute(
            "INSERT INTO kanban_cards
             (id, external_provider, external_id, title, content, status, workflow_revision, created_at, updated_at)
             VALUES ('superthread:42', 'superthread', '42', 'External card', 'Saved final brief', 'needs_refinement', 4, ?1, ?1)",
            [now],
        ).unwrap();

    let updated = finish_external_refinement(&mut connection, "superthread:42").unwrap();
    assert_eq!(updated.status, "ready");
    assert_eq!(updated.workflow_revision, 5);
    assert_eq!(connection.query_row(
            "SELECT COUNT(*) FROM card_events WHERE card_id='superthread:42' AND from_status='needs_refinement' AND to_status='ready'",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(), 1);

    let retried = finish_external_refinement(&mut connection, "superthread:42").unwrap();
    assert_eq!(retried.status, "ready");
    assert_eq!(retried.workflow_revision, 5);
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM card_events WHERE card_id='superthread:42'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
}

#[test]
fn external_refinement_finishes_from_active_and_waiting_states() {
    for source in ["refining", "needs_refinement_input"] {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        connection.execute(
                "INSERT INTO kanban_cards (id,external_provider,external_id,title,status,workflow_revision,created_at,updated_at) VALUES ('superthread:42','superthread','42','External',?1,3,1,1)",
                [source],
            ).unwrap();
        let updated = finish_external_refinement(&mut connection, "superthread:42").unwrap();
        assert_eq!(updated.status, "ready");
        let recorded: String = connection
            .query_row(
                "SELECT from_status FROM card_events WHERE card_id='superthread:42'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recorded, source);
    }
}

#[test]
fn external_refinement_action_rejects_local_cards() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    local_card(&mut connection);

    let error = finish_external_refinement(&mut connection, "local:test").unwrap_err();
    assert!(error.contains("externally managed card"));
    assert_eq!(
        get_card(&connection, "local:test").unwrap().unwrap().status,
        "needs_refinement"
    );
}

#[test]
fn sync_preserves_local_workflow_state() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    test_project(
        &connection,
        "superthread-project",
        "superthread",
        "/tmp/superthread",
    );
    let snapshot = || KanbanCardSnapshot {
        id: "42".into(),
        title: "First title".into(),
        content: Some(String::new()),
        board_id: "b1".into(),
        board_title: "Roadmap".into(),
        list_id: "doing".into(),
        list_title: "Doing".into(),
        card_url: String::new(),
        assignee_names: vec!["Ada".into()],
        task_parent_id: None,
        task_parent_title: None,
        total_task_children: 0,
        in_scope: Some(true),
    };
    sync_cards(
        &mut connection,
        "superthread-project",
        test_superthread_snapshot(vec![snapshot()], false),
    )
    .unwrap();
    connection
        .execute(
            "UPDATE kanban_cards SET status = 'approved' WHERE id = 'superthread:42'",
            [],
        )
        .unwrap();
    let mut changed = snapshot();
    changed.title = "Updated upstream".into();
    let cards = sync_cards(
        &mut connection,
        "superthread-project",
        test_superthread_snapshot(vec![changed], false),
    )
    .unwrap();
    assert_eq!(cards[0].status, "approved");
    assert_eq!(cards[0].title, "Updated upstream");
    assert_eq!(cards[0].project_id.as_deref(), Some("superthread-project"));
}

#[test]
fn superthread_snapshots_reconcile_only_when_complete_and_restore_retained_rows() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    test_project(&connection, "owner", "superthread", "/tmp/owner");

    sync_cards(
        &mut connection,
        "owner",
        test_superthread_snapshot(
            vec![
                superthread_card("1", Some("Saved"), "old-board", "Doing", true),
                superthread_card("2", Some("Deleted later"), "old-board", "Doing", true),
            ],
            true,
        ),
    )
    .unwrap();
    connection
        .execute(
            "UPDATE kanban_cards SET status='approved' WHERE external_id='1'",
            [],
        )
        .unwrap();
    connection.execute("INSERT INTO card_events(card_id, created_at, actor, event_type, outcome) VALUES ('superthread:1', 1, 'user', 'test', 'success')", []).unwrap();

    // Partial absence preserves prior rows, while a fetched moved/unmanaged card is authoritative.
    sync_cards(
        &mut connection,
        "owner",
        test_superthread_snapshot(
            vec![superthread_card("1", None, "new-board", "Done", false)],
            false,
        ),
    )
    .unwrap();
    let row: (String, String, i64, String, i64) = connection.query_row(
        "SELECT content, board_id, in_scope, status, (SELECT COUNT(*) FROM card_events WHERE card_id=c.id) FROM kanban_cards c WHERE external_id='1'",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).unwrap();
    assert_eq!(
        row,
        ("Saved".into(), "new-board".into(), 0, "approved".into(), 1)
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT in_scope FROM kanban_cards WHERE external_id='2'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );

    // Empty strings clear descriptions and reappearance restores the same row without duplication.
    sync_cards(
        &mut connection,
        "owner",
        test_superthread_snapshot(
            vec![superthread_card("1", Some(""), "new-board", "Doing", true)],
            true,
        ),
    )
    .unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT content FROM kanban_cards WHERE external_id='1'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        ""
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT in_scope FROM kanban_cards WHERE external_id='2'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM kanban_cards WHERE external_provider='superthread' AND external_id='1'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);

    sync_cards(
        &mut connection,
        "owner",
        test_superthread_snapshot(Vec::new(), false),
    )
    .unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT in_scope FROM kanban_cards WHERE external_id='1'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    sync_cards(
        &mut connection,
        "owner",
        test_superthread_snapshot(Vec::new(), true),
    )
    .unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT SUM(in_scope) FROM kanban_cards WHERE external_provider='superthread'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn superthread_sync_rejects_a_mismatched_explicit_owner() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    test_project(&connection, "owner", "superthread", "/tmp/owner");
    test_project(&connection, "local", "local", "/tmp/local");
    assert!(sync_cards(
        &mut connection,
        "missing",
        test_superthread_snapshot(Vec::new(), true)
    )
    .unwrap_err()
    .contains("not found"));
    assert!(sync_cards(
        &mut connection,
        "local",
        test_superthread_snapshot(Vec::new(), true)
    )
    .unwrap_err()
    .contains("not the configured"));
    connection
        .execute(
            "UPDATE projects SET superthread_spaces=NULL WHERE id='owner'",
            [],
        )
        .unwrap();
    assert!(sync_cards(
        &mut connection,
        "owner",
        test_superthread_snapshot(Vec::new(), true)
    )
    .unwrap_err()
    .contains("Configure Superthread spaces"));
}

#[test]
fn superthread_sync_persists_parent_references_and_provider_counts() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    test_project(
        &connection,
        "superthread-project",
        "superthread",
        "/tmp/superthread",
    );
    let snapshot =
        |id: &str, title: &str, parent: Option<(&str, &str)>, count| KanbanCardSnapshot {
            id: id.into(),
            title: title.into(),
            content: Some(String::new()),
            board_id: "b".into(),
            board_title: "Board".into(),
            list_id: "l".into(),
            list_title: "List".into(),
            card_url: String::new(),
            assignee_names: Vec::new(),
            task_parent_id: parent.map(|value| value.0.into()),
            task_parent_title: parent.map(|value| value.1.into()),
            total_task_children: count,
            in_scope: Some(true),
        };
    let cards = sync_cards(
        &mut connection,
        "superthread-project",
        test_superthread_snapshot(
            vec![
                snapshot("10", "Parent", None, 1),
                snapshot("11", "Child", Some(("10", "Parent")), 0),
            ],
            false,
        ),
    )
    .unwrap();
    let parent = cards.iter().find(|card| card.external_id == "10").unwrap();
    let child = cards.iter().find(|card| card.external_id == "11").unwrap();
    assert_eq!(parent.child_count, 1);
    assert!(parent.hierarchy_finalized);
    assert_eq!(parent.children[0].id, child.id);
    assert_eq!(
        child.parent.as_ref().map(|value| value.id.as_str()),
        Some("superthread:10")
    );
}

#[test]
fn finishing_refinement_records_each_actual_in_progress_source() {
    for source in ["needs_refinement", "refining", "needs_refinement_input"] {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        local_card(&mut connection);
        connection
            .execute(
                "UPDATE kanban_cards SET status=?1 WHERE id='local:test'",
                [source],
            )
            .unwrap();

        let updated = finish_local_refinement(
            &mut connection,
            "local:test",
            None,
            "Approved brief",
            None,
        )
        .unwrap();
        assert_eq!(updated.status, "ready");
        let recorded: String = connection.query_row(
            "SELECT from_status FROM card_events WHERE card_id='local:test' ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(recorded, source);
    }
}

#[test]
fn blocks_project_deletion_while_cards_are_active() {
    let connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    test_project(&connection, "local-owner", "local", "/tmp/local");
    connection.execute(
        "INSERT INTO kanban_cards (id, external_provider, external_id, title, status, project_id, created_at, updated_at) VALUES ('local:active', 'local:local-owner', '1', 'Active', 'ready', 'local-owner', 1, 1)", [],
    ).unwrap();
    assert!(validate_project_deletion(&connection, "local-owner").unwrap_err().contains("active card"));
    connection.execute(
        "UPDATE kanban_cards SET status='done', completion_outcome='merged' WHERE id='local:active'", [],
    ).unwrap();
    assert_eq!(validate_project_deletion(&connection, "local-owner").unwrap(), vec!["local:active"]);
}

#[test]
fn imports_cards_without_disconnected_cleaned_tombstones() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='kanban_cleaned_cards'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    test_project(
        &connection,
        "superthread-project",
        "superthread",
        "/tmp/superthread",
    );
    let cards = sync_cards(
        &mut connection,
        "superthread-project",
        test_superthread_snapshot(
            vec![KanbanCardSnapshot {
                id: "42".into(),
                title: "Already cleaned".into(),
                content: Some(String::new()),
                board_id: "b1".into(),
                board_title: "Roadmap".into(),
                list_id: "doing".into(),
                list_title: "Doing".into(),
                card_url: String::new(),
                assignee_names: Vec::new(),
                task_parent_id: None,
                task_parent_title: None,
                total_task_children: 0,
                in_scope: Some(true),
            }],
            false,
        ),
    )
    .unwrap();
    assert_eq!(cards.len(), 1);
}

#[test]
fn local_card_numbers_are_monotonic_per_project() {
    let connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    assert_eq!(next_local_card_number(&connection, "one").unwrap(), 1);
    assert_eq!(next_local_card_number(&connection, "one").unwrap(), 2);
    assert_eq!(next_local_card_number(&connection, "two").unwrap(), 1);
}

#[test]
fn local_card_creation_assigns_project_status_description_number_and_order() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();

    let first =
        create_local_card(&mut connection, "p1", "Project One", " First card ", "").unwrap();
    let second = create_local_card(
        &mut connection,
        "p1",
        "Project One",
        "Second card",
        " Details ",
    )
    .unwrap();

    assert_eq!(first.external_id, "1");
    assert_eq!(first.status, "needs_refinement");
    assert_eq!(first.project_id.as_deref(), Some("p1"));
    assert_eq!(first.board_title, "Project One");
    assert_eq!(first.content, "");
    assert_eq!(first.sort_order, 0);
    assert_eq!(second.external_id, "2");
    assert_eq!(second.content, "Details");
    assert_eq!(second.sort_order, 1);
}

#[test]
fn create_card_tool_is_eligible_only_for_local_projects() {
    assert!(is_local_kanban_source("local"));
    assert!(!is_local_kanban_source("superthread"));
}

fn environment_with_layout(connection: &mut Connection, layout_revision: i64) {
    local_card(connection);
    connection.execute(
            "INSERT INTO card_environments (id, card_id, project_id, worktree_path, branch, lifecycle_state, revision, created_at, updated_at)
             VALUES ('environment:test', 'local:test', 'project', '/repo-card-1', 'stacks/card-1', 'ready', 4, 1, 11)", [],
        ).unwrap();
    connection.execute(
            "INSERT INTO card_panes (id, environment_id, role, kind, sort_order) VALUES ('pane:old', 'environment:test', 'shell', 'terminal', 0)", [],
        ).unwrap();
    connection.execute(
            "INSERT INTO card_layouts (environment_id, split_layout, focused_pane_id, layout_revision, updated_at)
             VALUES ('environment:test', '{\"kind\":\"leaf\",\"terminalId\":\"pane:old\"}', 'pane:old', ?1, 1)",
            [layout_revision],
        ).unwrap();
}

#[test]
fn layout_revision_migration_preserves_existing_layout_and_panes() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    environment_with_layout(&mut connection, 7);
    connection
        .execute("ALTER TABLE card_layouts DROP COLUMN layout_revision", [])
        .unwrap();

    migrate(&connection).unwrap();

    let layout: (String, Option<String>, i64) = connection.query_row(
            "SELECT split_layout, focused_pane_id, layout_revision FROM card_layouts WHERE environment_id='environment:test'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
    assert!(layout.0.contains("pane:old"));
    assert_eq!(layout.1.as_deref(), Some("pane:old"));
    assert_eq!(layout.2, 1);
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM card_panes WHERE id='pane:old'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn layout_saves_are_atomic_and_independent_from_environment_revisions() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    environment_with_layout(&mut connection, 2);

    save_environment_layout(
            &mut connection,
            "local:test",
            serde_json::json!({"kind":"split","direction":"row","children":[{"kind":"leaf","terminalId":"pane:a"},{"kind":"leaf","terminalId":"pane:b"}]}),
            Some("pane:b".into()),
            vec![
                CardPane { id: "pane:a".into(), role: "shell".into(), kind: "terminal".into(), command: None, sort_order: 0 },
                CardPane { id: "pane:b".into(), role: "shell".into(), kind: "terminal".into(), command: None, sort_order: 1 },
            ],
            2,
        ).unwrap();

    let environment_state: (i64, i64) = connection
        .query_row(
            "SELECT revision, updated_at FROM card_environments WHERE id='environment:test'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(environment_state, (4, 11));
    let loaded = get_card(&connection, "local:test")
        .unwrap()
        .unwrap()
        .environment
        .unwrap();
    assert_eq!(loaded.revision, 4);
    assert_eq!(loaded.layout_revision, 3);
    assert_eq!(loaded.focused_pane_id.as_deref(), Some("pane:b"));
    assert_eq!(
        loaded
            .panes
            .iter()
            .filter(|pane| pane.role == "shell")
            .count(),
        2
    );

    // A repository writer advances only the environment revision. The current
    // layout revision remains valid, and a focus-only save leaves it untouched.
    assert_eq!(connection.execute(
            "UPDATE card_environments SET revision=revision+1 WHERE id='environment:test' AND revision=4",
            [],
        ).unwrap(), 1);
    save_environment_layout(
        &mut connection,
        "local:test",
        loaded.split_layout.clone(),
        Some("pane:a".into()),
        loaded.panes.clone(),
        3,
    )
    .unwrap();
    let revisions: (i64, i64) = connection.query_row(
            "SELECT e.revision, l.layout_revision FROM card_environments e JOIN card_layouts l ON l.environment_id=e.id WHERE e.id='environment:test'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
    assert_eq!(revisions, (5, 4));

    let before_stale: (String, Option<String>, i64) = connection.query_row(
            "SELECT split_layout, focused_pane_id, layout_revision FROM card_layouts WHERE environment_id='environment:test'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
    let stale_error = save_environment_layout(
        &mut connection,
        "local:test",
        serde_json::json!({"kind":"leaf","terminalId":"pane:stale"}),
        Some("pane:stale".into()),
        vec![CardPane {
            id: "pane:stale".into(),
            role: "shell".into(),
            kind: "terminal".into(),
            command: None,
            sort_order: 0,
        }],
        3,
    )
    .unwrap_err();
    assert!(stale_error.contains("Card layout changed; reload"));
    let after_stale: (String, Option<String>, i64) = connection.query_row(
            "SELECT split_layout, focused_pane_id, layout_revision FROM card_layouts WHERE environment_id='environment:test'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
    assert_eq!(after_stale, before_stale);
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM card_panes WHERE environment_id='environment:test' AND role='shell'", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM card_panes WHERE id='pane:stale'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );

    // Layout writes do not make a current repository revision stale.
    assert_eq!(connection.execute(
            "UPDATE card_environments SET lifecycle_state='cleanup_pending', revision=revision+1 WHERE id='environment:test' AND revision=5",
            [],
        ).unwrap(), 1);
}

#[test]
fn environment_aggregate_restores_layout_and_panes() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    local_card(&mut connection);
    connection.execute(
            "INSERT INTO card_environments (id, card_id, project_id, worktree_path, branch, lifecycle_state, revision, created_at, updated_at)
             VALUES ('environment:test', 'local:test', 'project', '/repo-card-1', 'stacks/card-1', 'ready', 4, 1, 1)", [],
        ).unwrap();
    connection.execute(
            "INSERT INTO card_panes (id, environment_id, role, kind, sort_order) VALUES ('pane:shell', 'environment:test', 'shell', 'terminal', 0)", [],
        ).unwrap();
    connection.execute(
            "INSERT INTO card_layouts (environment_id, split_layout, focused_pane_id, updated_at)
             VALUES ('environment:test', '{\"kind\":\"leaf\",\"terminalId\":\"pane:shell\"}', 'pane:shell', 1)", [],
        ).unwrap();
    let environment = get_card(&connection, "local:test")
        .unwrap()
        .unwrap()
        .environment
        .unwrap();
    assert_eq!(environment.worktree_path, "/repo-card-1");
    assert_eq!(environment.revision, 4);
    assert_eq!(environment.layout_revision, 1);
    assert_eq!(environment.panes[0].id, "pane:shell");
    assert_eq!(environment.split_layout["terminalId"], "pane:shell");
}

#[test]
fn card_runtime_owns_pi_session_metadata() {
    let owner = card_pi_session("kanban-card:superthread:42:planning")
        .unwrap()
        .unwrap();
    assert_eq!(owner.card_id, "superthread:42");
    assert_eq!(owner.thread, "planning");
    assert!(owner
        .directory
        .ends_with("superthread_42/pi-sessions/planning"));
    assert!(card_pi_session("workspace:123").unwrap().is_none());
}

#[test]
fn migrates_legacy_merged_cards_to_done_with_merged_outcome() {
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch("CREATE TABLE kanban_cards (
            id TEXT PRIMARY KEY, external_provider TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '', board_id TEXT NOT NULL DEFAULT '', board_title TEXT NOT NULL DEFAULT '',
            list_id TEXT NOT NULL DEFAULT '', list_title TEXT NOT NULL DEFAULT '', card_url TEXT NOT NULL DEFAULT '',
            assignee_names TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL CHECK(status IN ('needs_refinement','ready','agent_working','needs_human','approved','merged')),
            workflow_revision INTEGER NOT NULL DEFAULT 1, project_id TEXT, workspace_id TEXT, created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, in_scope INTEGER NOT NULL DEFAULT 1,
            UNIQUE(external_provider, external_id));
            CREATE TABLE card_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, created_at INTEGER NOT NULL,
                actor TEXT NOT NULL, event_type TEXT NOT NULL, outcome TEXT NOT NULL,
                from_status TEXT, to_status TEXT, summary TEXT, error_code TEXT, error_detail TEXT
            );
            INSERT INTO kanban_cards (id,external_provider,external_id,title,status,created_at,updated_at)
            VALUES ('legacy','local:p','1','Legacy','merged',1,1);
            INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,from_status,to_status)
            VALUES ('legacy',1,'user','merge','success','approved','merged');").unwrap();
    migrate(&connection).unwrap();
    let result: (String, Option<String>) = connection
        .query_row(
            "SELECT status,completion_outcome FROM kanban_cards WHERE id='legacy'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(result, ("done".to_string(), Some("merged".to_string())));
    let event_statuses: (Option<CardStatus>, Option<CardStatus>) = connection
        .query_row(
            "SELECT from_status,to_status FROM card_events WHERE card_id='legacy'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        event_statuses,
        (Some(CardStatus::Approved), Some(CardStatus::Done))
    );
}

#[test]
fn migrates_current_status_constraint_without_losing_rows_or_relationships() {
    let connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    connection.execute("INSERT INTO kanban_cards (id,external_provider,external_id,title,status,feature_environment,delivery_operation_stage,delivery_error,workflow_revision,project_id,workspace_id,created_at,updated_at,sort_order,in_scope) VALUES ('kept','local:p','9','Kept','needs_refinement',1,'stage','detail',7,'p','w',1,2,3,1)", []).unwrap();
    connection.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome) VALUES ('kept',1,'user','test','success')", []).unwrap();
    connection.execute("INSERT INTO card_environments (id,card_id,project_id,worktree_path,created_at,updated_at) VALUES ('env','kept','p','/tmp/work',1,1)", []).unwrap();
    connection.execute("INSERT INTO card_pull_requests (card_id,repository,number,title,url,state,updated_at) VALUES ('kept','o/r',9,'PR','url','open',1)", []).unwrap();
    connection.execute_batch(
            "PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; BEGIN;
             ALTER TABLE kanban_cards RENAME TO cards_expanded;
             CREATE TABLE kanban_cards (
                id TEXT PRIMARY KEY, external_provider TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '', board_id TEXT NOT NULL DEFAULT '', board_title TEXT NOT NULL DEFAULT '',
                list_id TEXT NOT NULL DEFAULT '', list_title TEXT NOT NULL DEFAULT '', card_url TEXT NOT NULL DEFAULT '', assignee_names TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'needs_refinement' CHECK(status IN ('needs_refinement','ready','agent_working','needs_human','approved','done')),
                completion_outcome TEXT CHECK(completion_outcome IN ('merged','closed')), feature_environment INTEGER NOT NULL DEFAULT 0,
                delivery_operation_stage TEXT, delivery_error TEXT, workflow_revision INTEGER NOT NULL DEFAULT 1, project_id TEXT, workspace_id TEXT,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, in_scope INTEGER NOT NULL DEFAULT 1,
                UNIQUE(external_provider,external_id));
             INSERT INTO kanban_cards (id,external_provider,external_id,title,content,board_id,board_title,list_id,list_title,card_url,assignee_names,status,completion_outcome,feature_environment,delivery_operation_stage,delivery_error,workflow_revision,project_id,workspace_id,created_at,updated_at,sort_order,in_scope)
             SELECT id,external_provider,external_id,title,content,board_id,board_title,list_id,list_title,card_url,assignee_names,status,completion_outcome,feature_environment,delivery_operation_stage,delivery_error,workflow_revision,project_id,workspace_id,created_at,updated_at,sort_order,in_scope FROM cards_expanded;
             DROP TABLE cards_expanded; COMMIT;
             PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;"
        ).unwrap();

    migrate(&connection).unwrap();
    let kept: (String, i64, Option<String>, Option<String>, i64) = connection.query_row(
            "SELECT status,feature_environment,delivery_operation_stage,delivery_error,workflow_revision FROM kanban_cards WHERE id='kept'",
            [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
        ).unwrap();
    assert_eq!(
        kept,
        (
            "needs_refinement".into(),
            1,
            Some("stage".into()),
            Some("detail".into()),
            7
        )
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM card_events WHERE card_id='kept'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM card_environments WHERE card_id='kept'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM card_pull_requests WHERE card_id='kept'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    connection
        .execute(
            "UPDATE kanban_cards SET status='refining' WHERE id='kept'",
            [],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE kanban_cards SET status='needs_refinement_input' WHERE id='kept'",
            [],
        )
        .unwrap();
}

#[test]
fn feature_environment_prefix_is_applied_exactly_once() {
    assert_eq!(feature_environment_title("Title"), "[FE] Title");
    assert_eq!(feature_environment_title("[FE] Title"), "[FE] Title");
    assert_eq!(feature_environment_title("[FE] [FE] Title"), "[FE] Title");
}

#[test]
fn environment_creation_migration_persists_one_active_operation_per_card() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    let card = local_card(&mut connection);
    let insert = |connection: &Connection, id: &str| {
        connection.execute(
            "INSERT INTO environment_creation_operations (id,card_id,project_id,repository_id,expected_workflow_revision,target_checkout_path,target_branch,observed_target_revision,setup_command,phase,result_path,pre_worktrees,pre_branches,created_at,updated_at) VALUES (?1,?2,'project','repo',1,'/target','main','tip','setup','prepared','/result','[]','{}',1,1)",
            params![id,card.id],
        )
    };
    assert_eq!(insert(&connection, "operation:1").unwrap(), 1);
    assert!(insert(&connection, "operation:2").is_err());
    let operation = load_creation_operation(&connection, &card.id)
        .unwrap()
        .unwrap();
    assert_eq!(operation.phase, "prepared");
    assert_eq!(operation.revision, 1);
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

fn merge_repository() -> (PathBuf, PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "stacks-card-merge-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let target = root.join("target");
    let source = root.join("source");
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

fn upstream_merge_repository() -> (PathBuf, PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "stacks-target-merge-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let remote = root.join("remote.git");
    let target = root.join("target");
    let source = root.join("source");
    fs::create_dir_all(&root).unwrap();
    git_ok(&root, &["init", "--bare", remote.to_str().unwrap()]);
    git_ok(
        &root,
        &["clone", remote.to_str().unwrap(), target.to_str().unwrap()],
    );
    git_ok(&target, &["config", "user.email", "stacks@example.com"]);
    git_ok(&target, &["config", "user.name", "Stacks Tests"]);
    git_ok(&target, &["checkout", "-b", "main"]);
    fs::write(target.join("base.txt"), "base\n").unwrap();
    git_ok(&target, &["add", "."]);
    git_ok(&target, &["commit", "-m", "base"]);
    git_ok(&target, &["push", "-u", "origin", "main"]);
    git_ok(
        &target,
        &["worktree", "add", "-b", "feature", source.to_str().unwrap()],
    );
    git_ok(&source, &["config", "user.email", "stacks@example.com"]);
    git_ok(&source, &["config", "user.name", "Stacks Tests"]);
    fs::write(source.join("feature.txt"), "feature\n").unwrap();
    git_ok(&source, &["add", "."]);
    git_ok(&source, &["commit", "-m", "feature"]);
    (root, target, source)
}

fn target_merge_connection(source: &Path, target: &Path, status: &str) -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    test_project(&connection, "p", "local", target.to_str().unwrap());
    let now = unix_timestamp();
    connection.execute("INSERT INTO kanban_cards (id,external_provider,external_id,title,status,workflow_revision,project_id,created_at,updated_at) VALUES ('local:target-merge','local:p','1','Target merge',?1,4,'p',?2,?2)", params![status,now]).unwrap();
    let repository = repository_identity(target.to_str().unwrap()).unwrap();
    let source_tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    let target_tip = git_output(target.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    connection.execute("INSERT INTO card_environments (id,card_id,project_id,worktree_path,branch,repository_id,target_checkout_path,target_branch,source_revision,target_revision,lifecycle_state,revision,created_at,updated_at) VALUES ('target-merge-e','local:target-merge','p',?1,'feature',?2,?3,'main',?4,?5,'ready',2,?6,?6)", params![source.to_str().unwrap(),repository,target.to_str().unwrap(),source_tip,target_tip,now]).unwrap();
    connection
}

fn advance_target(target: &Path, contents: &str) {
    fs::write(target.join("target.txt"), contents).unwrap();
    git_ok(target, &["add", "."]);
    git_ok(target, &["commit", "-m", "advance target"]);
    git_ok(target, &["push", "origin", "main"]);
}

fn approval_connection(source: &Path, target: &Path) -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    test_project(&connection, "p", "local", target.to_str().unwrap());
    let now = unix_timestamp();
    connection.execute("INSERT INTO kanban_cards (id, external_provider, external_id, title, status, workflow_revision, project_id, created_at, updated_at) VALUES ('local:approve', 'local:p', '1', 'Approve', 'needs_human', 5, 'p', ?1, ?1)", [now]).unwrap();
    let repository = repository_identity(target.to_str().unwrap()).unwrap();
    let source_tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    let target_tip = git_output(target.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    connection.execute("INSERT INTO card_environments (id, card_id, project_id, worktree_path, branch, repository_id, target_checkout_path, target_branch, source_revision, target_revision, lifecycle_state, revision, created_at, updated_at) VALUES ('approve-e', 'local:approve', 'p', ?1, 'feature', ?2, ?3, 'main', ?4, ?5, 'ready', 2, ?6, ?6)", params![source.to_str().unwrap(), repository, target.to_str().unwrap(), source_tip, target_tip, now]).unwrap();
    connection
}

#[test]
fn approval_accepts_clean_committed_work_and_records_transition() {
    let (root, target, source) = merge_repository();
    let mut connection = approval_connection(&source, &target);
    let result =
        approve_and_commit_with_failure_record(&mut connection, "local:approve", 5, 2, false)
            .unwrap();
    assert_eq!(result.card.status, "approved");
    assert_eq!(result.card.workflow_revision, 6);
    assert_eq!(result.card.environment.unwrap().revision, 3);
    let event: (String, String) = connection.query_row(
            "SELECT event_type, outcome FROM card_events WHERE card_id='local:approve' ORDER BY id DESC LIMIT 1",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
    assert_eq!(event, ("approve_and_commit".into(), "success".into()));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn approved_card_can_be_shipped_again_after_its_source_revision_changes() {
    let (root, target, source) = merge_repository();
    let mut connection = approval_connection(&source, &target);
    let first = approve_and_commit(&mut connection, "local:approve", 5, 2, false).unwrap();
    assert_eq!(first.card.status, "approved");

    fs::write(source.join("after-ship.txt"), "follow-up\n").unwrap();
    git_ok(&source, &["add", "."]);
    git_ok(&source, &["commit", "-m", "follow-up after ship"]);
    let changed_tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    let merge_error = merge_card(&mut connection, "local:approve", 6, 3).unwrap_err();
    assert!(
        merge_error.to_lowercase().contains("ship it again"),
        "{merge_error}"
    );

    let refreshed = approve_and_commit(&mut connection, "local:approve", 6, 3, false).unwrap();
    assert_eq!(refreshed.card.status, "approved");
    assert_eq!(refreshed.card.workflow_revision, 6);
    assert_eq!(
        refreshed
            .card
            .environment
            .as_ref()
            .unwrap()
            .source_revision
            .as_deref(),
        Some(changed_tip.as_str())
    );
    assert!(refreshed.message.contains("re-verified"));
    assert_eq!(
        merge_card(&mut connection, "local:approve", 6, 4)
            .unwrap()
            .card
            .status,
        "done"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn approval_reconciles_the_expected_agent_status_cycle() {
    for (status, revision) in [("agent_working", 6), ("needs_human", 7)] {
        let (root, target, source) = merge_repository();
        let mut connection = approval_connection(&source, &target);
        connection
            .execute(
                "UPDATE kanban_cards SET status=?1, workflow_revision=?2 WHERE id='local:approve'",
                params![status, revision],
            )
            .unwrap();
        let result = approve_and_commit(&mut connection, "local:approve", 5, 2, false).unwrap();
        assert_eq!(result.card.status, "approved");
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn approval_reports_modified_staged_untracked_and_deleted_files() {
    enum Dirty {
        Modified,
        Staged,
        Untracked,
        Deleted,
    }
    for (dirty, expected_counts) in [
        (Dirty::Modified, "0 new, 1 modified, 0 deleted"),
        (Dirty::Staged, "0 new, 1 modified, 0 deleted"),
        (Dirty::Untracked, "1 new, 0 modified, 0 deleted"),
        (Dirty::Deleted, "0 new, 0 modified, 1 deleted"),
    ] {
        let (root, target, source) = merge_repository();
        let mut connection = approval_connection(&source, &target);
        match dirty {
            Dirty::Modified => fs::write(source.join("feature.txt"), "changed\n").unwrap(),
            Dirty::Staged => {
                fs::write(source.join("feature.txt"), "staged\n").unwrap();
                git_ok(&source, &["add", "feature.txt"]);
            }
            Dirty::Untracked => fs::write(source.join("new.txt"), "new\n").unwrap(),
            Dirty::Deleted => fs::remove_file(source.join("feature.txt")).unwrap(),
        }
        let detail =
            approve_and_commit_with_failure_record(&mut connection, "local:approve", 5, 2, false)
                .unwrap_err();
        assert!(detail.contains("worktree is not clean"), "{detail}");
        assert!(detail.contains(expected_counts), "{detail}");
        assert!(detail.contains("files remain"), "{detail}");
        assert_eq!(
            get_card(&connection, "local:approve")
                .unwrap()
                .unwrap()
                .status,
            "needs_human"
        );
        let failure: (String, String) = connection.query_row(
                "SELECT outcome, error_detail FROM card_events WHERE card_id='local:approve' ORDER BY id DESC LIMIT 1",
                [], |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap();
        assert_eq!(failure.0, "failure");
        assert!(failure.1.contains("files remain"));
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn approval_rejects_wrong_branch_and_stale_revisions() {
    let (root, target, source) = merge_repository();
    let mut connection = approval_connection(&source, &target);
    connection
        .execute(
            "UPDATE card_environments SET branch='unexpected' WHERE card_id='local:approve'",
            [],
        )
        .unwrap();
    assert!(
        approve_and_commit(&mut connection, "local:approve", 5, 2, false)
            .unwrap_err()
            .contains("expected unexpected")
    );
    connection
        .execute(
            "UPDATE card_environments SET branch='feature' WHERE card_id='local:approve'",
            [],
        )
        .unwrap();
    assert!(
        approve_and_commit(&mut connection, "local:approve", 4, 2, false)
            .unwrap_err()
            .contains("Card changed")
    );
    assert!(
        approve_and_commit(&mut connection, "local:approve", 5, 1, false)
            .unwrap_err()
            .contains("environment changed")
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn merge_creates_explicit_commit_and_transitions_only_after_verification() {
    let (root, target, source) = merge_repository();
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    crate::store::migrate_store_schema(&connection).unwrap();
    let now = unix_timestamp();
    connection.execute("INSERT INTO projects (id,name,path,kanban_source,delivery_workflow,target_branch,github_merge_strategy,require_passing_ci,require_approval) VALUES ('p','Project',?1,'local','local_merge','main','merge',1,0)", [target.to_str().unwrap()]).unwrap();
    connection.execute("INSERT INTO kanban_cards (id, external_provider, external_id, title, status, workflow_revision, project_id, created_at, updated_at) VALUES ('local:merge', 'local:p', '1', 'Merge', 'approved', 3, 'p', ?1, ?1)", [now]).unwrap();
    let repository = repository_identity(target.to_str().unwrap()).unwrap();
    let source_tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    let target_tip = git_output(target.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    connection.execute("INSERT INTO card_environments (id, card_id, project_id, worktree_path, branch, repository_id, target_checkout_path, target_branch, source_revision, target_revision, revision, created_at, updated_at) VALUES ('e', 'local:merge', 'p', ?1, 'feature', ?2, ?3, 'main', ?4, ?5, 2, ?6, ?6)", params![source.to_str().unwrap(), repository, target.to_str().unwrap(), source_tip, target_tip, now]).unwrap();
    let result = merge_card(&mut connection, "local:merge", 3, 2).unwrap();
    assert_eq!(result.card.status, "done");
    assert_eq!(
        result.card.completion_outcome,
        Some(CompletionOutcome::Merged)
    );
    assert_eq!(
        git_output(
            target.to_str().unwrap(),
            &["rev-list", "--parents", "-n", "1", "HEAD"]
        )
        .unwrap()
        .split_whitespace()
        .count(),
        3
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn target_merge_migration_marks_existing_fetch_operations_remote() {
    let (root, target, source) = upstream_merge_repository();
    let connection = target_merge_connection(&source, &target, "needs_human");
    connection
        .execute_batch(
            "DROP TABLE card_target_merge_operations;
                 CREATE TABLE card_target_merge_operations (
                    id TEXT PRIMARY KEY,
                    card_id TEXT NOT NULL UNIQUE REFERENCES kanban_cards(id) ON DELETE CASCADE,
                    environment_id TEXT NOT NULL,
                    workflow_revision INTEGER NOT NULL,
                    environment_revision INTEGER NOT NULL,
                    initial_status TEXT NOT NULL,
                    repository_id TEXT NOT NULL,
                    source_path TEXT NOT NULL,
                    source_branch TEXT NOT NULL,
                    target_branch TEXT NOT NULL,
                    upstream_remote TEXT NOT NULL,
                    upstream_merge_ref TEXT NOT NULL,
                    source_revision TEXT NOT NULL,
                    target_revision TEXT NOT NULL,
                    phase TEXT NOT NULL,
                    conflict_paths TEXT NOT NULL DEFAULT '[]',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                 );
                 DELETE FROM schema_migrations WHERE version=72;",
        )
        .unwrap();
    let repository = repository_identity(target.to_str().unwrap()).unwrap();
    let source_tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    let target_tip = git_output(target.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    connection.execute(
            "INSERT INTO card_target_merge_operations (id,card_id,environment_id,workflow_revision,environment_revision,initial_status,repository_id,source_path,source_branch,target_branch,upstream_remote,upstream_merge_ref,source_revision,target_revision,phase,conflict_paths,created_at,updated_at) VALUES ('old-op','local:target-merge','target-merge-e',4,2,'needs_human',?1,?2,'feature','main','origin','refs/heads/main',?3,?4,'conflicted','[]',1,1)",
            params![repository,source.to_str().unwrap(),source_tip,target_tip],
        ).unwrap();

    migrate(&connection).unwrap();
    let operation = load_target_merge_operation(&connection, "local:target-merge")
        .unwrap()
        .unwrap();
    assert_eq!(operation.target_source, "remote");
    let migrated: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version=72",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(migrated, 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn target_merge_prefers_upstream_over_a_newer_local_tip() {
    for initial_status in ["needs_human", "approved"] {
        let (root, target, source) = upstream_merge_repository();
        let mut connection = target_merge_connection(&source, &target, initial_status);
        advance_target(&target, "remote target change\n");
        let remote_tip = git_output(target.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        git_ok(
            &target,
            &["remote", "rename", "origin", "configured-upstream"],
        );
        git_ok(&target, &["reset", "--hard", "HEAD^"]);
        fs::write(target.join("local-only.txt"), "not pushed\n").unwrap();
        git_ok(&target, &["add", "."]);
        git_ok(&target, &["commit", "-m", "newer local target"]);
        let local_tip = git_output(target.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        assert_ne!(remote_tip, local_tip);

        let prepared = prepare_target_merge(&mut connection, "local:target-merge", 4, 2).unwrap();
        assert_eq!(prepared.state, "merged");
        let operation_id = prepared.operation_id.unwrap();
        let operation = load_target_merge_operation(&connection, "local:target-merge")
            .unwrap()
            .unwrap();
        assert_eq!(operation.target_source, "remote");
        assert_eq!(operation.target_revision, remote_tip);
        let result =
            finalize_target_merge(&mut connection, "local:target-merge", &operation_id).unwrap();
        assert_eq!(result.message, "Successfully merged with remote main");
        assert_eq!(result.card.status, "needs_human");
        assert_eq!(
            result.card.workflow_revision,
            if initial_status == "approved" { 5 } else { 4 }
        );
        assert_eq!(result.card.environment.unwrap().revision, 3);
        assert!(!source.join("local-only.txt").exists());
        assert_eq!(
            git_output(
                source.to_str().unwrap(),
                &["rev-list", "--parents", "-n", "1", "HEAD"]
            )
            .unwrap()
            .split_whitespace()
            .count(),
            3
        );
        let summary: String = connection.query_row(
                "SELECT summary FROM card_events WHERE card_id='local:target-merge' ORDER BY id DESC LIMIT 1",
                [], |row| row.get(0),
            ).unwrap();
        assert!(summary.contains("remote target branch main"), "{summary}");
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn target_merge_noop_preserves_status_and_creates_no_commit() {
    let (root, target, source) = upstream_merge_repository();
    let mut connection = target_merge_connection(&source, &target, "approved");
    let before = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    let result = prepare_target_merge(&mut connection, "local:target-merge", 4, 2).unwrap();
    assert_eq!(result.state, "noop");
    assert!(result.idempotent);
    assert_eq!(result.message, "Already up to date with remote main");
    assert_eq!(result.card.status, "approved");
    let summary: String = connection.query_row(
            "SELECT summary FROM card_events WHERE card_id='local:target-merge' ORDER BY id DESC LIMIT 1",
            [], |row| row.get(0),
        ).unwrap();
    assert!(summary.contains("remote target branch main"), "{summary}");
    assert_eq!(
        git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap(),
        before
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn target_merge_rejects_dirty_source_and_falls_back_without_upstream() {
    let (root, target, source) = upstream_merge_repository();
    let mut connection = target_merge_connection(&source, &target, "needs_human");
    let before = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    fs::write(source.join("dirty.txt"), "dirty\n").unwrap();
    assert!(
        prepare_target_merge(&mut connection, "local:target-merge", 4, 2)
            .unwrap_err()
            .contains("modified or untracked")
    );
    fs::remove_file(source.join("dirty.txt")).unwrap();
    git_ok(&source, &["config", "--unset", "branch.main.remote"]);
    let result = prepare_target_merge(&mut connection, "local:target-merge", 4, 2).unwrap();
    assert_eq!(result.state, "noop");
    assert_eq!(result.message, "Already up to date with local main");
    assert_eq!(
        git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap(),
        before
    );
    let summary: String = connection.query_row(
            "SELECT summary FROM card_events WHERE card_id='local:target-merge' ORDER BY id DESC LIMIT 1",
            [], |row| row.get(0),
        ).unwrap();
    assert!(summary.contains("local target branch main"), "{summary}");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn target_merge_fetch_failure_falls_back_to_clean_committed_local_tip() {
    let (root, target, source) = upstream_merge_repository();
    let mut connection = target_merge_connection(&source, &target, "needs_human");
    assert!(
        prepare_target_merge(&mut connection, "local:target-merge", 3, 2)
            .unwrap_err()
            .contains("Card changed")
    );
    assert!(
        prepare_target_merge(&mut connection, "local:target-merge", 4, 1)
            .unwrap_err()
            .contains("environment changed")
    );
    advance_target(&target, "committed local target\n");
    let committed_tip = git_output(target.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    fs::write(target.join("target.txt"), "uncommitted target change\n").unwrap();
    fs::write(target.join("untracked-target.txt"), "must remain local\n").unwrap();
    git_ok(
        &source,
        &[
            "remote",
            "set-url",
            "origin",
            "/definitely/missing/stacks-target.git",
        ],
    );
    let prepared = prepare_target_merge(&mut connection, "local:target-merge", 4, 2).unwrap();
    assert_eq!(prepared.state, "merged");
    let operation = load_target_merge_operation(&connection, "local:target-merge")
        .unwrap()
        .unwrap();
    assert_eq!(operation.target_source, "local");
    assert_eq!(operation.target_revision, committed_tip);
    assert_eq!(
        fs::read_to_string(target.join("target.txt")).unwrap(),
        "uncommitted target change\n"
    );
    assert_eq!(
        fs::read_to_string(source.join("target.txt")).unwrap(),
        "committed local target\n"
    );
    assert!(!source.join("untracked-target.txt").exists());
    let result = finalize_target_merge(
        &mut connection,
        "local:target-merge",
        prepared.operation_id.as_deref().unwrap(),
    )
    .unwrap();
    assert_eq!(result.message, "Successfully merged with local main");
    let summary: String = connection.query_row(
            "SELECT summary FROM card_events WHERE card_id='local:target-merge' ORDER BY id DESC LIMIT 1",
            [], |row| row.get(0),
        ).unwrap();
    assert!(summary.contains("local target branch main"), "{summary}");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn target_merge_falls_back_for_missing_remote_branch_and_invalid_upstreams() {
    for configuration in ["missing-branch", "local-only", "invalid-ref"] {
        let (root, target, source) = upstream_merge_repository();
        let mut connection = target_merge_connection(&source, &target, "needs_human");
        match configuration {
            "missing-branch" => git_ok(
                &source,
                &["config", "branch.main.merge", "refs/heads/does-not-exist"],
            ),
            "local-only" => git_ok(&source, &["config", "branch.main.remote", "."]),
            "invalid-ref" => git_ok(&source, &["config", "branch.main.merge", "refs/tags/main"]),
            _ => unreachable!(),
        }
        let result = prepare_target_merge(&mut connection, "local:target-merge", 4, 2).unwrap();
        assert_eq!(result.state, "noop", "{configuration}");
        assert_eq!(
            result.message, "Already up to date with local main",
            "{configuration}"
        );
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn target_merge_rejects_an_active_git_operation() {
    let (root, target, source) = upstream_merge_repository();
    let mut connection = target_merge_connection(&source, &target, "needs_human");
    let marker = git_output(
        source.to_str().unwrap(),
        &["rev-parse", "--git-path", "CHERRY_PICK_HEAD"],
    )
    .unwrap();
    fs::write(
        marker,
        git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap(),
    )
    .unwrap();
    let error = prepare_target_merge(&mut connection, "local:target-merge", 4, 2).unwrap_err();
    assert!(error.contains("in-progress Git operation"), "{error}");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn target_merge_conflicts_can_be_finalized_or_safely_aborted() {
    let (root, target, source) = upstream_merge_repository();
    fs::write(source.join("base.txt"), "source version\n").unwrap();
    git_ok(&source, &["add", "."]);
    git_ok(&source, &["commit", "-m", "source conflict"]);
    fs::write(target.join("base.txt"), "target version\n").unwrap();
    git_ok(&target, &["add", "."]);
    git_ok(&target, &["commit", "-m", "target conflict"]);
    git_ok(&target, &["push", "origin", "main"]);
    let mut connection = target_merge_connection(&source, &target, "needs_human");
    let starting_revision = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    let prepared = prepare_target_merge(&mut connection, "local:target-merge", 4, 2).unwrap();
    assert_eq!(prepared.state, "conflicted");
    assert!(
        prepared.message.contains("remote main"),
        "{}",
        prepared.message
    );
    assert!(health_codes(&connection, "local:target-merge")
        .contains(&"target_merge_pending".to_string()));
    let operation_id = prepared.operation_id.unwrap();
    let retried = prepare_target_merge(&mut connection, "local:target-merge", 4, 2).unwrap();
    assert_eq!(retried.operation_id.as_deref(), Some(operation_id.as_str()));
    assert!(
        retried.message.contains("remote main"),
        "{}",
        retried.message
    );
    fs::write(source.join("base.txt"), "resolved\n").unwrap();
    git_ok(&source, &["add", "."]);
    git_ok(&source, &["commit", "-m", "Merge target with resolution"]);
    let finalized =
        finalize_target_merge(&mut connection, "local:target-merge", &operation_id).unwrap();
    assert_eq!(finalized.card.status, "needs_human");
    assert_eq!(finalized.message, "Successfully merged with remote main");

    // A second conflicted operation can be conservatively restored when no
    // paths outside Git's recorded merge result were touched.
    fs::write(target.join("base.txt"), "another target version\n").unwrap();
    git_ok(&target, &["add", "."]);
    git_ok(&target, &["commit", "-m", "second target conflict"]);
    git_ok(&target, &["push", "origin", "main"]);
    fs::write(source.join("base.txt"), "another source version\n").unwrap();
    git_ok(&source, &["add", "."]);
    git_ok(&source, &["commit", "-m", "second source conflict"]);
    git_ok(&source, &["config", "--unset", "branch.main.remote"]);
    let current = get_card(&connection, "local:target-merge")
        .unwrap()
        .unwrap();
    let environment_revision = current.environment.unwrap().revision;
    let prepared = prepare_target_merge(
        &mut connection,
        "local:target-merge",
        current.workflow_revision,
        environment_revision,
    )
    .unwrap();
    assert_eq!(prepared.state, "conflicted");
    assert!(
        prepared.message.contains("local main"),
        "{}",
        prepared.message
    );
    let operation_id = prepared.operation_id.unwrap();
    let abort_operation = load_target_merge_operation(&connection, "local:target-merge")
        .unwrap()
        .unwrap();
    assert_eq!(abort_operation.target_source, "local");
    let abort_start = abort_operation.source_revision;
    abort_target_merge(&mut connection, "local:target-merge", &operation_id).unwrap();
    assert_eq!(
        git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap(),
        abort_start
    );
    assert!(!has_git_operation(source.to_str().unwrap()).unwrap());
    assert!(git_output(
        source.to_str().unwrap(),
        &["status", "--porcelain=v1", "--untracked-files=all"]
    )
    .unwrap()
    .is_empty());
    assert_ne!(starting_revision, abort_start);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn start_preflight_allows_dirty_targets_but_source_validation_remains_strict() {
    let (root, target, _source) = merge_repository();
    let committed_head = git_output(target.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    fs::write(target.join("base.txt"), "modified only in primary\n").unwrap();
    fs::write(target.join("dirty.txt"), "untracked only in primary\n").unwrap();
    let preflight = validate_target_checkout(target.to_str().unwrap(), None).unwrap();
    assert_eq!(preflight.target_revision, committed_head);
    let dirty_source = root.join("dirty-source");
    git_ok(
        &target,
        &[
            "worktree",
            "add",
            "-b",
            "dirty-feature",
            dirty_source.to_str().unwrap(),
        ],
    );
    assert_eq!(
        fs::read_to_string(dirty_source.join("base.txt")).unwrap(),
        "base\n"
    );
    assert!(!dirty_source.join("dirty.txt").exists());
    assert!(validate_checkout(target.to_str().unwrap(), None)
        .unwrap_err()
        .contains("modified or untracked"));
    git_ok(&target, &["checkout", "--detach"]);
    assert!(validate_target_checkout(target.to_str().unwrap(), None)
        .unwrap_err()
        .contains("detached"));
    fs::remove_dir_all(root).unwrap();
}

fn health_codes(connection: &Connection, card_id: &str) -> Vec<String> {
    environment_health(connection, card_id)
        .unwrap()
        .issues
        .into_iter()
        .map(|issue| issue.code)
        .collect()
}

#[test]
fn environment_health_is_status_aware_when_environment_is_absent() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    local_card(&mut connection);
    for status in [
        "needs_refinement",
        "refining",
        "needs_refinement_input",
        "ready",
        "done",
    ] {
        connection
            .execute(
                "UPDATE kanban_cards SET status=?1 WHERE id='local:test'",
                [status],
            )
            .unwrap();
        assert!(
            health_codes(&connection, "local:test").is_empty(),
            "{status}"
        );
    }
    for (status, step) in [
        ("agent_working", "work"),
        ("needs_human", "approval"),
        ("approved", "merge"),
    ] {
        connection
            .execute(
                "UPDATE kanban_cards SET status=?1 WHERE id='local:test'",
                [status],
            )
            .unwrap();
        let health = environment_health(&connection, "local:test").unwrap();
        assert_eq!(health.issues[0].code, "environment_missing");
        assert_eq!(health.issues[0].step, step);
    }
}

#[test]
fn environment_health_ignores_finalized_parent_with_active_child() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    local_card(&mut connection);
    connection
        .execute(
            "UPDATE kanban_cards SET status='ready', hierarchy_finalized=1 WHERE id='local:test'",
            [],
        )
        .unwrap();
    connection
            .execute(
                "INSERT INTO kanban_cards
                 (id, external_provider, external_id, title, status, project_id, parent_id, created_at, updated_at)
                 VALUES ('local:child', 'local:project', '2', 'Child', 'agent_working', 'project', 'local:test', 1, 1)",
                [],
            )
            .unwrap();

    let parent = get_card(&connection, "local:test").unwrap().unwrap();
    assert_eq!(parent.status, "agent_working");
    assert!(health_codes(&connection, "local:test").is_empty());
}

#[test]
fn environment_health_accepts_healthy_and_dirty_active_worktrees() {
    let (root, target, source) = merge_repository();
    let connection = approval_connection(&source, &target);
    assert!(health_codes(&connection, "local:approve").is_empty());
    fs::write(
        source.join("feature.txt"),
        "ordinary implementation change\n",
    )
    .unwrap();
    assert!(health_codes(&connection, "local:approve").is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn environment_health_reports_metadata_repository_branch_and_git_operation_blockers() {
    let (root, target, source) = merge_repository();
    let connection = approval_connection(&source, &target);
    connection.execute("UPDATE card_environments SET target_checkout_path=NULL, target_branch=NULL WHERE card_id='local:approve'", []).unwrap();
    let codes = health_codes(&connection, "local:approve");
    assert!(codes.contains(&"target_checkout_missing".to_string()));
    assert!(codes.contains(&"target_branch_missing".to_string()));

    connection.execute("UPDATE card_environments SET target_checkout_path=?1, target_branch='wrong-target', branch='wrong', repository_id='wrong-repository' WHERE card_id='local:approve'", [target.to_str().unwrap()]).unwrap();
    let operation_marker = git_output(
        source.to_str().unwrap(),
        &["rev-parse", "--git-path", "MERGE_HEAD"],
    )
    .unwrap();
    fs::write(&operation_marker, "in progress\n").unwrap();
    let codes = health_codes(&connection, "local:approve");
    assert!(codes.contains(&"source_repository_mismatch".to_string()));
    assert!(codes.contains(&"target_repository_mismatch".to_string()));
    assert!(codes.contains(&"source_branch_mismatch".to_string()));
    assert!(codes.contains(&"target_branch_mismatch".to_string()));
    assert!(codes.contains(&"source_git_operation_in_progress".to_string()));
    fs::remove_file(operation_marker).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn environment_health_reports_missing_detached_and_unregistered_source_worktrees() {
    let (root, target, source) = merge_repository();
    let connection = approval_connection(&source, &target);
    git_ok(&source, &["checkout", "--detach"]);
    assert!(health_codes(&connection, "local:approve")
        .contains(&"source_checkout_detached".to_string()));
    git_ok(&source, &["checkout", "feature"]);

    connection.execute("UPDATE card_environments SET worktree_path=?1, branch='main' WHERE card_id='local:approve'", [target.to_str().unwrap()]).unwrap();
    assert!(health_codes(&connection, "local:approve")
        .contains(&"source_worktree_not_registered".to_string()));
    connection.execute("UPDATE card_environments SET worktree_path='/missing/stacks/source' WHERE card_id='local:approve'", []).unwrap();
    assert!(health_codes(&connection, "local:approve")
        .contains(&"source_checkout_unavailable".to_string()));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn environment_health_checks_merged_cleanup_revisions_and_ancestry() {
    let (root, target, source) = merge_repository();
    let connection = approval_connection(&source, &target);
    git_ok(&target, &["merge", "--no-ff", "feature", "-m", "merge"]);
    let source_tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    let target_tip = git_output(target.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    connection
            .execute(
                "UPDATE kanban_cards SET status='done', completion_outcome='merged' WHERE id='local:approve'",
                [],
            )
            .unwrap();
    connection.execute("UPDATE card_environments SET source_revision=?1, target_revision=?2 WHERE card_id='local:approve'", params![source_tip, target_tip]).unwrap();
    assert!(health_codes(&connection, "local:approve").is_empty());

    fs::write(source.join("later.txt"), "later\n").unwrap();
    git_ok(&source, &["add", "."]);
    git_ok(&source, &["commit", "-m", "later"]);
    assert!(
        health_codes(&connection, "local:approve").contains(&"source_revision_changed".to_string())
    );

    let new_tip = git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
    connection
        .execute(
            "UPDATE card_environments SET source_revision=?1 WHERE card_id='local:approve'",
            [new_tip],
        )
        .unwrap();
    assert!(health_codes(&connection, "local:approve")
        .contains(&"source_revision_not_merged".to_string()));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn cleanup_phases_are_ordered_and_cover_every_resumable_boundary() {
    let mut visited = vec![CLEANUP_PHASES[0]];
    while let Some(next) = next_cleanup_phase(visited.last().unwrap()) {
        visited.push(next);
    }
    assert_eq!(visited, CLEANUP_PHASES);
    assert_eq!(next_cleanup_phase("record_completion"), None);
}

#[test]
fn cleanup_operation_schema_retains_completed_audit_after_environment_deletion() {
    let connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    test_project(&connection, "p", "local", "/tmp/repo");
    let now = unix_timestamp();
    connection.execute("INSERT INTO kanban_cards (id,external_provider,external_id,title,status,completion_outcome,workflow_revision,project_id,created_at,updated_at) VALUES ('local:cleanup','local:p','64','Cleanup','done','closed',3,'p',?1,?1)", [now]).unwrap();
    connection.execute("INSERT INTO card_environments (id,card_id,project_id,worktree_path,branch,revision,created_at,updated_at) VALUES ('cleanup-env','local:cleanup','p','/tmp/source','feature',2,?1,?1)", [now]).unwrap();
    connection.execute("INSERT INTO card_cleanup_operations (card_id,environment_id,workflow_revision,environment_revision,status,phase,completion_outcome,repository_id,source_path,target_path,source_branch,target_branch,source_revision,delete_local_branch,delete_remote_branch,started_at,updated_at) VALUES ('local:cleanup','cleanup-env',3,2,'pending','remove_metadata','closed','repo','/tmp/source','/tmp/repo','feature','main','abc',0,0,?1,?1)", [now]).unwrap();
    let immutable_error = connection.execute("UPDATE card_cleanup_operations SET source_revision='changed' WHERE card_id='local:cleanup'", []).unwrap_err();
    assert!(immutable_error
        .to_string()
        .contains("snapshot is immutable"));
    connection
        .execute("DELETE FROM card_environments WHERE id='cleanup-env'", [])
        .unwrap();
    connection.execute("UPDATE card_cleanup_operations SET status='completed',phase='record_completion',completed_at=?1 WHERE card_id='local:cleanup'", [now]).unwrap();
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM card_cleanup_operations WHERE card_id='local:cleanup' AND status='completed'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    assert!(get_card(&connection, "local:cleanup")
        .unwrap()
        .unwrap()
        .cleanup_operation
        .is_some());
}

#[test]
fn cleanup_phase_advancement_is_compare_and_set_and_resumable_at_every_boundary() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    test_project(&connection, "p", "local", "/tmp/repo");
    let now = unix_timestamp();
    connection.execute("INSERT INTO kanban_cards (id,external_provider,external_id,title,status,completion_outcome,workflow_revision,project_id,created_at,updated_at) VALUES ('local:phases','local:p','64','Phases','done','closed',3,'p',?1,?1)", [now]).unwrap();
    connection.execute("INSERT INTO card_environments (id,card_id,project_id,worktree_path,branch,revision,created_at,updated_at) VALUES ('phase-env','local:phases','p','/tmp/source','feature',2,?1,?1)", [now]).unwrap();
    connection.execute("INSERT INTO card_cleanup_operations (card_id,environment_id,workflow_revision,environment_revision,status,phase,completion_outcome,repository_id,source_path,target_path,source_branch,target_branch,source_revision,delete_local_branch,delete_remote_branch,started_at,updated_at) VALUES ('local:phases','phase-env',3,2,'failed','runtime_sessions','closed','repo','/tmp/source','/tmp/repo','feature','main','abc',0,0,?1,?1)", [now]).unwrap();

    let stale = load_cleanup_snapshot(&connection, "local:phases").unwrap();
    advance_cleanup_phase_in_connection(&mut connection, &stale).unwrap();
    assert!(advance_cleanup_phase_in_connection(&mut connection, &stale)
        .unwrap_err()
        .contains("changed"));
    loop {
        let current = load_cleanup_snapshot(&connection, "local:phases").unwrap();
        if current.status == "completed" {
            break;
        }
        advance_cleanup_phase_in_connection(&mut connection, &current).unwrap();
    }
    let completed = load_cleanup_snapshot(&connection, "local:phases").unwrap();
    assert_eq!(completed.status, "completed");
    assert!(completed.registration_validated);
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM card_events WHERE card_id='local:phases' AND event_type='cleanup' AND outcome='success'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
}

fn cleanup_snapshot(target: &Path, source: &Path, outcome: &str) -> CleanupSnapshot {
    CleanupSnapshot {
        card_id: "local:cleanup".into(),
        environment_id: "env".into(),
        workflow_revision: 1,
        environment_revision: 1,
        status: "pending".into(),
        phase: "validate_repository".into(),
        completion_outcome: outcome.into(),
        repository_id: repository_identity(target.to_str().unwrap()).unwrap(),
        source_path: source.to_str().unwrap().into(),
        target_path: target.to_str().unwrap().into(),
        source_branch: "feature".into(),
        target_branch: "main".into(),
        source_revision: git_output(source.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap(),
        delete_local_branch: outcome == "merged",
        delete_remote_branch: false,
        merged_pr_head_revision: None,
        pane_ids: Vec::new(),
        registration_validated: false,
    }
}

#[test]
fn cleanup_reconciles_worktree_and_local_branch_side_effects() {
    let (root, target, source) = merge_repository();
    git_ok(&target, &["merge", "--no-ff", "feature", "-m", "merge"]);
    let mut operation = cleanup_snapshot(&target, &source, "merged");
    validate_cleanup_repository(&operation).unwrap();
    operation.registration_validated = true;

    remove_cleanup_worktree(&operation).unwrap();
    assert!(!source.exists());
    remove_cleanup_worktree(&operation).unwrap();
    delete_cleanup_local_branch(&operation).unwrap();
    assert!(local_ref_tip(target.to_str().unwrap(), "feature")
        .unwrap()
        .is_none());
    delete_cleanup_local_branch(&operation).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn cleanup_remote_deletion_uses_exact_tip_lease_and_reconciles_absence() {
    let (root, target, source) = merge_repository();
    git_ok(&target, &["merge", "--no-ff", "feature", "-m", "merge"]);
    let remote = root.join("remote.git");
    let output = Command::new("git")
        .args(["init", "--bare", remote.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(output.status.success());
    git_ok(
        &target,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git_ok(&target, &["push", "origin", "feature"]);
    let mut operation = cleanup_snapshot(&target, &source, "merged");
    operation.registration_validated = true;
    operation.delete_remote_branch = true;
    operation.merged_pr_head_revision = Some(operation.source_revision.clone());
    delete_cleanup_remote_branch(&operation).unwrap();
    delete_cleanup_remote_branch(&operation).unwrap();

    git_ok(&target, &["push", "origin", "main:feature"]);
    assert!(delete_cleanup_remote_branch(&operation)
        .unwrap_err()
        .contains("tip changed"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn cleanup_rejects_absent_unvalidated_and_changed_source_evidence() {
    let (root, target, source) = merge_repository();
    let mut operation = cleanup_snapshot(&target, &source, "closed");
    fs::write(source.join("dirty.txt"), "unsafe\n").unwrap();
    assert!(validate_cleanup_repository(&operation)
        .unwrap_err()
        .contains("modified or untracked"));
    fs::remove_file(source.join("dirty.txt")).unwrap();
    git_ok(&target, &["worktree", "remove", source.to_str().unwrap()]);
    assert!(remove_cleanup_worktree(&operation)
        .unwrap_err()
        .contains("without persisted"));
    operation.registration_validated = true;
    remove_cleanup_worktree(&operation).unwrap();
    git_ok(&target, &["branch", "-f", "feature", "main"]);
    assert!(remove_cleanup_worktree(&operation)
        .unwrap_err()
        .contains("tip changed"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn runtime_ownership_parsing_is_exact_for_delimited_and_prefixed_card_ids() {
    assert_eq!(
        card_pi_owner("kanban-card:local:7:planning").as_deref(),
        Some("local:7")
    );
    assert_eq!(
        card_terminal_owner("kanban-card:local:7:terminal:shell").as_deref(),
        Some("local:7")
    );
    assert_ne!(
        card_pi_owner("kanban-card:local:72:planning").as_deref(),
        Some("local:7")
    );
    assert_ne!(
        card_terminal_owner("kanban-card:local:72:terminal:shell").as_deref(),
        Some("local:7")
    );
    assert!(card_pi_owner("kanban-card:local:7:terminal:shell").is_none());
}

#[test]
fn close_validates_and_commits_pending_cleanup_before_teardown() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    let card = local_card(&mut connection);
    connection.execute("INSERT INTO card_environments (id,card_id,project_id,worktree_path,created_at,updated_at) VALUES ('env','local:test','project','/tmp/card',1,1)", []).unwrap();
    connection.execute("INSERT INTO card_panes (id,environment_id,role,kind,sort_order) VALUES ('kanban-card:local:test:terminal:custom','env','custom','terminal',0), ('kanban-card:local:test-more:terminal:foreign','env','foreign','terminal',1)", []).unwrap();

    assert!(commit_card_close(&mut connection, &card.id, card.workflow_revision + 1).is_err());
    let unchanged = get_card(&connection, &card.id).unwrap().unwrap();
    assert_eq!(unchanged.status, "needs_refinement");
    assert_eq!(unchanged.workflow_revision, card.workflow_revision);
    assert!(unchanged.runtime_cleanup_status.is_none());
    assert_eq!(unchanged.events.len(), 0);

    let targets = commit_card_close(&mut connection, &card.id, card.workflow_revision).unwrap();
    let committed = get_card(&connection, &card.id).unwrap().unwrap();
    assert_eq!(committed.status, "done");
    assert_eq!(
        committed.completion_outcome,
        Some(CompletionOutcome::Closed)
    );
    assert_eq!(committed.workflow_revision, card.workflow_revision + 1);
    assert_eq!(committed.runtime_cleanup_status.as_deref(), Some("pending"));
    assert_eq!(
        committed
            .events
            .iter()
            .filter(|event| event.event_type == "close" && event.outcome == "success")
            .count(),
        1
    );
    assert!(targets
        .pty
        .contains("kanban-card:local:test:terminal:custom"));
    assert!(!targets
        .pty
        .contains("kanban-card:local:test-more:terminal:foreign"));
    assert!(commit_card_close(&mut connection, &card.id, committed.workflow_revision).is_err());
}

#[test]
fn runtime_cleanup_attempts_every_target_and_recovers_without_workflow_change() {
    use std::cell::RefCell;
    let mut targets = CardRuntimeTargets::default();
    targets.pi.extend([
        "kanban-card:local:test:planning".into(),
        "kanban-card:local:test:work".into(),
    ]);
    targets.pty.extend([
        "kanban-card:local:test:terminal:shell".into(),
        "kanban-card:local:test:terminal:server".into(),
    ]);
    let attempted = RefCell::new(Vec::new());
    let outcomes = execute_runtime_cleanup(
        targets,
        |id| {
            attempted.borrow_mut().push(format!("stop:{id}"));
            if id.ends_with(":planning") {
                Err("stuck".into())
            } else {
                Ok(())
            }
        },
        |id| {
            attempted.borrow_mut().push(format!("delete:{id}"));
            Ok(())
        },
        |id| {
            attempted.borrow_mut().push(format!("pty:{id}"));
            Ok(())
        },
    );
    assert_eq!(
        outcomes.iter().filter(|outcome| !outcome.success).count(),
        2
    );
    assert!(attempted
        .borrow()
        .iter()
        .any(|value| value.ends_with(":work")));
    assert!(attempted
        .borrow()
        .iter()
        .any(|value| value.ends_with(":terminal:server")));
    assert!(!attempted
        .borrow()
        .iter()
        .any(|value| value == "delete:kanban-card:local:test:planning"));

    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&connection).unwrap();
    let card = local_card(&mut connection);
    commit_card_close(&mut connection, &card.id, card.workflow_revision).unwrap();
    let revision = card.workflow_revision + 1;
    persist_runtime_cleanup_result(
        &connection,
        &card.id,
        &[RuntimeResourceOutcome {
            resource_type: "pty".into(),
            id: "shell".into(),
            success: false,
            error: Some("permission denied".into()),
        }],
    )
    .unwrap();
    let failed = get_card(&connection, &card.id).unwrap().unwrap();
    assert_eq!(failed.status, "done");
    assert_eq!(failed.workflow_revision, revision);
    assert_eq!(failed.runtime_cleanup_status.as_deref(), Some("failed"));
    assert!(failed
        .runtime_cleanup_error
        .as_deref()
        .unwrap()
        .contains("permission denied"));
    persist_runtime_cleanup_result(&connection, &card.id, &[]).unwrap();
    let recovered = get_card(&connection, &card.id).unwrap().unwrap();
    assert_eq!(recovered.workflow_revision, revision);
    assert_eq!(
        recovered.runtime_cleanup_status.as_deref(),
        Some("complete")
    );
    assert!(recovered.runtime_cleanup_error.is_none());
}

#[test]
fn makes_card_ids_safe_for_directories() {
    assert_eq!(
        safe_card_key("superthread:42/../../oops"),
        "superthread_42_______oops"
    );
}
