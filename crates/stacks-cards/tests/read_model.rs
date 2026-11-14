use std::path::Path;

use rusqlite::Connection;
use stacks_cards::{CardStatus, CardStore, WorkGroup, WorkflowAction, group_cards, work_group};

fn create_database(path: &Path) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(
            r#"
            CREATE TABLE projects (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
                color_id TEXT, delivery_workflow TEXT NOT NULL DEFAULT 'local_merge',
                kanban_source TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
                require_passing_ci INTEGER NOT NULL DEFAULT 1,
                require_approval INTEGER NOT NULL DEFAULT 0,
                server_command TEXT, console_command TEXT,
                notes TEXT NOT NULL DEFAULT '',
                releases_enabled INTEGER NOT NULL DEFAULT 0,
                release_config_path TEXT NOT NULL DEFAULT '.stacks/release.json',
                supports_feature_environments INTEGER NOT NULL DEFAULT 0,
                target_branch TEXT, start_work_command TEXT, deployment_command TEXT
            );
            CREATE TABLE kanban_cards (
                id TEXT PRIMARY KEY, external_provider TEXT NOT NULL, external_id TEXT NOT NULL,
                title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', board_id TEXT NOT NULL DEFAULT '',
                board_title TEXT NOT NULL DEFAULT '', list_id TEXT NOT NULL DEFAULT '',
                list_title TEXT NOT NULL DEFAULT '', card_url TEXT NOT NULL DEFAULT '',
                assignee_names TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
                completion_outcome TEXT, feature_environment INTEGER NOT NULL DEFAULT 0,
                delivery_operation_stage TEXT, delivery_error TEXT, runtime_cleanup_status TEXT,
                runtime_cleanup_error TEXT, workflow_revision INTEGER NOT NULL DEFAULT 1,
                record_revision INTEGER NOT NULL DEFAULT 1, project_id TEXT, workspace_id TEXT,
                parent_id TEXT, hierarchy_finalized INTEGER NOT NULL DEFAULT 0,
                provider_child_count INTEGER NOT NULL DEFAULT 0, provider_parent_title TEXT,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0, in_scope INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE card_environments (
                id TEXT PRIMARY KEY, card_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
                worktree_path TEXT NOT NULL, branch TEXT NOT NULL DEFAULT '',
                repository_id TEXT, target_checkout_path TEXT, target_branch TEXT,
                source_revision TEXT, target_revision TEXT,
                lifecycle_state TEXT NOT NULL DEFAULT 'ready', revision INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE card_panes (
                id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, role TEXT NOT NULL,
                kind TEXT NOT NULL, command TEXT, sort_order INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE card_layouts (
                environment_id TEXT PRIMARY KEY, split_layout TEXT NOT NULL DEFAULT '{}',
                focused_pane_id TEXT, layout_revision INTEGER NOT NULL DEFAULT 1,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE card_pull_requests (
                card_id TEXT PRIMARY KEY, repository TEXT NOT NULL, number INTEGER NOT NULL,
                title TEXT NOT NULL, url TEXT NOT NULL, state TEXT NOT NULL,
                draft INTEGER NOT NULL DEFAULT 0, ci_status TEXT NOT NULL DEFAULT 'unknown',
                review_state TEXT NOT NULL DEFAULT 'unknown', has_conflicts INTEGER NOT NULL DEFAULT 0,
                mergeable INTEGER NOT NULL DEFAULT 0, head_revision TEXT, updated_at INTEGER NOT NULL
            );
            CREATE TABLE environment_creation_operations (
                card_id TEXT PRIMARY KEY, cleanup_available INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE card_cleanup_operations (
                card_id TEXT PRIMARY KEY, status TEXT NOT NULL
            );
            CREATE TABLE scripted_delivery_operations (
                card_id TEXT PRIMARY KEY, stage TEXT NOT NULL
            );
            CREATE TABLE card_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL,
                created_at INTEGER NOT NULL, actor TEXT NOT NULL, event_type TEXT NOT NULL,
                outcome TEXT NOT NULL, from_status TEXT, to_status TEXT, summary TEXT,
                error_code TEXT, error_detail TEXT
            );
            INSERT INTO projects(id,name,path,color_id,delivery_workflow,kanban_source,sort_order)
                VALUES ('p1','Stacks','/tmp/stacks','slate','local_merge','local',0),
                       ('p2','Arcasa','/tmp/arcasa','violet','github_pull_request','superthread',1);
            INSERT INTO kanban_cards(id,external_provider,external_id,title,status,project_id,parent_id,
                hierarchy_finalized,provider_child_count,created_at,updated_at,sort_order)
                VALUES ('parent','local:parent','1','Parent','agent_working','p1',NULL,1,1,1,1,0),
                       ('child','local:child','2','Child','ready','p1','parent',0,0,2,2,0),
                       ('backlog-a','local:a','3','Backlog A','needs_refinement','p1',NULL,0,0,3,3,0),
                       ('backlog-b','local:b','4','Backlog B','needs_refinement','p1',NULL,0,0,4,4,1),
                       ('done','local:d','5','Shipped','done','p1',NULL,0,0,5,5,2),
                       ('pr','superthread:9','9','PR card','approved','p2',NULL,0,0,6,6,0);
            UPDATE kanban_cards SET completion_outcome='merged' WHERE id='done';
            UPDATE kanban_cards SET content='## Plan

- Read the detail
- Render the content', card_url='https://example.test/cards/1' WHERE id='parent';
            INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,from_status,to_status,summary)
                VALUES ('parent',100,'agent','status_change','success','agent_working','ready','Moved to ready'),
                       ('parent',101,'user','agent_started','success',NULL,NULL,'Started work');
            INSERT INTO card_pull_requests(card_id,repository,number,title,url,state,draft,ci_status,
                review_state,has_conflicts,mergeable,head_revision,updated_at)
                VALUES ('pr','acme/repo',42,'PR card','https://example.test/pr/42','open',0,'success',
                        'approved',0,1,'abc','7');
            INSERT INTO card_environments(id,card_id,project_id,worktree_path,branch,lifecycle_state,
                revision,created_at,updated_at) VALUES
                ('env-parent','parent','p1','/tmp/parent','stacks/parent','ready',1,1,1),
                ('env-pr','pr','p2','/tmp/pr','stacks/pr','ready',1,1,1);
            "#,
        )
        .unwrap();
}

#[test]
fn loads_real_list_projection_and_effective_statuses() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workflow.sqlite3");
    create_database(&path);
    let snapshot = CardStore::new(&path).load_snapshot().unwrap();
    assert_eq!(snapshot.projects.len(), 2);
    assert_eq!(snapshot.cards.len(), 6);

    let parent = snapshot
        .cards
        .iter()
        .find(|card| card.id == "parent")
        .unwrap();
    // Finalized parents roll up to their earliest child status.
    assert_eq!(parent.status, CardStatus::Ready);
    assert_eq!(parent.child_count, 1);
    assert_eq!(parent.children[0].external_id, "2");
    assert_eq!(parent.environment.as_ref().unwrap().branch, "stacks/parent");

    assert_eq!(
        group_cards(&snapshot.cards, WorkGroup::Backlog, &snapshot.projects).len(),
        2
    );
    assert_eq!(
        group_cards(&snapshot.cards, WorkGroup::Done, &snapshot.projects).len(),
        1
    );
    let pr = snapshot.cards.iter().find(|card| card.id == "pr").unwrap();
    assert_eq!(
        stacks_cards::work_group(pr, &snapshot.projects),
        WorkGroup::Attention
    );
    assert_eq!(
        stacks_cards::delivery_step(pr, &snapshot.projects).label,
        "PR merge available · Merge PR"
    );
    assert!(pr.pull_request.as_ref().unwrap().blockers.is_empty());
}

#[test]
fn start_local_work_creates_worktree_and_environment() {
    let directory = tempfile::tempdir().unwrap();
    let repository = directory.path().join("repo");
    std::fs::create_dir(&repository).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(&repository)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init", "-b", "main"]);
    git(&["config", "user.email", "test@example.com"]);
    git(&["config", "user.name", "Test"]);
    std::fs::write(repository.join("README.md"), "test\n").unwrap();
    git(&["add", "README.md"]);
    git(&["commit", "-m", "initial"]);

    let path = directory.path().join("workflow.sqlite3");
    create_database(&path);
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE projects SET path=?1 WHERE id='p1'",
            [repository.to_str().unwrap()],
        )
        .unwrap();
    drop(connection);
    let store = CardStore::new(&path);
    let child = store.load_detail("child").unwrap();
    store
        .start_local_work("child", child.card.workflow_revision)
        .unwrap();
    let child = store.load_detail("child").unwrap();
    assert_eq!(child.card.status, CardStatus::AgentWorking);
    let environment = child.card.environment.expect("environment");
    assert_eq!(environment.branch, "stacks/card-2-child");
    assert_eq!(
        environment.worktree_path,
        format!("{}-card-2", repository.to_str().unwrap())
    );
    assert!(Path::new(&environment.worktree_path).is_dir());
    assert_eq!(
        child.events.first().unwrap().event_type,
        "environment_start"
    );
}

#[test]
fn local_workflow_actions_apply_with_revision_guards() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workflow.sqlite3");
    create_database(&path);
    let store = CardStore::new(&path);
    let child = store.load_detail("child").unwrap();
    assert_eq!(child.card.status, CardStatus::Ready);
    store
        .apply_local_action(
            "child",
            WorkflowAction::ReturnToRefinement,
            child.card.workflow_revision,
        )
        .unwrap();
    let child = store.load_detail("child").unwrap();
    assert_eq!(child.card.status, CardStatus::NeedsRefinement);
    assert_eq!(
        child.card.workflow_revision,
        detail_revision(&path, "child")
    );
    let event = child.events.first().unwrap();
    assert_eq!(event.event_type, "return_to_refinement");

    // Stale revisions are rejected without changing the card.
    let stale = store.apply_local_action(
        "child",
        WorkflowAction::ReturnToRefinement,
        child.card.workflow_revision - 1,
    );
    assert!(stale.unwrap_err().to_string().contains("Card changed"));

    let child = store.load_detail("child").unwrap();
    store
        .apply_local_action("child", WorkflowAction::Close, child.card.workflow_revision)
        .unwrap();
    let child = store.load_detail("child").unwrap();
    assert_eq!(child.card.status, CardStatus::Done);
    assert_eq!(child.card.completion_outcome.as_deref(), Some("closed"));
    assert_eq!(child.runtime_cleanup_status.as_deref(), Some("pending"));
    store.complete_local_runtime_cleanup("child", &[]).unwrap();
    let child = store.load_detail("child").unwrap();
    assert_eq!(child.runtime_cleanup_status.as_deref(), Some("complete"));
    assert_eq!(child.events.first().unwrap().event_type, "runtime_cleanup");

    store
        .apply_local_action(
            "backlog-a",
            WorkflowAction::Delete,
            store
                .load_detail("backlog-a")
                .unwrap()
                .card
                .workflow_revision,
        )
        .unwrap();
    assert!(store.load_detail("backlog-a").is_err());
}

fn detail_revision(path: &Path, card_id: &str) -> i64 {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT workflow_revision FROM kanban_cards WHERE id=?1",
            [card_id],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn reorder_backlog_updates_lane_and_reports_conflicts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workflow.sqlite3");
    create_database(&path);
    let store = CardStore::new(&path);
    let snapshot = store.load_snapshot().unwrap();
    let lane = group_cards(&snapshot.cards, WorkGroup::Backlog, &snapshot.projects)
        .into_iter()
        .map(|card| card.id.clone())
        .collect::<Vec<_>>();
    assert_eq!(lane, ["backlog-a", "backlog-b"]);

    let reversed = vec!["backlog-b".to_string(), "backlog-a".to_string()];
    store.reorder_backlog(&lane, &reversed).unwrap();
    let after = store.load_snapshot().unwrap();
    assert_eq!(
        group_cards(&after.cards, WorkGroup::Backlog, &after.projects)
            .into_iter()
            .map(|card| card.id.as_str())
            .collect::<Vec<_>>(),
        ["backlog-b", "backlog-a"]
    );

    // A stale expectation that would change the lane is a conflict.
    let stale = store.reorder_backlog(&lane, &lane).unwrap_err().to_string();
    assert!(stale.contains("KANBAN_REORDER_CONFLICT"));
    // An exact retry is idempotent even when the expectation is stale.
    store.reorder_backlog(&lane, &reversed).unwrap();
}

#[test]
fn filtered_backlog_order_preserves_other_project_slots() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workflow.sqlite3");
    create_database(&path);
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "INSERT INTO kanban_cards(id,external_provider,external_id,title,status,project_id,created_at,updated_at,sort_order)
             VALUES ('other','local:z','10','Other','needs_refinement','p2',10,10,2);",
        )
        .unwrap();
    let store = CardStore::new(&path);
    let snapshot = store.load_snapshot().unwrap();
    let visible = vec!["backlog-b".to_string(), "backlog-a".to_string()];
    let full = store.filtered_backlog_order(&snapshot, &visible);
    assert_eq!(full, ["backlog-b", "backlog-a", "other"]);
}

#[test]
fn work_group_matches_list_sections() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workflow.sqlite3");
    create_database(&path);
    let snapshot = CardStore::new(&path).load_snapshot().unwrap();
    for card in &snapshot.cards {
        let group = work_group(card, &snapshot.projects);
        assert!(group.statuses().contains(&card.status) || card.status == CardStatus::Approved);
    }
}

#[test]
fn out_of_scope_parent_does_not_leak_into_child_summary() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workflow.sqlite3");
    create_database(&path);
    let connection = Connection::open(&path).unwrap();
    connection
        .execute("UPDATE kanban_cards SET in_scope=0 WHERE id='parent'", [])
        .unwrap();
    let snapshot = CardStore::new(&path).load_snapshot().unwrap();
    let child = snapshot
        .cards
        .iter()
        .find(|card| card.id == "child")
        .unwrap();
    assert!(child.parent.is_none());
    assert_eq!(child.status, CardStatus::Ready);
    assert!(!snapshot.cards.iter().any(|card| card.id == "parent"));
}

#[test]
fn loads_read_only_card_detail_with_content_and_events() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workflow.sqlite3");
    create_database(&path);
    let store = CardStore::new(&path);
    let detail = store.load_detail("parent").unwrap();
    assert_eq!(detail.card.id, "parent");
    assert_eq!(detail.card.status, CardStatus::Ready);
    assert!(detail.content.contains("Render the content"));
    assert_eq!(detail.card_url, "https://example.test/cards/1");
    assert_eq!(detail.events.len(), 2);
    assert_eq!(detail.events[0].event_type, "agent_started");
    assert!(detail.events[1].to_status == Some(CardStatus::Ready));
    assert!(store.load_detail("missing").is_err());

    let backlog = store.load_detail("backlog-b").unwrap();
    let actions = backlog
        .capabilities
        .iter()
        .map(|capability| capability.label.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        actions,
        [
            "Refine",
            "Start work",
            "Write plan & finish refinement",
            "Delete card",
            "Close without delivery",
        ]
    );
    let primary = backlog
        .capabilities
        .iter()
        .find(|capability| capability.primary)
        .unwrap();
    assert_eq!(primary.label, "Refine");
}
