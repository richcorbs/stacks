use super::*;
#[allow(unused_imports)]
use super::{
    cards::*, cleanup::*, domain::*, environment::*, git_effects::*, github_delivery::*, health::*,
    local_delivery::*, sync::*,
};

pub(in crate::kanban) fn next_local_card_number(
    connection: &Connection,
    project_id: &str,
) -> Result<i64, String> {
    connection
        .query_row(
            "INSERT INTO kanban_project_sequences (project_id, next_number) VALUES (?1, 2)
         ON CONFLICT(project_id) DO UPDATE SET next_number = next_number + 1
         RETURNING next_number - 1",
            [project_id],
            |row| row.get(0),
        )
        .map_err(db_error)
}

pub(crate) fn initialize_database() -> Result<(), String> {
    initialize_once(&DATABASE_INITIALIZATION, || {
        let path = app_data_file("workflow.sqlite3")
            .map_err(|error| format!("Could not locate the Kanban database: {error}"))?;
        let mut connection = Connection::open(&path).map_err(|error| {
            format!(
                "Could not open the Kanban database at {}: {error}",
                path.display()
            )
        })?;
        configure_connection(&connection)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| format!("Could not enable WAL mode: {error}"))?;
        initialize_connection(&mut connection, true)
    })
}

pub(in crate::kanban) fn initialize_once(
    state: &OnceLock<Result<(), String>>,
    initialize: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    state.get_or_init(initialize).clone()
}

pub(in crate::kanban) fn initialize_connection(
    connection: &mut Connection,
    import_legacy_json: bool,
) -> Result<(), String> {
    migrate(connection).map_err(|error| format!("Could not initialize Kanban schema: {error}"))?;
    crate::store::migrate_store_schema(connection)
        .map_err(|error| format!("Could not initialize project-store schema: {error}"))?;
    crate::project_direct::migrate(connection)
        .map_err(|error| format!("Could not initialize Project Workspace schema: {error}"))?;
    crate::global_terminal::migrate(connection)
        .map_err(|error| format!("Could not initialize top-level terminal schema: {error}"))?;
    crate::release::migrate(connection)
        .map_err(|error| format!("Could not initialize release schema: {error}"))?;
    crate::store::migrate_legacy_data(connection, import_legacy_json)
        .map_err(|error| format!("Could not initialize legacy project data: {error}"))?;
    crate::settings::migrate_superthread_project_configuration(connection)
        .map_err(|error| format!("Could not migrate Superthread project configuration: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("Could not re-enable database foreign keys: {error}"))?;
    let foreign_keys: i64 = connection
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .map_err(db_error)?;
    if foreign_keys != 1 {
        return Err("Database initialization completed without foreign keys enabled".to_string());
    }
    Ok(())
}

pub(in crate::kanban) fn configure_connection(connection: &Connection) -> Result<(), String> {
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| format!("Could not configure the database busy timeout: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("Could not enable database foreign keys: {error}"))
}

pub(crate) fn with_connection<T>(
    work: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    // Serialize the complete read/mutate/revision cycle. SQLite serializes writes,
    // but without this lock a second window could commit between a mutation and
    // its revision bookkeeping, causing one logical operation to claim another's
    // entity changes.
    let _guard = BOARD_OPERATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Kanban board operation lock failed".to_string())?;
    let path = app_data_file("workflow.sqlite3")?;
    let mut connection = Connection::open(path).map_err(db_error)?;
    configure_connection(&connection)?;
    let before = serialized_board_entities(&mut connection)?;
    let result = work(&mut connection);
    let after = serialized_board_entities(&mut connection)?;
    if let Some(change) = commit_board_revision(&mut connection, &before, &after)? {
        if let Some(app) = APP_HANDLE.get() {
            if let Err(error) = app.emit("kanban-board-changed", &change) {
                eprintln!("Kanban mutation committed at board revision {}, but event delivery failed: {error}", change.board_revision);
            }
        }
    }
    result
}

pub(in crate::kanban) fn serialized_board_entities(
    connection: &mut Connection,
) -> Result<HashMap<String, String>, String> {
    let mut cards = list_cards(connection)?;
    cards
        .iter_mut()
        .map(|card| {
            // A revision is metadata about freshness, not part of the serialized
            // entity change being detected.
            card.record_revision = 0;
            serde_json::to_string(card)
                .map(|serialized| (card.id.clone(), serialized))
                .map_err(|error| error.to_string())
        })
        .collect()
}

pub(in crate::kanban) fn board_revision(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT board_revision FROM kanban_board_metadata WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(db_error)
}

pub(in crate::kanban) fn board_snapshot(
    connection: &mut Connection,
) -> Result<BoardSnapshot, String> {
    Ok(BoardSnapshot {
        cards: list_cards(connection)?,
        board_revision: board_revision(connection)?,
    })
}

pub(in crate::kanban) fn fresh_card_snapshot(id: &str) -> Result<CardSnapshot, String> {
    with_connection(|connection| {
        let card =
            get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string())?;
        Ok(CardSnapshot {
            card,
            board_revision: board_revision(connection)?,
        })
    })
}

pub(in crate::kanban) fn commit_board_revision(
    connection: &mut Connection,
    before: &HashMap<String, String>,
    after: &HashMap<String, String>,
) -> Result<Option<BoardChange>, String> {
    let mut changed_ids = after
        .iter()
        .filter(|(id, value)| before.get(*id) != Some(*value))
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    let mut removed_ids = before
        .keys()
        .filter(|id| !after.contains_key(*id))
        .cloned()
        .collect::<Vec<_>>();
    changed_ids.sort();
    removed_ids.sort();
    if changed_ids.is_empty() && removed_ids.is_empty() {
        return Ok(None);
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    transaction
        .execute(
            "UPDATE kanban_board_metadata SET board_revision=board_revision+1 WHERE singleton=1",
            [],
        )
        .map_err(db_error)?;
    for id in &changed_ids {
        transaction
            .execute(
                "UPDATE kanban_cards SET record_revision=record_revision+1 WHERE id=?1",
                [id],
            )
            .map_err(db_error)?;
    }
    let revision: i64 = transaction
        .query_row(
            "SELECT board_revision FROM kanban_board_metadata WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    let mut upserts = Vec::with_capacity(changed_ids.len());
    for id in changed_ids {
        if let Some(card) = get_card(connection, &id)? {
            upserts.push(card);
        }
    }
    Ok(Some(BoardChange {
        upserts,
        removed_ids,
        board_revision: revision,
    }))
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), String> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS kanban_cards (
            id TEXT PRIMARY KEY,
            external_provider TEXT NOT NULL,
            external_id TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            board_id TEXT NOT NULL DEFAULT '',
            board_title TEXT NOT NULL DEFAULT '',
            list_id TEXT NOT NULL DEFAULT '',
            list_title TEXT NOT NULL DEFAULT '',
            card_url TEXT NOT NULL DEFAULT '',
            assignee_names TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'needs_refinement'
                CHECK(status IN ('needs_refinement', 'refining', 'needs_refinement_input', 'ready', 'agent_working', 'needs_human', 'approved', 'done')),
            completion_outcome TEXT CHECK(completion_outcome IN ('merged', 'closed')),
            feature_environment INTEGER NOT NULL DEFAULT 0,
            delivery_operation_stage TEXT,
            delivery_error TEXT,
            runtime_cleanup_status TEXT CHECK(runtime_cleanup_status IN ('pending', 'complete', 'failed')),
            runtime_cleanup_error TEXT,
            workflow_revision INTEGER NOT NULL DEFAULT 1,
            record_revision INTEGER NOT NULL DEFAULT 1,
            project_id TEXT,
            workspace_id TEXT,
            parent_id TEXT,
            hierarchy_finalized INTEGER NOT NULL DEFAULT 0,
            provider_child_count INTEGER NOT NULL DEFAULT 0,
            provider_parent_title TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            in_scope INTEGER NOT NULL DEFAULT 1,
            scope_suspended INTEGER NOT NULL DEFAULT 0,
            scope_prior_status TEXT,
            UNIQUE(external_provider, external_id)
         );
         CREATE INDEX IF NOT EXISTS kanban_cards_status_idx ON kanban_cards(status, updated_at);
         CREATE TABLE IF NOT EXISTS kanban_board_metadata (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            board_revision INTEGER NOT NULL DEFAULT 0
         );
         INSERT OR IGNORE INTO kanban_board_metadata(singleton, board_revision) VALUES (1, 0);
         CREATE TABLE IF NOT EXISTS card_pull_requests (
            card_id TEXT PRIMARY KEY REFERENCES kanban_cards(id) ON DELETE CASCADE,
            repository TEXT NOT NULL,
            number INTEGER NOT NULL,
            title TEXT NOT NULL,
            url TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('open', 'closed', 'merged')),
            draft INTEGER NOT NULL DEFAULT 0,
            ci_status TEXT NOT NULL DEFAULT 'unknown',
            review_state TEXT NOT NULL DEFAULT 'unknown',
            has_conflicts INTEGER NOT NULL DEFAULT 0,
            mergeable INTEGER NOT NULL DEFAULT 0,
            head_revision TEXT,
            updated_at INTEGER NOT NULL,
            UNIQUE(repository, number)
         );
         CREATE TABLE IF NOT EXISTS kanban_project_sequences (
            project_id TEXT PRIMARY KEY,
            next_number INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS card_environments (
            id TEXT PRIMARY KEY,
            card_id TEXT NOT NULL UNIQUE REFERENCES kanban_cards(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL,
            worktree_path TEXT NOT NULL,
            branch TEXT NOT NULL DEFAULT '',
            repository_id TEXT,
            target_checkout_path TEXT,
            target_branch TEXT,
            source_revision TEXT,
            target_revision TEXT,
            lifecycle_state TEXT NOT NULL DEFAULT 'ready' CHECK(lifecycle_state IN ('creating', 'ready', 'cleanup_pending', 'cleanup_failed')),
            revision INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS environment_creation_operations (
            id TEXT PRIMARY KEY,
            card_id TEXT NOT NULL UNIQUE REFERENCES kanban_cards(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL,
            repository_id TEXT NOT NULL,
            expected_workflow_revision INTEGER NOT NULL,
            target_checkout_path TEXT NOT NULL,
            target_branch TEXT NOT NULL,
            observed_target_revision TEXT NOT NULL,
            setup_command TEXT NOT NULL,
            custom_command INTEGER NOT NULL DEFAULT 0,
            phase TEXT NOT NULL CHECK(phase IN ('prepared','setup_running','setup_complete','attaching','compensation_pending','recovery_required')),
            attempt_token TEXT,
            result_path TEXT NOT NULL,
            pre_worktrees TEXT NOT NULL,
            pre_branches TEXT NOT NULL,
            post_worktrees TEXT,
            post_branches TEXT,
            setup_result_cwd TEXT,
            setup_output TEXT,
            source_path TEXT,
            source_branch TEXT,
            source_revision TEXT,
            source_worktree_new INTEGER NOT NULL DEFAULT 0,
            source_branch_new INTEGER NOT NULL DEFAULT 0,
            worktree_removed INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            cleanup_available INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS card_target_merge_operations (
            id TEXT PRIMARY KEY,
            card_id TEXT NOT NULL UNIQUE REFERENCES kanban_cards(id) ON DELETE CASCADE,
            environment_id TEXT NOT NULL,
            workflow_revision INTEGER NOT NULL,
            environment_revision INTEGER NOT NULL,
            initial_status TEXT NOT NULL CHECK(initial_status IN ('needs_human','approved')),
            repository_id TEXT NOT NULL,
            source_path TEXT NOT NULL,
            source_branch TEXT NOT NULL,
            target_branch TEXT NOT NULL,
            upstream_remote TEXT NOT NULL,
            upstream_merge_ref TEXT NOT NULL,
            source_revision TEXT NOT NULL,
            target_revision TEXT NOT NULL,
            target_source TEXT NOT NULL DEFAULT 'remote' CHECK(target_source IN ('local','remote')),
            phase TEXT NOT NULL CHECK(phase IN ('conflicted','merged')),
            conflict_paths TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS card_cleanup_operations (
            card_id TEXT PRIMARY KEY REFERENCES kanban_cards(id) ON DELETE CASCADE,
            environment_id TEXT NOT NULL,
            workflow_revision INTEGER NOT NULL,
            environment_revision INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending', 'failed', 'completed')),
            phase TEXT NOT NULL,
            completion_outcome TEXT NOT NULL CHECK(completion_outcome IN ('merged', 'closed')),
            repository_id TEXT NOT NULL,
            source_path TEXT NOT NULL,
            target_path TEXT NOT NULL,
            source_branch TEXT NOT NULL,
            target_branch TEXT NOT NULL,
            source_revision TEXT NOT NULL,
            target_revision TEXT,
            delete_local_branch INTEGER NOT NULL,
            delete_remote_branch INTEGER NOT NULL,
            merged_pr_repository TEXT,
            merged_pr_number INTEGER,
            merged_pr_head_revision TEXT,
            pane_ids TEXT NOT NULL DEFAULT '[]',
            registration_validated INTEGER NOT NULL DEFAULT 0,
            validation_completed_at INTEGER,
            error_code TEXT,
            error_detail TEXT,
            started_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER
         );
         CREATE TRIGGER IF NOT EXISTS card_cleanup_snapshot_immutable BEFORE UPDATE ON card_cleanup_operations
         WHEN NEW.environment_id IS NOT OLD.environment_id OR NEW.workflow_revision IS NOT OLD.workflow_revision
           OR NEW.environment_revision IS NOT OLD.environment_revision OR NEW.completion_outcome IS NOT OLD.completion_outcome
           OR NEW.repository_id IS NOT OLD.repository_id OR NEW.source_path IS NOT OLD.source_path OR NEW.target_path IS NOT OLD.target_path
           OR NEW.source_branch IS NOT OLD.source_branch OR NEW.target_branch IS NOT OLD.target_branch OR NEW.source_revision IS NOT OLD.source_revision
           OR NEW.target_revision IS NOT OLD.target_revision OR NEW.delete_local_branch IS NOT OLD.delete_local_branch OR NEW.delete_remote_branch IS NOT OLD.delete_remote_branch
           OR NEW.merged_pr_repository IS NOT OLD.merged_pr_repository OR NEW.merged_pr_number IS NOT OLD.merged_pr_number
           OR NEW.merged_pr_head_revision IS NOT OLD.merged_pr_head_revision OR NEW.pane_ids IS NOT OLD.pane_ids
         BEGIN SELECT RAISE(ABORT, 'cleanup operation snapshot is immutable'); END;
         CREATE TABLE IF NOT EXISTS card_panes (
            id TEXT PRIMARY KEY,
            environment_id TEXT NOT NULL REFERENCES card_environments(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('terminal', 'pi')),
            command TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS card_layouts (
            environment_id TEXT PRIMARY KEY REFERENCES card_environments(id) ON DELETE CASCADE,
            split_layout TEXT NOT NULL,
            focused_pane_id TEXT,
            layout_revision INTEGER NOT NULL DEFAULT 1,
            updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS card_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id TEXT NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL,
            actor TEXT NOT NULL,
            event_type TEXT NOT NULL,
            outcome TEXT NOT NULL,
            from_status TEXT,
            to_status TEXT,
            summary TEXT,
            error_code TEXT,
            error_detail TEXT
         );
         CREATE INDEX IF NOT EXISTS card_events_card_idx ON card_events(card_id, created_at DESC);
         CREATE TABLE IF NOT EXISTS card_pi_lifecycle (
            card_id TEXT NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
            thread TEXT NOT NULL CHECK(thread IN ('planning','work')),
            generation TEXT NOT NULL,
            latest_event_order INTEGER NOT NULL DEFAULT -1,
            latest_event_id TEXT NOT NULL DEFAULT '',
            PRIMARY KEY(card_id, thread)
         );
         CREATE TABLE IF NOT EXISTS card_pi_lifecycle_events (
            card_id TEXT NOT NULL,
            thread TEXT NOT NULL,
            generation TEXT NOT NULL,
            event_id TEXT NOT NULL,
            PRIMARY KEY(card_id, thread, generation, event_id),
            FOREIGN KEY(card_id, thread) REFERENCES card_pi_lifecycle(card_id, thread) ON DELETE CASCADE
         );
         CREATE TRIGGER IF NOT EXISTS card_events_bound AFTER INSERT ON card_events BEGIN
            DELETE FROM card_events WHERE card_id = NEW.card_id AND id NOT IN (
              SELECT id FROM card_events WHERE card_id = NEW.card_id ORDER BY created_at DESC, id DESC LIMIT 200
            );
         END;
         CREATE TABLE IF NOT EXISTS card_service_definitions (
            id TEXT PRIMARY KEY,
            environment_id TEXT NOT NULL REFERENCES card_environments(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            command TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
         );
         INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, unixepoch());"
    ).map_err(db_error)?;
    connection.execute_batch("DROP TABLE IF EXISTS kanban_cleaned_cards; INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (66, unixepoch());").map_err(db_error)?;
    migrate_done_status(connection)?;
    migrate_refinement_statuses(connection)?;
    let columns = connection
        .prepare("PRAGMA table_info(kanban_cards)")
        .map_err(db_error)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    if !columns.iter().any(|column| column == "sort_order") {
        connection
            .execute(
                "ALTER TABLE kanban_cards ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(db_error)?;
    }
    if !columns.iter().any(|column| column == "assignee_names") {
        connection
            .execute(
                "ALTER TABLE kanban_cards ADD COLUMN assignee_names TEXT NOT NULL DEFAULT '[]'",
                [],
            )
            .map_err(db_error)?;
    }
    if !columns.iter().any(|column| column == "in_scope") {
        connection
            .execute(
                "ALTER TABLE kanban_cards ADD COLUMN in_scope INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .map_err(db_error)?;
    }
    if !columns.iter().any(|column| column == "workflow_revision") {
        connection
            .execute(
                "ALTER TABLE kanban_cards ADD COLUMN workflow_revision INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .map_err(db_error)?;
    }
    if !columns.iter().any(|column| column == "record_revision") {
        connection
            .execute(
                "ALTER TABLE kanban_cards ADD COLUMN record_revision INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .map_err(db_error)?;
    }
    for (name, sql) in [
        (
            "runtime_cleanup_status",
            "ALTER TABLE kanban_cards ADD COLUMN runtime_cleanup_status TEXT CHECK(runtime_cleanup_status IN ('pending', 'complete', 'failed'))",
        ),
        (
            "runtime_cleanup_error",
            "ALTER TABLE kanban_cards ADD COLUMN runtime_cleanup_error TEXT",
        ),
        (
            "parent_id",
            "ALTER TABLE kanban_cards ADD COLUMN parent_id TEXT",
        ),
        (
            "hierarchy_finalized",
            "ALTER TABLE kanban_cards ADD COLUMN hierarchy_finalized INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "provider_child_count",
            "ALTER TABLE kanban_cards ADD COLUMN provider_child_count INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "provider_parent_title",
            "ALTER TABLE kanban_cards ADD COLUMN provider_parent_title TEXT",
        ),
        (
            "scope_suspended",
            "ALTER TABLE kanban_cards ADD COLUMN scope_suspended INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "scope_prior_status",
            "ALTER TABLE kanban_cards ADD COLUMN scope_prior_status TEXT",
        ),
    ] {
        if !columns.iter().any(|column| column == name) {
            connection.execute(sql, []).map_err(db_error)?;
        }
    }
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS kanban_cards_parent_idx ON kanban_cards(parent_id);
         INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (51, unixepoch());",
        )
        .map_err(db_error)?;
    let environment_columns = connection
        .prepare("PRAGMA table_info(card_environments)")
        .map_err(db_error)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let layout_columns = connection
        .prepare("PRAGMA table_info(card_layouts)")
        .map_err(db_error)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    if !layout_columns
        .iter()
        .any(|column| column == "layout_revision")
    {
        connection
            .execute(
                "ALTER TABLE card_layouts ADD COLUMN layout_revision INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .map_err(db_error)?;
    }
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (52, unixepoch())",
            [],
        )
        .map_err(db_error)?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS card_cleanup_operations (
            card_id TEXT PRIMARY KEY REFERENCES kanban_cards(id) ON DELETE CASCADE,
            environment_id TEXT NOT NULL, workflow_revision INTEGER NOT NULL, environment_revision INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','failed','completed')), phase TEXT NOT NULL,
            completion_outcome TEXT NOT NULL CHECK(completion_outcome IN ('merged','closed')),
            repository_id TEXT NOT NULL, source_path TEXT NOT NULL, target_path TEXT NOT NULL,
            source_branch TEXT NOT NULL, target_branch TEXT NOT NULL, source_revision TEXT NOT NULL, target_revision TEXT,
            delete_local_branch INTEGER NOT NULL, delete_remote_branch INTEGER NOT NULL,
            merged_pr_repository TEXT, merged_pr_number INTEGER, merged_pr_head_revision TEXT,
            pane_ids TEXT NOT NULL DEFAULT '[]', registration_validated INTEGER NOT NULL DEFAULT 0,
            validation_completed_at INTEGER, error_code TEXT, error_detail TEXT,
            started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
         );
         CREATE TRIGGER IF NOT EXISTS card_cleanup_snapshot_immutable BEFORE UPDATE ON card_cleanup_operations
         WHEN NEW.environment_id IS NOT OLD.environment_id OR NEW.workflow_revision IS NOT OLD.workflow_revision
           OR NEW.environment_revision IS NOT OLD.environment_revision OR NEW.completion_outcome IS NOT OLD.completion_outcome
           OR NEW.repository_id IS NOT OLD.repository_id OR NEW.source_path IS NOT OLD.source_path OR NEW.target_path IS NOT OLD.target_path
           OR NEW.source_branch IS NOT OLD.source_branch OR NEW.target_branch IS NOT OLD.target_branch OR NEW.source_revision IS NOT OLD.source_revision
           OR NEW.target_revision IS NOT OLD.target_revision OR NEW.delete_local_branch IS NOT OLD.delete_local_branch OR NEW.delete_remote_branch IS NOT OLD.delete_remote_branch
           OR NEW.merged_pr_repository IS NOT OLD.merged_pr_repository OR NEW.merged_pr_number IS NOT OLD.merged_pr_number
           OR NEW.merged_pr_head_revision IS NOT OLD.merged_pr_head_revision OR NEW.pane_ids IS NOT OLD.pane_ids
         BEGIN SELECT RAISE(ABORT, 'cleanup operation snapshot is immutable'); END;
         INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (53, unixepoch());"
    ).map_err(db_error)?;
    for (name, sql) in [
        (
            "repository_id",
            "ALTER TABLE card_environments ADD COLUMN repository_id TEXT",
        ),
        (
            "target_checkout_path",
            "ALTER TABLE card_environments ADD COLUMN target_checkout_path TEXT",
        ),
        (
            "target_branch",
            "ALTER TABLE card_environments ADD COLUMN target_branch TEXT",
        ),
        (
            "source_revision",
            "ALTER TABLE card_environments ADD COLUMN source_revision TEXT",
        ),
        (
            "target_revision",
            "ALTER TABLE card_environments ADD COLUMN target_revision TEXT",
        ),
    ] {
        if !environment_columns.iter().any(|column| column == name) {
            connection.execute(sql, []).map_err(db_error)?;
        }
    }
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (70, unixepoch())",
            [],
        )
        .map_err(db_error)?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS card_target_merge_operations (
            id TEXT PRIMARY KEY, card_id TEXT NOT NULL UNIQUE REFERENCES kanban_cards(id) ON DELETE CASCADE,
            environment_id TEXT NOT NULL, workflow_revision INTEGER NOT NULL, environment_revision INTEGER NOT NULL,
            initial_status TEXT NOT NULL CHECK(initial_status IN ('needs_human','approved')),
            repository_id TEXT NOT NULL, source_path TEXT NOT NULL, source_branch TEXT NOT NULL, target_branch TEXT NOT NULL,
            upstream_remote TEXT NOT NULL, upstream_merge_ref TEXT NOT NULL, source_revision TEXT NOT NULL, target_revision TEXT NOT NULL,
            target_source TEXT NOT NULL DEFAULT 'remote' CHECK(target_source IN ('local','remote')),
            phase TEXT NOT NULL CHECK(phase IN ('conflicted','merged')), conflict_paths TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
         );
         INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (71, unixepoch());"
    ).map_err(db_error)?;
    let target_merge_columns = connection
        .prepare("PRAGMA table_info(card_target_merge_operations)")
        .map_err(db_error)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    if !target_merge_columns
        .iter()
        .any(|column| column == "target_source")
    {
        // Operations created by the old schema only existed after a successful
        // fetch, so their selected target provenance is unambiguously remote.
        connection
            .execute(
                "ALTER TABLE card_target_merge_operations ADD COLUMN target_source TEXT NOT NULL DEFAULT 'remote' CHECK(target_source IN ('local','remote'))",
                [],
            )
            .map_err(db_error)?;
    }
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (72, unixepoch())",
            [],
        )
        .map_err(db_error)?;
    Ok(())
}

pub(in crate::kanban) fn migrate_done_status(connection: &Connection) -> Result<(), String> {
    let sql: String = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='kanban_cards'",
            [],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if !sql.contains("'done'") {
        connection.execute_batch(
        "PRAGMA foreign_keys=OFF;
         PRAGMA legacy_alter_table=ON;
         BEGIN IMMEDIATE;
         ALTER TABLE kanban_cards RENAME TO kanban_cards_legacy_delivery;
         CREATE TABLE kanban_cards (
            id TEXT PRIMARY KEY, external_provider TEXT NOT NULL, external_id TEXT NOT NULL,
            title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', board_id TEXT NOT NULL DEFAULT '',
            board_title TEXT NOT NULL DEFAULT '', list_id TEXT NOT NULL DEFAULT '', list_title TEXT NOT NULL DEFAULT '',
            card_url TEXT NOT NULL DEFAULT '', assignee_names TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'needs_refinement' CHECK(status IN ('needs_refinement','refining','needs_refinement_input','ready','agent_working','needs_human','approved','done')),
            completion_outcome TEXT CHECK(completion_outcome IN ('merged','closed')),
            feature_environment INTEGER NOT NULL DEFAULT 0, delivery_operation_stage TEXT, delivery_error TEXT,
            workflow_revision INTEGER NOT NULL DEFAULT 1, project_id TEXT, workspace_id TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
            in_scope INTEGER NOT NULL DEFAULT 1, UNIQUE(external_provider, external_id)
         );
         INSERT INTO kanban_cards (id, external_provider, external_id, title, content, board_id, board_title, list_id, list_title,
            card_url, assignee_names, status, completion_outcome, workflow_revision, project_id, workspace_id, created_at, updated_at, sort_order, in_scope)
         SELECT id, external_provider, external_id, title, content, board_id, board_title, list_id, list_title,
            card_url, assignee_names, CASE status WHEN 'merged' THEN 'done' ELSE status END,
            CASE status WHEN 'merged' THEN 'merged' ELSE NULL END, workflow_revision, project_id, workspace_id, created_at, updated_at, sort_order, in_scope
         FROM kanban_cards_legacy_delivery;
         DROP TABLE kanban_cards_legacy_delivery;
         CREATE INDEX IF NOT EXISTS kanban_cards_status_idx ON kanban_cards(status, updated_at);
         COMMIT;
         PRAGMA legacy_alter_table=OFF;
         PRAGMA foreign_keys=ON;"
        ).map_err(db_error)?;
    }
    connection
        .execute(
            "UPDATE card_events SET from_status='done' WHERE from_status='merged'",
            [],
        )
        .map_err(db_error)?;
    connection
        .execute(
            "UPDATE card_events SET to_status='done' WHERE to_status='merged'",
            [],
        )
        .map_err(db_error)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (72, unixepoch())",
            [],
        )
        .map_err(db_error)?;
    Ok(())
}

pub(in crate::kanban) fn migrate_refinement_statuses(
    connection: &Connection,
) -> Result<(), String> {
    let sql: String = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='kanban_cards'",
            [],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if sql.contains("'needs_refinement_input'") {
        connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, unixepoch())",
            [],
        ).map_err(db_error)?;
        return Ok(());
    }
    connection.execute_batch(
        "PRAGMA foreign_keys=OFF;
         PRAGMA legacy_alter_table=ON;
         BEGIN IMMEDIATE;
         ALTER TABLE kanban_cards RENAME TO kanban_cards_legacy_refinement;
         CREATE TABLE kanban_cards (
            id TEXT PRIMARY KEY, external_provider TEXT NOT NULL, external_id TEXT NOT NULL,
            title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', board_id TEXT NOT NULL DEFAULT '',
            board_title TEXT NOT NULL DEFAULT '', list_id TEXT NOT NULL DEFAULT '', list_title TEXT NOT NULL DEFAULT '',
            card_url TEXT NOT NULL DEFAULT '', assignee_names TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'needs_refinement' CHECK(status IN ('needs_refinement','refining','needs_refinement_input','ready','agent_working','needs_human','approved','done')),
            completion_outcome TEXT CHECK(completion_outcome IN ('merged','closed')),
            feature_environment INTEGER NOT NULL DEFAULT 0, delivery_operation_stage TEXT, delivery_error TEXT,
            workflow_revision INTEGER NOT NULL DEFAULT 1, project_id TEXT, workspace_id TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
            in_scope INTEGER NOT NULL DEFAULT 1, UNIQUE(external_provider, external_id)
         );
         INSERT INTO kanban_cards (id, external_provider, external_id, title, content, board_id, board_title, list_id, list_title,
            card_url, assignee_names, status, completion_outcome, feature_environment, delivery_operation_stage, delivery_error,
            workflow_revision, project_id, workspace_id, created_at, updated_at, sort_order, in_scope)
         SELECT id, external_provider, external_id, title, content, board_id, board_title, list_id, list_title,
            card_url, assignee_names, status, completion_outcome, feature_environment, delivery_operation_stage, delivery_error,
            workflow_revision, project_id, workspace_id, created_at, updated_at, sort_order, in_scope
         FROM kanban_cards_legacy_refinement;
         DROP TABLE kanban_cards_legacy_refinement;
         CREATE INDEX IF NOT EXISTS kanban_cards_status_idx ON kanban_cards(status, updated_at);
         INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, unixepoch());
         COMMIT;
         PRAGMA legacy_alter_table=OFF;
         PRAGMA foreign_keys=ON;"
    ).map_err(db_error)?;
    let foreign_key_errors: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .map_err(db_error)?;
    if foreign_key_errors > 0 {
        return Err("Kanban database migration left invalid foreign-key relationships".to_string());
    }
    Ok(())
}

pub(in crate::kanban) fn list_cards(
    connection: &mut Connection,
) -> Result<Vec<KanbanCard>, String> {
    let mut cards = {
        let mut statement = connection.prepare(
            "SELECT id, external_provider, external_id, title, content, board_id, board_title, list_id, list_title,
                    card_url, assignee_names, status, completion_outcome, feature_environment, delivery_operation_stage, delivery_error,
                    runtime_cleanup_status, runtime_cleanup_error, workflow_revision, record_revision, project_id, created_at, updated_at, sort_order, in_scope,
                    parent_id, hierarchy_finalized, provider_child_count, provider_parent_title
             FROM kanban_cards WHERE in_scope = 1 ORDER BY sort_order ASC, created_at ASC, id ASC"
        ).map_err(db_error)?;
        let mapped = statement.query_map([], map_card).map_err(db_error)?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    load_environments_batched(connection, &mut cards)?;
    load_creation_operations_batched(connection, &mut cards)?;
    load_cleanup_operations_batched(connection, &mut cards)?;
    load_pull_requests_batched(connection, &mut cards)?;
    let work_agent_launch_retries = load_events_batched(connection, &mut cards)?;
    enrich_relationships_batched(connection, &mut cards)?;
    enrich_capabilities(connection, &mut cards, Some(&work_agent_launch_retries))?;
    Ok(cards)
}

pub(in crate::kanban) fn get_card(
    connection: &Connection,
    id: &str,
) -> Result<Option<KanbanCard>, String> {
    let mut card = connection.query_row(
        "SELECT id, external_provider, external_id, title, content, board_id, board_title, list_id, list_title,
                card_url, assignee_names, status, completion_outcome, feature_environment, delivery_operation_stage, delivery_error,
                runtime_cleanup_status, runtime_cleanup_error, workflow_revision, record_revision, project_id, created_at, updated_at, sort_order, in_scope,
                parent_id, hierarchy_finalized, provider_child_count, provider_parent_title
         FROM kanban_cards WHERE id = ?1",
        [id],
        map_card,
    ).optional().map_err(db_error)?;
    if let Some(card) = &mut card {
        card.environment = load_environment(connection, id)?;
        card.creation_operation = load_creation_operation(connection, id)?;
        card.cleanup_operation = load_cleanup_operation(connection, id)?;
        card.pull_request = load_pull_request(connection, card)?;
        card.events = load_events(connection, id)?;
        let mut cards = vec![card.clone()];
        enrich_relationships(connection, &mut cards)?;
        enrich_capabilities(connection, &mut cards, None)?;
        *card = cards.remove(0);
    }
    Ok(card)
}

pub(in crate::kanban) fn enrich_relationships_batched(
    connection: &Connection,
    cards: &mut [KanbanCard],
) -> Result<(), String> {
    for card in cards.iter_mut() {
        card.parent = None;
    }
    let indexes = cards
        .iter()
        .enumerate()
        .map(|(index, card)| (card.id.clone(), index))
        .collect::<HashMap<_, _>>();
    {
        let mut statement = connection
            .prepare(
                "SELECT c.id, p.id, p.external_id, p.title, p.status
             FROM kanban_cards c JOIN kanban_cards p ON p.id=c.parent_id
             WHERE c.in_scope=1 AND p.in_scope=1",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    CardRelationshipSummary {
                        id: row.get(1)?,
                        external_id: row.get(2)?,
                        title: row.get(3)?,
                        status: row.get(4)?,
                    },
                ))
            })
            .map_err(db_error)?;
        for row in rows {
            let (card_id, parent) = row.map_err(db_error)?;
            if let Some(index) = indexes.get(&card_id) {
                cards[*index].parent = Some(parent);
            }
        }
    }
    {
        let mut statement = connection
            .prepare(
                "SELECT parent_id, id, external_id, title, status FROM kanban_cards
             WHERE in_scope=1 AND parent_id IS NOT NULL
             ORDER BY parent_id, created_at, CAST(external_id AS INTEGER), id",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    CardRelationshipSummary {
                        id: row.get(1)?,
                        external_id: row.get(2)?,
                        title: row.get(3)?,
                        status: row.get(4)?,
                    },
                ))
            })
            .map_err(db_error)?;
        for row in rows {
            let (parent_id, child) = row.map_err(db_error)?;
            if let Some(index) = indexes.get(&parent_id) {
                cards[*index].children.push(child);
            }
        }
    }
    for card in cards {
        card.child_count = card.child_count.max(card.children.len() as u64);
        if card.hierarchy_finalized && !card.children.is_empty() {
            card.status = card
                .children
                .iter()
                .min_by_key(|child| workflow::status_index(child.status))
                .map(|child| child.status.clone())
                .unwrap_or(card.status.clone());
        }
    }
    Ok(())
}

pub(in crate::kanban) fn work_agent_launch_retryable(
    connection: &Connection,
    card_id: &str,
) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT event_type FROM card_events
             WHERE card_id=?1 AND (
               event_type='agent_launch_failed'
               OR (event_type='agent_started' AND to_status='agent_working')
             )
             ORDER BY created_at DESC, id DESC LIMIT 1",
            [card_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map(|event_type| event_type.as_deref() == Some("agent_launch_failed"))
        .map_err(db_error)
}

pub(in crate::kanban) fn enrich_capabilities(
    connection: &Connection,
    cards: &mut [KanbanCard],
    work_agent_launch_retries: Option<&HashMap<String, bool>>,
) -> Result<(), String> {
    crate::store::migrate_store_schema(connection)?;
    let projects = {
        let mut statement = connection.prepare(
            "SELECT id, COALESCE(kanban_source, 'local'), delivery_workflow, supports_feature_environments FROM projects",
        ).map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (
                        row.get::<_, String>(1)?,
                        row.get::<_, DeliveryWorkflow>(2)?,
                        row.get::<_, i64>(3)? != 0,
                    ),
                ))
            })
            .map_err(db_error)?;
        rows.collect::<Result<HashMap<_, _>, _>>()
            .map_err(db_error)?
    };
    for card in cards {
        let project = card.project_id.as_ref().and_then(|id| projects.get(id));
        let project_present = project.is_some();
        let (source, delivery_workflow, supports_feature_environments) = project
            .cloned()
            .unwrap_or_else(|| ("local".to_string(), DeliveryWorkflow::LocalMerge, false));
        card.capabilities = workflow::capabilities(&WorkflowContext {
            status: card.status,
            hierarchy_finalized: card.hierarchy_finalized,
            provider_compatible: project_present
                && ((card.provider == "superthread") == (source == "superthread")),
            project_present,
            delivery_workflow,
            supports_feature_environments,
            environment: card.environment.as_ref().map(|value| value.lifecycle_state),
            completion_outcome: card.completion_outcome,
            pull_request: card.pull_request.as_ref().map(|value| value.state),
            pull_request_blockers: card
                .pull_request
                .as_ref()
                .map(|value| value.blockers.clone())
                .unwrap_or_default(),
            resumable_operation: card.delivery_operation_stage.is_some(),
            creation_operation: card.creation_operation.is_some(),
            creation_cleanup_available: card
                .creation_operation
                .as_ref()
                .is_some_and(|value| value.cleanup_available),
            cleanup_operation_active: card
                .cleanup_operation
                .as_ref()
                .is_some_and(|value| value.status != "completed"),
            runtime_cleanup_retryable: matches!(
                card.runtime_cleanup_status.as_deref(),
                Some("pending" | "failed")
            ),
            work_agent_launch_retryable: match work_agent_launch_retries {
                Some(retries) => retries.get(&card.id).copied().unwrap_or(false),
                None => work_agent_launch_retryable(connection, &card.id)?,
            },
            local_provider: card.provider == "local",
            has_parent: card.parent.is_some(),
            has_children: card.child_count > 0,
        });
    }
    Ok(())
}

pub(in crate::kanban) fn relationship_summary(
    connection: &Connection,
    id: &str,
) -> Result<Option<CardRelationshipSummary>, String> {
    connection
        .query_row(
            "SELECT id, external_id, title, status FROM kanban_cards WHERE id=?1 AND in_scope=1",
            [id],
            |row| {
                Ok(CardRelationshipSummary {
                    id: row.get(0)?,
                    external_id: row.get(1)?,
                    title: row.get(2)?,
                    status: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(db_error)
}

pub(in crate::kanban) fn earliest_workflow_status<'a>(
    statuses: impl IntoIterator<Item = &'a str>,
) -> Option<String> {
    statuses
        .into_iter()
        .min_by_key(|status| {
            status
                .parse::<CardStatus>()
                .map(workflow::status_index)
                .unwrap_or(workflow::STATUS_METADATA.len())
        })
        .map(str::to_string)
}

pub(in crate::kanban) fn effective_card_status(
    connection: &Connection,
    id: &str,
    stored_status: &str,
    hierarchy_finalized: bool,
) -> Result<String, String> {
    if !hierarchy_finalized {
        return Ok(stored_status.to_string());
    }
    let mut statement = connection
        .prepare("SELECT status FROM kanban_cards WHERE parent_id=?1 AND in_scope=1")
        .map_err(db_error)?;
    let child_statuses = statement
        .query_map([id], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(
        earliest_workflow_status(child_statuses.iter().map(String::as_str))
            .unwrap_or_else(|| stored_status.to_string()),
    )
}

pub(in crate::kanban) fn enrich_relationships(
    connection: &Connection,
    cards: &mut [KanbanCard],
) -> Result<(), String> {
    for card in cards {
        let parent_id = card.parent.take().map(|parent| parent.id);
        if let Some(parent_id) = parent_id {
            card.parent = relationship_summary(connection, &parent_id)?;
        }
        let mut statement = connection.prepare(
            "SELECT id, external_id, title, status FROM kanban_cards WHERE parent_id=?1 AND in_scope=1 ORDER BY created_at, CAST(external_id AS INTEGER), id"
        ).map_err(db_error)?;
        card.children = statement
            .query_map([&card.id], |row| {
                Ok(CardRelationshipSummary {
                    id: row.get(0)?,
                    external_id: row.get(1)?,
                    title: row.get(2)?,
                    status: row.get(3)?,
                })
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        card.child_count = card.child_count.max(card.children.len() as u64);
        if card.hierarchy_finalized && !card.children.is_empty() {
            card.status = card
                .children
                .iter()
                .min_by_key(|child| workflow::status_index(child.status))
                .map(|child| child.status)
                .unwrap_or(card.status);
        }
    }
    Ok(())
}

pub(in crate::kanban) fn load_environments_batched(
    connection: &Connection,
    cards: &mut [KanbanCard],
) -> Result<(), String> {
    let indexes = cards
        .iter()
        .enumerate()
        .map(|(index, card)| (card.id.clone(), index))
        .collect::<HashMap<_, _>>();
    let mut environment_indexes = HashMap::new();
    {
        let mut statement = connection.prepare(
            "SELECT e.card_id, e.id, e.project_id, e.worktree_path, e.branch, e.repository_id,
                    e.target_checkout_path, e.target_branch, e.source_revision, e.target_revision,
                    e.lifecycle_state, e.revision, l.split_layout, l.focused_pane_id, l.layout_revision
             FROM card_environments e
             JOIN kanban_cards c ON c.id=e.card_id
             LEFT JOIN card_layouts l ON l.environment_id=e.id
             WHERE c.in_scope=1"
        ).map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                let layout = row.get::<_, Option<String>>(12)?;
                Ok((
                    row.get::<_, String>(0)?,
                    CardEnvironment {
                        id: row.get(1)?,
                        card_id: row.get(0)?,
                        project_id: row.get(2)?,
                        worktree_path: row.get(3)?,
                        branch: row.get(4)?,
                        repository_id: row.get(5)?,
                        target_checkout_path: row.get(6)?,
                        target_branch: row.get(7)?,
                        source_revision: row.get(8)?,
                        target_revision: row.get(9)?,
                        lifecycle_state: row.get(10)?,
                        revision: row.get(11)?,
                        split_layout: layout
                            .and_then(|value| serde_json::from_str(&value).ok())
                            .unwrap_or(serde_json::json!({"kind":"empty"})),
                        focused_pane_id: row.get(13)?,
                        layout_revision: row.get::<_, Option<i64>>(14)?.unwrap_or(1),
                        panes: Vec::new(),
                    },
                ))
            })
            .map_err(db_error)?;
        for row in rows {
            let (card_id, environment) = row.map_err(db_error)?;
            if let Some(index) = indexes.get(&card_id) {
                environment_indexes.insert(environment.id.clone(), *index);
                cards[*index].environment = Some(environment);
            }
        }
    }
    let mut statement = connection
        .prepare(
            "SELECT p.environment_id, p.id, p.role, p.kind, p.command, p.sort_order
         FROM card_panes p JOIN card_environments e ON e.id=p.environment_id
         JOIN kanban_cards c ON c.id=e.card_id WHERE c.in_scope=1
         ORDER BY p.environment_id, p.sort_order",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                CardPane {
                    id: row.get(1)?,
                    role: row.get(2)?,
                    kind: row.get(3)?,
                    command: row.get(4)?,
                    sort_order: row.get(5)?,
                },
            ))
        })
        .map_err(db_error)?;
    for row in rows {
        let (environment_id, pane) = row.map_err(db_error)?;
        if let Some(index) = environment_indexes.get(&environment_id) {
            if let Some(environment) = &mut cards[*index].environment {
                environment.panes.push(pane);
            }
        }
    }
    Ok(())
}

pub(in crate::kanban) fn load_creation_operations_batched(
    connection: &Connection,
    cards: &mut [KanbanCard],
) -> Result<(), String> {
    let indexes = cards
        .iter()
        .enumerate()
        .map(|(index, card)| (card.id.clone(), index))
        .collect::<HashMap<_, _>>();
    let mut statement = connection.prepare(
        "SELECT o.card_id, o.id, o.phase, o.error, o.source_path, o.source_branch, o.cleanup_available, o.custom_command, o.revision
         FROM environment_creation_operations o JOIN kanban_cards c ON c.id=o.card_id WHERE c.in_scope=1",
    ).map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                EnvironmentCreationOperation {
                    id: row.get(1)?,
                    phase: row.get(2)?,
                    error: row.get(3)?,
                    source_path: row.get(4)?,
                    source_branch: row.get(5)?,
                    cleanup_available: row.get::<_, i64>(6)? != 0,
                    custom_command: row.get::<_, i64>(7)? != 0,
                    revision: row.get(8)?,
                },
            ))
        })
        .map_err(db_error)?;
    for row in rows {
        let (card_id, operation) = row.map_err(db_error)?;
        if let Some(index) = indexes.get(&card_id) {
            cards[*index].creation_operation = Some(operation);
        }
    }
    Ok(())
}

pub(in crate::kanban) fn load_cleanup_operations_batched(
    connection: &Connection,
    cards: &mut [KanbanCard],
) -> Result<(), String> {
    let indexes = cards
        .iter()
        .enumerate()
        .map(|(index, card)| (card.id.clone(), index))
        .collect::<HashMap<_, _>>();
    let mut statement = connection.prepare(
        "SELECT o.card_id, o.status, o.phase, o.error_code, o.error_detail, o.started_at, o.updated_at, o.completed_at
         FROM card_cleanup_operations o JOIN kanban_cards c ON c.id=o.card_id WHERE c.in_scope=1",
    ).map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                CardCleanupOperation {
                    status: row.get(1)?,
                    phase: row.get(2)?,
                    error_code: row.get(3)?,
                    error_detail: row.get(4)?,
                    started_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    completed_at: row.get(7)?,
                },
            ))
        })
        .map_err(db_error)?;
    for row in rows {
        let (card_id, operation) = row.map_err(db_error)?;
        if let Some(index) = indexes.get(&card_id) {
            cards[*index].cleanup_operation = Some(operation);
        }
    }
    Ok(())
}

pub(in crate::kanban) fn load_pull_requests_batched(
    connection: &Connection,
    cards: &mut [KanbanCard],
) -> Result<(), String> {
    let indexes = cards
        .iter()
        .enumerate()
        .map(|(index, card)| (card.id.clone(), index))
        .collect::<HashMap<_, _>>();
    let mut statement = connection
        .prepare(
            "SELECT pr.card_id, pr.repository, pr.number, pr.title, pr.url, pr.state, pr.draft,
                pr.ci_status, pr.review_state, pr.has_conflicts, pr.mergeable,
                p.require_passing_ci, p.require_approval
         FROM card_pull_requests pr JOIN kanban_cards c ON c.id=pr.card_id
         LEFT JOIN projects p ON p.id=c.project_id WHERE c.in_scope=1",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            let policies = (
                row.get::<_, Option<i64>>(11)?
                    .map(|value| value != 0)
                    .unwrap_or(true),
                row.get::<_, Option<i64>>(12)?
                    .map(|value| value != 0)
                    .unwrap_or(false),
            );
            Ok((
                row.get::<_, String>(0)?,
                CardPullRequest {
                    repository: row.get(1)?,
                    number: row.get::<_, i64>(2)? as u64,
                    title: row.get(3)?,
                    url: row.get(4)?,
                    state: row.get(5)?,
                    draft: row.get::<_, i64>(6)? != 0,
                    ci_status: row.get(7)?,
                    review_state: row.get(8)?,
                    has_conflicts: row.get::<_, i64>(9)? != 0,
                    mergeable: row.get::<_, i64>(10)? != 0,
                    blockers: Vec::new(),
                },
                policies,
            ))
        })
        .map_err(db_error)?;
    for row in rows {
        let (card_id, mut pull_request, policies) = row.map_err(db_error)?;
        apply_pull_request_policy(&mut pull_request, policies);
        if let Some(index) = indexes.get(&card_id) {
            cards[*index].pull_request = Some(pull_request);
        }
    }
    Ok(())
}

pub(in crate::kanban) fn load_events_batched(
    connection: &Connection,
    cards: &mut [KanbanCard],
) -> Result<HashMap<String, bool>, String> {
    let indexes = cards
        .iter()
        .enumerate()
        .map(|(index, card)| (card.id.clone(), index))
        .collect::<HashMap<_, _>>();
    let mut statement = connection.prepare(
        "SELECT card_id, id, created_at, actor, event_type, outcome, from_status, to_status, summary, error_code, error_detail,
                latest_work_launch_event
         FROM (SELECT e.*,
                      ROW_NUMBER() OVER (PARTITION BY e.card_id ORDER BY e.created_at DESC, e.id DESC) AS event_rank,
                      (SELECT launch.event_type FROM card_events launch
                       WHERE launch.card_id=e.card_id AND (
                         launch.event_type='agent_launch_failed'
                         OR (launch.event_type='agent_started' AND launch.to_status='agent_working')
                       )
                       ORDER BY launch.created_at DESC, launch.id DESC LIMIT 1) AS latest_work_launch_event
               FROM card_events e JOIN kanban_cards c ON c.id=e.card_id WHERE c.in_scope=1)
         WHERE event_rank <= 100 ORDER BY card_id, created_at DESC, id DESC"
    ).map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                CardEvent {
                    id: row.get(1)?,
                    created_at: row.get(2)?,
                    actor: row.get(3)?,
                    event_type: row.get(4)?,
                    outcome: row.get(5)?,
                    from_status: row.get(6)?,
                    to_status: row.get(7)?,
                    summary: row.get(8)?,
                    error_code: row.get(9)?,
                    error_detail: row.get(10)?,
                },
                row.get::<_, Option<String>>(11)?,
            ))
        })
        .map_err(db_error)?;
    let mut work_agent_launch_retries = HashMap::new();
    for row in rows {
        let (card_id, event, latest_work_launch_event) = row.map_err(db_error)?;
        if let Some(index) = indexes.get(&card_id) {
            cards[*index].events.push(event);
            work_agent_launch_retries
                .entry(card_id)
                .or_insert(latest_work_launch_event.as_deref() == Some("agent_launch_failed"));
        }
    }
    Ok(work_agent_launch_retries)
}

pub(in crate::kanban) fn load_pull_request(
    connection: &Connection,
    card: &KanbanCard,
) -> Result<Option<CardPullRequest>, String> {
    let Some(mut pull_request) = connection.query_row(
        "SELECT repository, number, title, url, state, draft, ci_status, review_state, has_conflicts, mergeable
         FROM card_pull_requests WHERE card_id=?1", [&card.id], |row| Ok(CardPullRequest {
            repository: row.get(0)?, number: row.get::<_, i64>(1)? as u64, title: row.get(2)?, url: row.get(3)?,
            state: row.get(4)?, draft: row.get::<_, i64>(5)? != 0, ci_status: row.get(6)?, review_state: row.get(7)?,
            has_conflicts: row.get::<_, i64>(8)? != 0, mergeable: row.get::<_, i64>(9)? != 0, blockers: Vec::new(),
        })
    ).optional().map_err(db_error)? else { return Ok(None); };
    let policies = card
        .project_id
        .as_deref()
        .and_then(|project_id| {
            connection
                .query_row(
                    "SELECT require_passing_ci, require_approval FROM projects WHERE id=?1",
                    [project_id],
                    |row| Ok((row.get::<_, i64>(0)? != 0, row.get::<_, i64>(1)? != 0)),
                )
                .optional()
                .ok()
                .flatten()
        })
        .unwrap_or((true, false));
    apply_pull_request_policy(&mut pull_request, policies);
    Ok(Some(pull_request))
}

pub(in crate::kanban) fn apply_pull_request_policy(
    pull_request: &mut CardPullRequest,
    policies: (bool, bool),
) {
    if pull_request.state != "open" {
        pull_request.blockers.push(
            if pull_request.state == PullRequestState::Merged {
                "Pull request is already merged"
            } else {
                "Pull request was closed without merging"
            }
            .to_string(),
        );
    }
    if pull_request.draft {
        pull_request
            .blockers
            .push("Pull request is a draft".to_string());
    }
    if pull_request.has_conflicts {
        pull_request
            .blockers
            .push("Pull request has merge conflicts".to_string());
    }
    if !pull_request.mergeable {
        pull_request
            .blockers
            .push("GitHub merge readiness is unknown or blocked".to_string());
    }
    if policies.0 && pull_request.ci_status != "success" {
        pull_request.blockers.push(
            match pull_request.ci_status.as_str() {
                "pending" => "CI is pending",
                "failure" => "CI is failing",
                "no_ci" => "Required CI is missing",
                _ => "CI state is unknown",
            }
            .to_string(),
        );
    }
    if pull_request.review_state == "changes_requested" {
        pull_request
            .blockers
            .push("A reviewer requested changes".to_string());
    }
    if policies.1 && pull_request.review_state != "approved" {
        pull_request
            .blockers
            .push("A current approval is required".to_string());
    }
}

pub(in crate::kanban) fn load_events(
    connection: &Connection,
    card_id: &str,
) -> Result<Vec<CardEvent>, String> {
    let mut statement = connection.prepare("SELECT id, created_at, actor, event_type, outcome, from_status, to_status, summary, error_code, error_detail FROM card_events WHERE card_id=?1 ORDER BY created_at DESC, id DESC LIMIT 100").map_err(db_error)?;
    let events = statement
        .query_map([card_id], |row| {
            Ok(CardEvent {
                id: row.get(0)?,
                created_at: row.get(1)?,
                actor: row.get(2)?,
                event_type: row.get(3)?,
                outcome: row.get(4)?,
                from_status: row.get(5)?,
                to_status: row.get(6)?,
                summary: row.get(7)?,
                error_code: row.get(8)?,
                error_detail: row.get(9)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(events)
}

pub(in crate::kanban) fn load_creation_operation(
    connection: &Connection,
    card_id: &str,
) -> Result<Option<EnvironmentCreationOperation>, String> {
    connection.query_row(
        "SELECT id, phase, error, source_path, source_branch, cleanup_available, custom_command, revision
         FROM environment_creation_operations WHERE card_id=?1",
        [card_id],
        |row| Ok(EnvironmentCreationOperation {
            id: row.get(0)?,
            phase: row.get(1)?,
            error: row.get(2)?,
            source_path: row.get(3)?,
            source_branch: row.get(4)?,
            cleanup_available: row.get::<_, i64>(5)? != 0,
            custom_command: row.get::<_, i64>(6)? != 0,
            revision: row.get(7)?,
        }),
    ).optional().map_err(db_error)
}

pub(in crate::kanban) fn load_cleanup_operation(
    connection: &Connection,
    card_id: &str,
) -> Result<Option<CardCleanupOperation>, String> {
    connection.query_row(
        "SELECT status, phase, error_code, error_detail, started_at, updated_at, completed_at FROM card_cleanup_operations WHERE card_id=?1",
        [card_id],
        |row| Ok(CardCleanupOperation {
            status: row.get(0)?, phase: row.get(1)?, error_code: row.get(2)?, error_detail: row.get(3)?,
            started_at: row.get(4)?, updated_at: row.get(5)?, completed_at: row.get(6)?,
        }),
    ).optional().map_err(db_error)
}

pub(in crate::kanban) fn load_environment(
    connection: &Connection,
    card_id: &str,
) -> Result<Option<CardEnvironment>, String> {
    let Some((id, project_id, worktree_path, branch, repository_id, target_checkout_path, target_branch, source_revision, target_revision, lifecycle_state, revision)) = connection.query_row(
        "SELECT id, project_id, worktree_path, branch, repository_id, target_checkout_path, target_branch, source_revision, target_revision, lifecycle_state, revision FROM card_environments WHERE card_id = ?1",
        [card_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, Option<String>>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, Option<String>>(8)?, row.get::<_, EnvironmentLifecycle>(9)?, row.get::<_, i64>(10)?)),
    ).optional().map_err(db_error)? else { return Ok(None); };
    let (split_layout, focused_pane_id, layout_revision) = connection
        .query_row(
            "SELECT split_layout, focused_pane_id, layout_revision FROM card_layouts WHERE environment_id = ?1",
            [&id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)?)),
        )
        .optional()
        .map_err(db_error)?
        .map(|(layout, focused, layout_revision)| {
            (
                serde_json::from_str(&layout).unwrap_or(serde_json::json!({"kind":"empty"})),
                focused,
                layout_revision,
            )
        })
        .unwrap_or((serde_json::json!({"kind":"empty"}), None, 1));
    let mut pane_statement = connection.prepare("SELECT id, role, kind, command, sort_order FROM card_panes WHERE environment_id = ?1 ORDER BY sort_order").map_err(db_error)?;
    let panes = pane_statement
        .query_map([&id], |row| {
            Ok(CardPane {
                id: row.get(0)?,
                role: row.get(1)?,
                kind: row.get(2)?,
                command: row.get(3)?,
                sort_order: row.get(4)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(Some(CardEnvironment {
        id,
        card_id: card_id.to_string(),
        project_id,
        worktree_path,
        branch,
        repository_id,
        target_checkout_path,
        target_branch,
        source_revision,
        target_revision,
        lifecycle_state,
        revision,
        layout_revision,
        split_layout,
        focused_pane_id,
        panes,
    }))
}

pub(in crate::kanban) fn map_card(row: &rusqlite::Row<'_>) -> rusqlite::Result<KanbanCard> {
    let parent_id = row.get::<_, Option<String>>(25)?;
    let provider_parent_title = row.get::<_, Option<String>>(28)?;
    Ok(KanbanCard {
        id: row.get(0)?,
        provider: {
            let provider: String = row.get(1)?;
            if provider.starts_with("local:") {
                "local".to_string()
            } else {
                provider
            }
        },
        external_id: row.get(2)?,
        title: row.get(3)?,
        content: row.get(4)?,
        board_id: row.get(5)?,
        board_title: row.get(6)?,
        list_id: row.get(7)?,
        list_title: row.get(8)?,
        card_url: row.get(9)?,
        assignee_names: serde_json::from_str(&row.get::<_, String>(10)?).unwrap_or_default(),
        status: row.get(11)?,
        completion_outcome: row.get(12)?,
        feature_environment: row.get::<_, i64>(13)? != 0,
        pull_request: None,
        delivery_operation_stage: row.get(14)?,
        delivery_error: row.get(15)?,
        runtime_cleanup_status: row.get(16)?,
        runtime_cleanup_error: row.get(17)?,
        workflow_revision: row.get(18)?,
        record_revision: row.get(19)?,
        project_id: row.get(20)?,
        environment: None,
        creation_operation: None,
        cleanup_operation: None,
        created_at: row.get(21)?,
        updated_at: row.get(22)?,
        sort_order: row.get(23)?,
        in_scope: row.get(24)?,
        parent: parent_id.map(|id| CardRelationshipSummary {
            external_id: id.strip_prefix("superthread:").unwrap_or(&id).to_string(),
            id,
            title: provider_parent_title.unwrap_or_default(),
            status: CardStatus::NeedsRefinement,
        }),
        hierarchy_finalized: row.get::<_, i64>(26)? != 0,
        child_count: row.get::<_, i64>(27)? as u64,
        children: Vec::new(),
        events: Vec::new(),
        capabilities: Vec::new(),
    })
}
