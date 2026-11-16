use std::{path::Path, sync::Arc};

use rusqlite::Connection;
use stacks_core::{
    CardStatus,
    github::{GithubPullRequest, GithubStatus},
    store::CardStore,
};
use stacks_tui::{
    app::{App, DetailTab, Focus, Screen},
    headless,
    keys::Key,
};

fn fixture(path: &Path) {
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
                target_branch TEXT, start_work_command TEXT, deployment_command TEXT,
                enable_mcp INTEGER NOT NULL DEFAULT 0,
                mcp_env_names TEXT NOT NULL DEFAULT '',
                superthread_api_token_env_var TEXT
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
            CREATE TABLE kanban_project_sequences (
                project_id TEXT PRIMARY KEY, next_number INTEGER NOT NULL
            );
            INSERT INTO projects(id,name,path,color_id,delivery_workflow,kanban_source,sort_order)
                VALUES ('p1','Arcasa','/tmp/arcasa','violet','local_merge','local',0),
                       ('p2','Stacks','/tmp/stacks','slate','github_pull_request','local',1);
            INSERT INTO kanban_cards(id,external_provider,external_id,title,content,status,project_id,
                hierarchy_finalized,provider_child_count,created_at,updated_at,sort_order)
                VALUES ('local:325','local:p1','325','Build a keyboard-only Rust TUI','## Objective
Ship it.','needs_refinement','p1',0,0,1,1,0),
                       ('local:326','local:p2','326','Wire the automation socket','','ready','p2',0,0,2,2,0),
                       ('local:327','local:p2','327','Deleted card','','done','p2',0,0,3,3,1);
            INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,summary)
                VALUES ('local:326',10,'user','start_work','success','Started the agent');
            "#,
        )
        .unwrap();
}

fn app() -> (App, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workflow.sqlite3");
    fixture(&path);
    let store = Arc::new(CardStore::new(path));
    let board = store.load_snapshot().unwrap();
    let mut app = App::new(store, dir.path().join("automation.sock"), Some(board), true);
    app.hide_done = false;
    app.preferences.hide_done = false;
    app.recompute_rows();
    (app, dir)
}

#[test]
fn board_shows_real_projects_and_groups() {
    let (mut app, _dir) = app();
    let screen = headless::dump(&mut app, 120, 40);
    assert!(screen.contains("Arcasa"), "{screen}");
    assert!(screen.contains("NEEDS YOUR ACTION"), "{screen}");
    assert!(screen.contains("BACKLOG"), "{screen}");
    assert!(screen.contains("#325"), "{screen}");
    assert!(
        screen.contains("Build a keyboard-only Rust TUI"),
        "{screen}"
    );
    assert!(screen.contains("Ctrl-F"), "{screen}");
}

#[test]
fn number_selects_detail_tabs() {
    let (mut app, _dir) = app();
    app.handle_key(Key::Enter);
    app.pump(1_000);
    app.handle_key(Key::Char('3'));
    assert_eq!(app.detail_tab, stacks_tui::app::DetailTab::Diff);
    app.handle_key(Key::Char('2'));
    assert_eq!(app.detail_tab, stacks_tui::app::DetailTab::Agent);
    assert_eq!(app.screen, stacks_tui::app::Screen::Detail);
}

#[test]
fn selected_card_shows_branch_git_and_pr_detail_line() {
    let (mut app, _dir) = app();
    let screen = headless::dump(&mut app, 120, 40);
    assert!(screen.contains("no worktree  ·  —  ·  no PR"), "{screen}");
}

#[test]
fn below_minimum_size_keeps_state_and_explains() {
    let (mut app, _dir) = app();
    let small = headless::dump(&mut app, 80, 24);
    assert!(small.contains("Terminal too small"), "{small}");
    assert!(small.contains("100×30"), "{small}");
    let normal = headless::dump(&mut app, 120, 40);
    assert!(normal.contains("Build a keyboard-only"));
}

#[test]
fn card_detail_loads_overview_and_backend_actions() {
    let (mut app, _dir) = app();
    app.handle_key(Key::Enter);
    app.pump(1_000);
    let screen = headless::dump(&mut app, 120, 40);
    assert!(screen.contains("#326"), "{screen}");
    assert!(screen.contains("Overview"), "{screen}");
    assert!(screen.contains("Agent"), "{screen}");
    app.handle_key(Key::Char('a'));
    let actions = headless::dump(&mut app, 120, 40);
    assert!(actions.contains("Start work"), "{actions}");
}

#[test]
fn filter_is_applied_and_not_discarded_by_escape() {
    let (mut app, _dir) = app();
    app.handle_key(Key::Char('/'));
    app.type_text("missing");
    app.handle_key(Key::Esc);
    let screen = headless::dump(&mut app, 120, 40);
    assert!(screen.contains("No cards match"), "{screen}");
    assert!(!screen.contains("#325"), "{screen}");
}

#[test]
fn palette_fuzzy_matches_cards_and_projects() {
    let (mut app, _dir) = app();
    app.handle_key(Key::Ctrl('p'));
    app.type_text("Arcasa");
    let screen = headless::dump(&mut app, 120, 40);
    assert!(screen.contains("Command palette"), "{screen}");
    assert!(screen.contains("Arcasa"), "{screen}");
    assert!(screen.contains("Project"), "{screen}");
}

#[test]
fn palette_prefers_a_literal_settings_command_over_fuzzy_card_titles() {
    let (mut app, _dir) = app();
    app.handle_key(Key::Ctrl('p'));
    app.type_text("settings");
    let first = &app.palette_items[0];
    assert!(
        first.label.to_ascii_lowercase().contains("settings"),
        "first palette item was {:?}",
        first.label
    );
    assert!(
        first.hint != "Card",
        "first palette item was a card: {first:?}"
    );
}

#[test]
fn project_sidebar_is_keyboard_navigable_and_filters_on_enter() {
    let (mut app, _dir) = app();
    app.handle_key(Key::Tab);
    assert_eq!(app.focus, stacks_tui::app::Focus::Sidebar);
    app.handle_key(Key::Char('j'));
    assert_eq!(app.sidebar_cursor, 1);
    let screen = headless::dump(&mut app, 120, 40);
    assert!(screen.contains("▶ Arcasa"), "{screen}");
    app.handle_key(Key::Enter);
    assert_eq!(app.project_scope.as_deref(), Some("p1"));
    assert_eq!(app.focus, stacks_tui::app::Focus::Sidebar);
    let screen = headless::dump(&mut app, 120, 40);
    assert!(screen.contains("PROJECTS 2 · Arcasa"), "{screen}");
    assert!(screen.contains("#325"), "{screen}");
    assert!(!screen.contains("#326"), "{screen}");
    app.handle_key(Key::Esc);
    assert_eq!(app.focus, stacks_tui::app::Focus::Board);
}

#[test]
fn help_renders_the_keymap_table() {
    let (mut app, _dir) = app();
    app.handle_key(Key::Char('?'));
    let screen = headless::dump(&mut app, 120, 40);
    assert!(screen.contains("Keyboard reference"), "{screen}");
    assert!(screen.contains("Ctrl-P"), "{screen}");
    app.handle_key(Key::Char('G'));
    let screen = headless::dump(&mut app, 120, 40);
    assert!(screen.contains("Release input"), "{screen}");
}

#[test]
fn script_replays_keys_and_assertions() {
    let (mut app, _dir) = app();
    let mut cols = 120;
    let mut rows = 40;
    let lines = [
        "key ctrl-p".to_string(),
        "type Arcasa".to_string(),
        "assert contains Command palette".to_string(),
        "assert contains Arcasa".to_string(),
        "key esc".to_string(),
        "assert not-contains Command palette".to_string(),
    ];
    headless::run_script(&mut app, &lines, &mut cols, &mut rows).unwrap();
}

#[test]
fn card_session_terminal_keeps_running_while_hidden() {
    let (mut app, dir) = app();
    let project_dir = dir.path().join("stacks");
    std::fs::create_dir_all(&project_dir).unwrap();
    for project in &mut app.board.as_mut().unwrap().projects {
        if project.id == "p2" {
            project.path = project_dir.to_string_lossy().into_owned();
        }
    }
    app.open_detail("local:326".into());
    app.pump(500);
    app.handle_key(Key::Char('4'));
    app.pump(500);
    app.type_text("echo CACHE_MARK");
    app.handle_key(Key::Enter);
    app.pump(500);
    app.handle_key(Key::Ctrl('w'));
    app.handle_key(Key::Ctrl('w'));
    app.handle_key(Key::Esc);
    app.open_detail("local:325".into());
    app.pump(500);
    app.close_detail();
    app.open_detail("local:326".into());
    app.pump(500);
    let screen = headless::dump(&mut app, 120, 40);
    assert!(screen.contains("CACHE_MARK"), "{screen}");
}

#[test]
fn pull_request_sync_updates_card_pr_and_ci_state() {
    let (mut app, dir) = app();
    let connection = Connection::open(dir.path().join("workflow.sqlite3")).unwrap();
    connection
        .execute(
            "INSERT INTO card_environments
             (id,card_id,project_id,worktree_path,branch,lifecycle_state,revision,created_at,updated_at)
             VALUES ('e1','local:326','p2','/tmp/stacks','feature-326','ready',1,1,1)",
            [],
        )
        .unwrap();
    drop(connection);
    let updated = app
        .store
        .sync_project_pull_requests(
            "p2",
            "org/repo",
            &[GithubPullRequest {
                number: 42,
                title: "Card PR".into(),
                author: "dev".into(),
                ci_status: GithubStatus::Success,
                has_merge_conflicts: false,
                head_ref_name: "feature-326".into(),
                head_revision: Some("abc".into()),
                url: "https://example.invalid/42".into(),
                draft: false,
                state: "open".into(),
            }],
        )
        .unwrap();
    assert_eq!(updated, 1);
    app.refresh_board();
    app.pump(1_000);
    let card = app
        .board
        .as_ref()
        .unwrap()
        .cards
        .iter()
        .find(|card| card.id == "local:326")
        .unwrap();
    assert_eq!(card.pull_request.as_ref().unwrap().number, 42);
    assert_eq!(card.pull_request.as_ref().unwrap().ci_status, "success");
}

#[test]
fn project_settings_can_be_edited_from_the_project_list() {
    let (mut app, dir) = app();
    let project_dir = dir.path().join("edited-project");
    std::fs::create_dir_all(&project_dir).unwrap();
    app.handle_key(Key::Char('h'));
    app.handle_key(Key::Char('j'));
    app.handle_key(Key::Char('j'));
    app.handle_key(Key::Char('e'));
    let state = app.edit_project.as_mut().unwrap();
    state.name = stacks_tui::widgets::TextInput::new("Renamed Project");
    state.path = stacks_tui::widgets::TextInput::new(project_dir.to_string_lossy());
    state.server = stacks_tui::widgets::TextInput::new("npm run dev");
    app.handle_key(Key::Ctrl('s'));
    app.pump(1_000);
    let project = app
        .board
        .as_ref()
        .unwrap()
        .projects
        .iter()
        .find(|project| project.name == "Renamed Project")
        .unwrap();
    assert_eq!(project.server_command.as_deref(), Some("npm run dev"));
}

#[test]
fn a_project_without_active_work_can_be_deleted() {
    let (mut app, dir) = app();
    let project_dir = dir.path().join("deletable-project");
    std::fs::create_dir_all(&project_dir).unwrap();
    let project_id = app
        .store
        .create_project("Deletable", project_dir.to_str().unwrap())
        .unwrap();
    app.refresh_board();
    app.pump(500);
    app.focus = Focus::Sidebar;
    app.sidebar_cursor = app
        .board
        .as_ref()
        .unwrap()
        .projects
        .iter()
        .position(|project| project.id == project_id)
        .unwrap()
        + 1;
    app.preferences.confirmation_delay_ms = 0;
    app.handle_key(Key::Char('D'));
    app.handle_key(Key::Char('1'));
    app.pump(1_000);
    assert!(
        !app.board
            .as_ref()
            .unwrap()
            .projects
            .iter()
            .any(|project| project.id == project_id)
    );
}

#[test]
fn card_sessions_and_tab_survive_detail_navigation() {
    let (mut app, _dir) = app();
    app.open_detail("local:326".into());
    app.detail_tab = DetailTab::Terminal;
    app.terminal_focus = true;
    app.close_detail();
    assert!(app.card_sessions.contains_key("local:326"));
    app.open_detail("local:326".into());
    assert_eq!(app.detail_tab, DetailTab::Terminal);
    assert!(app.terminal_focus);
}

#[test]
fn adding_a_project_from_the_project_list_opens_its_workspace() {
    let (mut app, dir) = app();
    let project_dir = dir.path().join("new-project");
    std::fs::create_dir_all(&project_dir).unwrap();
    app.handle_key(Key::Char('h'));
    app.handle_key(Key::Char('n'));
    app.type_text(project_dir.to_str().unwrap());
    app.handle_key(Key::Tab);
    app.type_text("New Project");
    app.handle_key(Key::Enter);
    app.pump(2_000);
    assert_eq!(app.screen, Screen::Project);
    assert!(
        app.board
            .as_ref()
            .unwrap()
            .projects
            .iter()
            .any(|project| project.name == "New Project")
    );
}

#[test]
fn opening_card_detail_drops_board_scope_message() {
    let (mut app, _dir) = app();
    app.message = "Project filter: all projects".into();
    app.open_detail("local:326".into());
    assert!(app.message.is_empty(), "{}", app.message);
}

#[test]
fn project_workspace_opens_and_saves_notes() {
    let (mut app, dir) = app();
    let mut cols = 120;
    let mut rows = 40;
    let lines = [
        "key w".to_string(),
        "assert contains 1 Notes".to_string(),
        "key e".to_string(),
        "type Project scratch pad".to_string(),
        "key ctrl-s".to_string(),
    ];
    headless::run_script(&mut app, &lines, &mut cols, &mut rows).unwrap();
    assert_eq!(app.screen, Screen::Project);
    let project_id = app.project.as_ref().unwrap().project_id.clone();
    let notes: String = Connection::open(dir.path().join("workflow.sqlite3"))
        .unwrap()
        .query_row(
            "SELECT notes FROM projects WHERE id=?1",
            [project_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(notes, "Project scratch pad");
}

#[test]
fn board_golden_is_stable() {
    let (mut app, _dir) = app();
    let screen = headless::dump(&mut app, 120, 40);
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::write(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden/board_120x40.txt"),
            &screen,
        )
        .unwrap();
    }
    let golden = include_str!("golden/board_120x40.txt");
    assert_eq!(screen, golden, "\n{screen}");
}

#[cfg(unix)]
#[test]
fn automation_socket_reports_pi_lifecycle_into_the_card_status() {
    use stacks_core::automation::{self, AutomationHost};
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    struct Host;
    impl AutomationHost for Host {
        fn state_changed(&self, _card_id: &str) {}
        fn notify(&self, _message: &str) {}
    }

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workflow.sqlite3");
    fixture(&path);
    Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE kanban_cards SET status='needs_refinement_input' WHERE id='local:325'",
            [],
        )
        .unwrap();
    let store = CardStore::new(path);
    let socket = dir.path().join("automation.sock");
    let _guard =
        automation::start_at(socket.clone(), store.clone(), std::sync::Arc::new(Host)).unwrap();

    let mut stream = UnixStream::connect(&socket).unwrap();
    writeln!(
        stream,
        "{{\"action\":\"agentLifecycle\",\"cardId\":\"local:325\",\"thread\":\"planning\",\"phase\":\"started\"}}"
    )
    .unwrap();
    let mut response = String::new();
    BufReader::new(stream).read_line(&mut response).unwrap();
    assert!(response.contains("\"ok\":true"), "{response}");

    let detail = store.load_detail("local:325").unwrap();
    assert_eq!(detail.card.status, CardStatus::Refining);
}

#[test]
fn new_card_dialog_can_change_project() {
    let (mut app, _dir) = app();
    app.handle_key(Key::Char('n'));
    app.handle_key(Key::BackTab);
    let first = app.new_card.as_ref().unwrap().project_id.clone();
    app.handle_key(Key::Right);
    let second = app.new_card.as_ref().unwrap().project_id.clone();
    assert_ne!(first, second);
    app.handle_key(Key::Left);
    assert_eq!(app.new_card.as_ref().unwrap().project_id, first);
}

#[test]
fn new_card_flow_creates_and_opens_the_card() {
    let (mut app, _dir) = app();
    app.handle_key(Key::Char('n'));
    app.type_text("TUI action smoke");
    app.handle_key(Key::Tab);
    app.type_text("Script-created card for the workflow action smoke test.");
    assert_eq!(app.new_card.as_ref().map(|state| state.focus), Some(2));
    app.handle_key(Key::Enter);
    assert!(
        app.in_flight > 0,
        "submit did not start; error={:?} message={:?}",
        app.error,
        app.message
    );
    app.pump(1_000);
    assert!(
        app.new_card.is_none(),
        "new-card state left behind; error={:?} message={:?}",
        app.error,
        app.message
    );
    assert!(
        app.overlay.is_none(),
        "overlay still open; error={:?} message={:?}",
        app.error,
        app.message
    );
    assert_eq!(app.screen, stacks_tui::app::Screen::Detail);
    assert!(
        app.detail
            .as_ref()
            .is_some_and(|detail| detail.card.title == "TUI action smoke")
    );
}

#[test]
fn positive_filter_matches_external_id_and_title() {
    let (mut app, _dir) = app();
    app.handle_key(Key::Char('/'));
    app.type_text("325");
    app.handle_key(Key::Esc);
    assert_eq!(app.filter, "325");
    let screen = headless::dump(&mut app, 120, 40);
    assert!(screen.contains("#325"), "{screen}");
    assert!(!screen.contains("#326"), "{screen}");
}

#[test]
fn section_headers_are_focusable_and_collapse() {
    let (mut app, _dir) = app();
    app.board_cursor = 0;
    assert_eq!(app.board_rows[0].kind, stacks_tui::app::BoardRowKind::Group);
    app.handle_key(Key::Enter);
    assert!(app.collapsed_groups[0]);
    let screen = headless::dump(&mut app, 120, 40);
    assert!(!screen.contains("#326"), "{screen}");
    app.handle_key(Key::Enter);
    assert!(!app.collapsed_groups[0]);
    let screen = headless::dump(&mut app, 120, 40);
    assert!(screen.contains("#326"), "{screen}");
}

#[test]
fn card_numbers_and_titles_align_after_section_indent() {
    let (mut app, _dir) = app();
    let screen = headless::dump(&mut app, 120, 40);
    let line_326 = screen.lines().find(|line| line.contains("#326")).unwrap();
    let line_325 = screen.lines().find(|line| line.contains("#325")).unwrap();
    let wire_column = line_326[..line_326.find("Wire").unwrap()].chars().count();
    let build_column = line_325[..line_325.find("Build").unwrap()].chars().count();
    assert_eq!(wire_column, build_column, "{line_326}\n{line_325}");
    assert!(line_326.contains("#326 "), "{line_326}");
}
