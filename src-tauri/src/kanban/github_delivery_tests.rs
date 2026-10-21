use super::*;
use std::time::{Duration, Instant};

struct TestDir(PathBuf);
impl TestDir {
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture() -> (TestDir, Connection) {
    let dir =
        TestDir(std::env::temp_dir().join(format!("stacks-pr-refresh-{}", uuid::Uuid::new_v4())));
    fs::create_dir_all(dir.path()).unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["remote", "add", "origin", "https://github.com/org/repo.git"],
    ] {
        assert!(Command::new("git")
            .current_dir(dir.path())
            .args(args)
            .status()
            .unwrap()
            .success());
    }
    let connection = Connection::open(dir.path().join("board.sqlite3")).unwrap();
    migrate(&connection).unwrap();
    crate::store::migrate_store_schema(&connection).unwrap();
    connection.execute("INSERT INTO projects(id,name,path,kanban_source,delivery_workflow,target_branch) VALUES ('p','P',?1,'local','github_pull_request','main')", [dir.path().to_str().unwrap()]).unwrap();
    connection.execute("INSERT INTO kanban_cards(id,external_provider,external_id,title,project_id,status,created_at,updated_at) VALUES ('c','local:p','1','Card','p','needs_human',1,1),('other','local:p','2','Other','p','ready',1,1)", []).unwrap();
    connection.execute("INSERT INTO card_environments(id,card_id,project_id,worktree_path,branch,source_revision,created_at,updated_at) VALUES ('e','c','p',?1,'feature','head',1,1)", [dir.path().to_str().unwrap()]).unwrap();
    (dir, connection)
}

fn response(head: &str) -> String {
    serde_json::json!([{"number":7,"title":"PR","url":"url","state":"OPEN","mergedAt":null,"baseRefName":"main","headRefOid":head,"mergeable":"MERGEABLE","statusCheckRollup":[],"reviews":[]}]).to_string()
}

#[test]
fn refresh_rejects_changed_identity_without_events_or_revisions() {
    for sql in [
        "UPDATE kanban_cards SET record_revision=record_revision+1 WHERE id='c'",
        "UPDATE kanban_cards SET workflow_revision=workflow_revision+1 WHERE id='c'",
        "UPDATE kanban_cards SET external_provider='superthread' WHERE id='c'",
        "UPDATE kanban_cards SET project_id=NULL WHERE id='c'",
        "UPDATE projects SET path='/elsewhere' WHERE id='p'",
        "UPDATE projects SET config_revision=config_revision+1 WHERE id='p'",
        "UPDATE projects SET kanban_source='superthread' WHERE id='p'",
        "UPDATE projects SET supports_feature_environments=1 WHERE id='p'",
        "UPDATE projects SET target_branch='other' WHERE id='p'",
        "UPDATE projects SET delivery_workflow='local_merge' WHERE id='p'",
        "UPDATE projects SET require_passing_ci=0 WHERE id='p'",
        "UPDATE projects SET require_approval=1 WHERE id='p'",
        "UPDATE projects SET github_merge_strategy='squash' WHERE id='p'",
        "UPDATE kanban_cards SET feature_environment=1 WHERE id='c'",
        "UPDATE card_environments SET branch='different' WHERE card_id='c'",
        "UPDATE card_environments SET id='replacement' WHERE card_id='c'",
        "UPDATE card_environments SET project_id='different' WHERE card_id='c'",
        "UPDATE card_pull_requests SET head_revision='newer' WHERE card_id='c'",
        "UPDATE card_pull_requests SET number=8 WHERE card_id='c'",
        "UPDATE card_pull_requests SET repository='another/repo' WHERE card_id='c'",
        "DELETE FROM card_pull_requests WHERE card_id='c'",
        "UPDATE card_environments SET revision=revision+1 WHERE card_id='c'",
        "UPDATE card_environments SET source_revision='new-head' WHERE card_id='c'",
        "DELETE FROM card_environments WHERE card_id='c'",
        "DELETE FROM kanban_cards WHERE id='c'",
    ] {
        let (_dir, mut connection) = fixture();
        connection.execute("INSERT INTO card_pull_requests(card_id,repository,number,title,url,state,head_revision,updated_at) VALUES ('c','org/repo',7,'PR','url','open','old',1)", []).unwrap();
        let input = prepare_pull_request_refresh(&connection, "c")
            .unwrap()
            .unwrap();
        let identity = input.identity.clone();
        let refresh = fetch_pull_request_with(input, |_, _| Ok(response("head"))).unwrap();
        connection.execute(sql, []).unwrap();
        let revision = board_revision(&connection).unwrap();
        assert!(
            execute_board_mutation(&mut connection, |c| apply_pull_request_refresh(
                c, "c", refresh
            ))
            .is_err(),
            "{sql}"
        );
        assert_eq!(board_revision(&connection).unwrap(), revision);
        let (_, change) = execute_board_mutation(&mut connection, |c| {
            apply_refresh_failure(c, "c", &identity, "late failure")
        })
        .unwrap();
        assert!(change.is_none(), "{sql}");
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM card_events", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[test]
fn old_head_and_old_failure_cannot_overwrite_newer_refresh() {
    let (_dir, mut connection) = fixture();
    let input = prepare_pull_request_refresh(&connection, "c")
        .unwrap()
        .unwrap();
    let old_identity = input.identity.clone();
    let old = fetch_pull_request_with(input, |_, _| Ok(response("old"))).unwrap();
    let input = prepare_pull_request_refresh(&connection, "c")
        .unwrap()
        .unwrap();
    let new = fetch_pull_request_with(input, |_, _| Ok(response("new"))).unwrap();
    let (_, change) =
        execute_board_mutation(&mut connection, |c| apply_pull_request_refresh(c, "c", new))
            .unwrap();
    assert_eq!(change.unwrap().board_revision, 1);
    assert!(
        execute_board_mutation(&mut connection, |c| apply_pull_request_refresh(c, "c", old))
            .is_err()
    );
    let (_, change) = execute_board_mutation(&mut connection, |c| {
        apply_refresh_failure(c, "c", &old_identity, "late failure")
    })
    .unwrap();
    assert!(change.is_none());
    assert_eq!(
        connection
            .query_row(
                "SELECT head_revision FROM card_pull_requests WHERE card_id='c'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "new"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT delivery_error FROM kanban_cards WHERE id='c'",
                [],
                |r| r.get::<_, Option<String>>(0)
            )
            .unwrap(),
        None
    );
    assert_eq!(board_revision(&connection).unwrap(), 1);
}

#[test]
fn slow_or_failing_github_does_not_block_concurrent_writer() {
    for fail in [false, true] {
        let (dir, mut connection) = fixture();
        let input = prepare_pull_request_refresh(&connection, "c")
            .unwrap()
            .unwrap();
        let identity = input.identity.clone();
        let (entered, receiving) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let released = Mutex::new(released);
        let click = Instant::now();
        let worker = std::thread::spawn(move || {
            fetch_pull_request_with(input, |_, _| {
                entered.send(()).unwrap();
                released.lock().unwrap().recv().unwrap();
                if fail {
                    Err("GitHub unavailable".into())
                } else {
                    Ok(response("head"))
                }
            })
        });
        receiving.recv_timeout(Duration::from_secs(2)).unwrap();
        let mut other = Connection::open(dir.path().join("board.sqlite3")).unwrap();
        other.busy_timeout(Duration::from_millis(100)).unwrap();
        let start = Instant::now();
        let (_, change) = execute_board_mutation(&mut other, |c| {
            c.execute(
                "UPDATE kanban_cards SET title='Concurrent edit' WHERE id='other'",
                [],
            )
            .map_err(db_error)?;
            Ok(())
        })
        .unwrap();
        let writer = start.elapsed();
        assert_eq!(change.unwrap().board_revision, 1);
        // Hold the external call long enough to make latency/lock measurements visible.
        std::thread::sleep(Duration::from_millis(200));
        release.send(()).unwrap();
        let fetched = worker.join().unwrap();
        let start = Instant::now();
        let (_, change) = execute_board_mutation(&mut connection, |c| match fetched {
            Ok(refresh) => apply_pull_request_refresh(c, "c", refresh).map(|_| ()),
            Err(error) => apply_refresh_failure(c, "c", &identity, &error),
        })
        .unwrap();
        assert_eq!(change.unwrap().board_revision, 2);
        eprintln!("fail={fail}: concurrent_writer={writer:?}, refresh_write_hold={:?}, request_to_update={:?}", start.elapsed(), click.elapsed());
    }
}

#[test]
fn baseline_slow_refresh_holds_sqlite_writer_for_external_latency() {
    let (dir, mut connection) = fixture();
    let other = Connection::open(dir.path().join("board.sqlite3")).unwrap();
    other.busy_timeout(Duration::ZERO).unwrap();
    let click = Instant::now();
    let start = Instant::now();
    execute_board_mutation(&mut connection, |c| {
        assert!(other
            .execute(
                "UPDATE kanban_cards SET title='Blocked' WHERE id='other'",
                []
            )
            .is_err());
        std::thread::sleep(Duration::from_millis(200));
        c.execute(
            "UPDATE kanban_cards SET delivery_error='baseline' WHERE id='c'",
            [],
        )
        .map_err(db_error)?;
        Ok(())
    })
    .unwrap();
    eprintln!(
        "baseline simulated GitHub: write_hold={:?}, request_to_update={:?}",
        start.elapsed(),
        click.elapsed()
    );
    assert!(start.elapsed() >= Duration::from_millis(200));
}

#[test]
fn refresh_preserves_provider_fields_and_observed_merge_is_idempotent() {
    let (_dir, mut connection) = fixture();
    connection
        .execute(
            "UPDATE kanban_cards SET status='approved',content='Provider brief' WHERE id='c'",
            [],
        )
        .unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&response("head")).unwrap();
    value[0]["state"] = "MERGED".into();
    value[0]["mergedAt"] = "2026-01-01T00:00:00Z".into();
    for expected_board in [1, 2] {
        let input = prepare_pull_request_refresh(&connection, "c")
            .unwrap()
            .unwrap();
        let refresh = fetch_pull_request_with(input, |_, _| Ok(value.to_string())).unwrap();
        let (_, change) = execute_board_mutation(&mut connection, |c| {
            apply_pull_request_refresh(c, "c", refresh)
        })
        .unwrap();
        assert_eq!(change.unwrap().board_revision, expected_board);
    }
    let values: (String,String,String,i64,String) = connection.query_row("SELECT title,content,status,workflow_revision,external_provider FROM kanban_cards WHERE id='c'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
    assert_eq!(
        values,
        (
            "Card".into(),
            "Provider brief".into(),
            "done".into(),
            2,
            "local:p".into()
        )
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM card_events WHERE event_type='merge_pr'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn empty_or_malformed_response_and_title_edit_have_safe_retry_behavior() {
    let (dir, mut connection) = fixture();
    let input = prepare_pull_request_refresh(&connection, "c")
        .unwrap()
        .unwrap();
    assert!(fetch_pull_request_with(input, |_, _| Ok("invalid json".into())).is_err());
    connection.execute("UPDATE kanban_cards SET feature_environment=1,delivery_operation_stage='pr_created' WHERE id='c'", []).unwrap();
    let input = prepare_pull_request_refresh(&connection, "c")
        .unwrap()
        .unwrap();
    let other = Connection::open(dir.path().join("board.sqlite3")).unwrap();
    other.busy_timeout(Duration::ZERO).unwrap();
    let calls = std::cell::RefCell::new(Vec::new());
    let refresh = fetch_pull_request_with(input, |_, args| {
        // Both list and edit run without a SQLite writer lock.
        other.execute_batch("BEGIN IMMEDIATE; ROLLBACK").unwrap();
        calls.borrow_mut().push(args[1].to_string());
        Ok(if args[1] == "list" {
            response("head")
        } else {
            String::new()
        })
    })
    .unwrap();
    assert_eq!(*calls.borrow(), ["list", "edit"]);
    execute_board_mutation(&mut connection, |c| {
        apply_pull_request_refresh(c, "c", refresh)
    })
    .unwrap();
    let (title, stage): (String,Option<String>) = connection.query_row("SELECT pr.title,c.delivery_operation_stage FROM kanban_cards c JOIN card_pull_requests pr ON pr.card_id=c.id WHERE c.id='c'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(title, "[FE] PR");
    assert_eq!(stage, None);
    let input = prepare_pull_request_refresh(&connection, "c")
        .unwrap()
        .unwrap();
    let refresh = fetch_pull_request_with(input, |_, _| Ok("[]".into())).unwrap();
    execute_board_mutation(&mut connection, |c| {
        apply_pull_request_refresh(c, "c", refresh)
    })
    .unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM card_pull_requests", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
