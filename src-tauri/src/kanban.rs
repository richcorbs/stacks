use crate::fs_paths::app_data_file;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

const STATUSES: [&str; 6] = [
    "needs_refinement",
    "ready",
    "agent_working",
    "needs_human",
    "approved",
    "merged",
];

#[derive(Debug, Clone, Deserialize)]
pub struct KanbanCardSnapshot {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub board_id: String,
    #[serde(default)]
    pub board_title: String,
    #[serde(default)]
    pub list_id: String,
    #[serde(default)]
    pub list_title: String,
    #[serde(default)]
    pub card_url: String,
    #[serde(default)]
    pub assignee_names: Vec<String>,
    #[serde(default = "default_true")]
    pub in_scope: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
pub struct KanbanCard {
    id: String,
    external_id: String,
    title: String,
    content: String,
    board_id: String,
    board_title: String,
    list_id: String,
    list_title: String,
    card_url: String,
    assignee_names: Vec<String>,
    status: String,
    project_id: Option<String>,
    workspace_id: Option<String>,
    created_at: i64,
    updated_at: i64,
    sort_order: i64,
    in_scope: bool,
}

#[tauri::command]
pub fn kanban_cards() -> Result<Vec<KanbanCard>, String> {
    with_connection(list_cards)
}

#[tauri::command]
pub fn kanban_create_local_card(
    project_id: String,
    project_name: String,
    title: String,
    content: String,
) -> Result<KanbanCard, String> {
    let title = title.trim();
    if project_id.trim().is_empty() || title.is_empty() {
        return Err("Project and title are required".to_string());
    }
    with_connection(|connection| {
        let transaction = connection.transaction().map_err(db_error)?;
        let next_number = next_local_card_number(&transaction, &project_id)?;
        let id = format!("local:{}", uuid::Uuid::new_v4());
        let now = unix_timestamp();
        let sort_order: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards WHERE status = 'needs_refinement' AND project_id = ?1",
            [&project_id], |row| row.get(0),
        ).map_err(db_error)?;
        transaction.execute(
            "INSERT INTO kanban_cards
             (id, external_provider, external_id, title, content, board_id, board_title, status, project_id, created_at, updated_at, sort_order, in_scope)
             VALUES (?1, 'local:' || ?5, ?2, ?3, ?4, ?5, ?6, 'needs_refinement', ?5, ?7, ?7, ?8, 1)",
            params![id, next_number.to_string(), title, content.trim(), project_id, project_name.trim(), now, sort_order],
        ).map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        get_card(connection, &id)?.ok_or_else(|| "Created card was not found".to_string())
    })
}

#[tauri::command]
pub fn kanban_update_local_card(
    id: String,
    title: Option<String>,
    content: Option<String>,
) -> Result<KanbanCard, String> {
    with_connection(|connection| {
        update_local_card(connection, &id, title.as_deref(), content.as_deref())
    })
}

pub(crate) fn update_local_card(
    connection: &Connection,
    id: &str,
    title: Option<&str>,
    content: Option<&str>,
) -> Result<KanbanCard, String> {
    if !id.starts_with("local:") {
        return Err("Only local cards can be updated from a Stacks Pi session".to_string());
    }
    if title.is_none() && content.is_none() {
        return Err("A title or description is required".to_string());
    }
    let title = title.map(str::trim);
    if title.is_some_and(str::is_empty) {
        return Err("Card title cannot be empty".to_string());
    }
    let changed = connection.execute(
        "UPDATE kanban_cards SET title = COALESCE(?1, title), content = COALESCE(?2, content), updated_at = ?3
         WHERE id = ?4 AND external_provider LIKE 'local:%'",
        params![title, content.map(str::trim), unix_timestamp(), id],
    ).map_err(db_error)?;
    if changed == 0 {
        return Err("Local Kanban card was not found".to_string());
    }
    get_card(connection, id)?.ok_or_else(|| "Local Kanban card was not found".to_string())
}

#[tauri::command]
pub fn kanban_finish_local_refinement(
    id: String,
    title: Option<String>,
    content: String,
) -> Result<KanbanCard, String> {
    with_connection(|connection| {
        finish_local_refinement(connection, &id, title.as_deref(), &content)
    })
}

pub(crate) fn finish_local_refinement(
    connection: &mut Connection,
    id: &str,
    title: Option<&str>,
    content: &str,
) -> Result<KanbanCard, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("A final card description is required before finishing refinement".to_string());
    }
    let transaction = connection.transaction().map_err(db_error)?;
    update_local_card(&transaction, id, title, Some(content))?;
    let changed = transaction.execute(
        "UPDATE kanban_cards SET status = 'ready', updated_at = ?1,
            sort_order = (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards AS destination WHERE destination.status = 'ready')
         WHERE id = ?2 AND status IN ('needs_refinement', 'ready')",
        params![unix_timestamp(), id],
    ).map_err(db_error)?;
    if changed == 0 {
        return Err("Only a card being refined can finish refinement".to_string());
    }
    transaction.commit().map_err(db_error)?;
    get_card(connection, id)?.ok_or_else(|| "Local Kanban card was not found".to_string())
}

#[tauri::command]
pub fn kanban_open_card(id: String) -> Result<String, String> {
    with_connection(|connection| {
        if get_card(connection, &id)?.is_none() {
            return Err("Kanban card was not found".to_string());
        }
        let directory = ensure_card_directory(&id)?;
        directory
            .to_str()
            .map(str::to_string)
            .ok_or_else(|| "Card directory is not valid UTF-8".to_string())
    })
}

pub(crate) fn card_directory(id: &str) -> Result<std::path::PathBuf, String> {
    let mut directory = crate::fs_paths::app_data_dir()?;
    directory.push("cards");
    directory.push(safe_card_key(id));
    Ok(directory)
}

fn ensure_card_directory(id: &str) -> Result<std::path::PathBuf, String> {
    let directory = card_directory(id)?;
    fs::create_dir_all(directory.join("pi-sessions")).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn safe_card_key(id: &str) -> String {
    id.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

#[tauri::command]
pub fn kanban_sync_superthread_cards(
    cards: Vec<KanbanCardSnapshot>,
) -> Result<Vec<KanbanCard>, String> {
    with_connection(|connection| sync_cards(connection, cards))
}

fn sync_cards(
    connection: &mut Connection,
    cards: Vec<KanbanCardSnapshot>,
) -> Result<Vec<KanbanCard>, String> {
    let now = unix_timestamp();
    let transaction = connection.transaction().map_err(db_error)?;
    for card in cards {
        if card.id.trim().is_empty() || card.title.trim().is_empty() {
            continue;
        }
        if !card.in_scope {
            transaction.execute(
                "UPDATE kanban_cards SET title = ?1, content = CASE WHEN ?2 = '' THEN content ELSE ?2 END,
                    board_id = ?3, board_title = ?4, list_id = ?5, list_title = ?6, card_url = ?7,
                    assignee_names = ?8, in_scope = 0, updated_at = ?9
                 WHERE external_provider = 'superthread' AND external_id = ?10",
                params![card.title.trim(), card.content, card.board_id, card.board_title, card.list_id,
                    card.list_title, card.card_url, serde_json::to_string(&card.assignee_names).map_err(|error| error.to_string())?,
                    now, card.id.trim()],
            ).map_err(db_error)?;
            continue;
        }
        let was_cleaned = transaction.query_row(
            "SELECT 1 FROM kanban_cleaned_cards WHERE external_provider = 'superthread' AND external_id = ?1",
            [card.id.trim()],
            |_| Ok(()),
        ).optional().map_err(db_error)?.is_some();
        if was_cleaned {
            continue;
        }
        let local_id = format!("superthread:{}", card.id.trim());
        transaction.execute(
            "INSERT INTO kanban_cards (
                id, external_provider, external_id, title, content, board_id, board_title,
                list_id, list_title, card_url, assignee_names, status, created_at, updated_at, sort_order, in_scope
             ) VALUES (?1, 'superthread', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'needs_refinement', ?11, ?11,
                (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards WHERE status = 'needs_refinement'), 1)
             ON CONFLICT(external_provider, external_id) DO UPDATE SET
                title = excluded.title,
                content = CASE WHEN excluded.content = '' THEN kanban_cards.content ELSE excluded.content END,
                board_id = excluded.board_id,
                board_title = excluded.board_title,
                list_id = excluded.list_id,
                list_title = excluded.list_title,
                card_url = excluded.card_url,
                assignee_names = excluded.assignee_names,
                in_scope = 1,
                updated_at = excluded.updated_at",
            params![
                local_id,
                card.id.trim(),
                card.title.trim(),
                card.content,
                card.board_id,
                card.board_title,
                card.list_id,
                card.list_title,
                card.card_url,
                serde_json::to_string(&card.assignee_names).map_err(|error| error.to_string())?,
                now,
            ],
        ).map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)?;
    list_cards(connection)
}

#[tauri::command]
pub fn kanban_delete_card(id: String) -> Result<(), String> {
    with_connection(|connection| {
        let Some(card) = get_card(connection, &id)? else {
            return Ok(());
        };
        let directory = card_directory(&id)?;
        if directory.exists() {
            fs::remove_dir_all(&directory)
                .map_err(|error| format!("Could not remove card directory: {error}"))?;
        }
        let transaction = connection.transaction().map_err(db_error)?;
        if id.starts_with("superthread:") {
            transaction.execute(
                "INSERT OR REPLACE INTO kanban_cleaned_cards (external_provider, external_id, cleaned_at) VALUES ('superthread', ?1, ?2)",
                params![card.external_id, unix_timestamp()],
            ).map_err(db_error)?;
        }
        transaction
            .execute("DELETE FROM kanban_cards WHERE id = ?1", [&id])
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)
    })
}

#[tauri::command]
pub fn kanban_set_status(id: String, status: String) -> Result<KanbanCard, String> {
    if !STATUSES.contains(&status.as_str()) {
        return Err(format!("Unknown Kanban status: {status}"));
    }
    with_connection(|connection| {
        ensure_card_directory(&id)?;
        let changed = connection.execute(
            "UPDATE kanban_cards SET status = ?1, updated_at = ?2,
                sort_order = (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards AS destination WHERE destination.status = ?1)
             WHERE id = ?3",
            params![status, unix_timestamp(), id],
        ).map_err(db_error)?;
        if changed == 0 {
            return Err("Kanban card was not found".to_string());
        }
        get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
    })
}

#[tauri::command]
pub fn kanban_reorder_cards(
    status: String,
    card_ids: Vec<String>,
) -> Result<Vec<KanbanCard>, String> {
    if !STATUSES.contains(&status.as_str()) {
        return Err(format!("Unknown Kanban status: {status}"));
    }
    with_connection(|connection| {
        let transaction = connection.transaction().map_err(db_error)?;
        for (index, id) in card_ids.iter().enumerate() {
            let changed = transaction.execute(
                "UPDATE kanban_cards SET sort_order = ?1, updated_at = ?2 WHERE id = ?3 AND status = ?4",
                params![index as i64, unix_timestamp(), id, status],
            ).map_err(db_error)?;
            if changed == 0 {
                return Err("A reordered card was not found in the expected column".to_string());
            }
        }
        transaction.commit().map_err(db_error)?;
        list_cards(connection)
    })
}

#[tauri::command]
pub fn kanban_set_project(id: String, project_id: String) -> Result<KanbanCard, String> {
    if project_id.trim().is_empty() {
        return Err("Project is required".to_string());
    }
    with_connection(|connection| {
        ensure_card_directory(&id)?;
        let changed = connection
            .execute(
                "UPDATE kanban_cards SET project_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![project_id, unix_timestamp(), id],
            )
            .map_err(db_error)?;
        if changed == 0 {
            return Err("Kanban card was not found".to_string());
        }
        get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
    })
}

#[tauri::command]
pub fn kanban_associate_workspace(
    id: String,
    project_id: String,
    workspace_id: String,
) -> Result<KanbanCard, String> {
    if project_id.trim().is_empty() || workspace_id.trim().is_empty() {
        return Err("Project and workspace are required".to_string());
    }
    with_connection(|connection| {
        ensure_card_directory(&id)?;
        let changed = connection.execute(
            "UPDATE kanban_cards
             SET project_id = ?1, workspace_id = ?2, status = 'agent_working', updated_at = ?3,
                 sort_order = (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards AS destination WHERE destination.status = 'agent_working')
             WHERE id = ?4",
            params![project_id, workspace_id, unix_timestamp(), id],
        ).map_err(db_error)?;
        if changed == 0 {
            return Err("Kanban card was not found".to_string());
        }
        get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
    })
}

fn next_local_card_number(connection: &Connection, project_id: &str) -> Result<i64, String> {
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

fn with_connection<T>(
    work: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let path = app_data_file("workflow.sqlite3")?;
    let mut connection = Connection::open(path).map_err(db_error)?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(db_error)?;
    migrate(&connection)?;
    work(&mut connection)
}

fn migrate(connection: &Connection) -> Result<(), String> {
    connection.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
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
                CHECK(status IN ('needs_refinement', 'ready', 'agent_working', 'needs_human', 'approved', 'merged')),
            project_id TEXT,
            workspace_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            in_scope INTEGER NOT NULL DEFAULT 1,
            UNIQUE(external_provider, external_id)
         );
         CREATE INDEX IF NOT EXISTS kanban_cards_status_idx ON kanban_cards(status, updated_at);
         CREATE TABLE IF NOT EXISTS kanban_project_sequences (
            project_id TEXT PRIMARY KEY,
            next_number INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS kanban_cleaned_cards (
            external_provider TEXT NOT NULL,
            external_id TEXT NOT NULL,
            cleaned_at INTEGER NOT NULL,
            PRIMARY KEY(external_provider, external_id)
         );"
    ).map_err(db_error)?;
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
    Ok(())
}

fn list_cards(connection: &mut Connection) -> Result<Vec<KanbanCard>, String> {
    let mut statement = connection.prepare(
        "SELECT id, external_id, title, content, board_id, board_title, list_id, list_title,
                card_url, assignee_names, status, project_id, workspace_id, created_at, updated_at, sort_order, in_scope
         FROM kanban_cards WHERE in_scope = 1 ORDER BY sort_order ASC, created_at ASC"
    ).map_err(db_error)?;
    let rows = statement.query_map([], map_card).map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

fn get_card(connection: &Connection, id: &str) -> Result<Option<KanbanCard>, String> {
    connection.query_row(
        "SELECT id, external_id, title, content, board_id, board_title, list_id, list_title,
                card_url, assignee_names, status, project_id, workspace_id, created_at, updated_at, sort_order, in_scope
         FROM kanban_cards WHERE id = ?1",
        [id],
        map_card,
    ).optional().map_err(db_error)
}

fn map_card(row: &rusqlite::Row<'_>) -> rusqlite::Result<KanbanCard> {
    Ok(KanbanCard {
        id: row.get(0)?,
        external_id: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        board_id: row.get(4)?,
        board_title: row.get(5)?,
        list_id: row.get(6)?,
        list_title: row.get(7)?,
        card_url: row.get(8)?,
        assignee_names: serde_json::from_str(&row.get::<_, String>(9)?).unwrap_or_default(),
        status: row.get(10)?,
        project_id: row.get(11)?,
        workspace_id: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
        sort_order: row.get(15)?,
        in_scope: row.get(16)?,
    })
}

fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn db_error(error: rusqlite::Error) -> String {
    format!("Kanban database error: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn pi_can_update_only_local_card_fields() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        local_card(&mut connection);

        let updated = update_local_card(
            &mut connection,
            "local:test",
            Some("Final title"),
            Some("Final description"),
        )
        .unwrap();

        assert_eq!(updated.title, "Final title");
        assert_eq!(updated.content, "Final description");
        assert_eq!(updated.status, "needs_refinement");
        assert!(update_local_card(&mut connection, "superthread:1", None, Some("No")).is_err());
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

        assert!(finish_local_refinement(&mut connection, "local:test", None, "  ").is_err());
        assert_eq!(
            get_card(&connection, "local:test").unwrap().unwrap().status,
            "needs_refinement"
        );
    }

    #[test]
    fn sync_preserves_local_workflow_state() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        let snapshot = || KanbanCardSnapshot {
            id: "42".into(),
            title: "First title".into(),
            content: String::new(),
            board_id: "b1".into(),
            board_title: "Roadmap".into(),
            list_id: "doing".into(),
            list_title: "Doing".into(),
            card_url: String::new(),
            assignee_names: vec!["Ada".into()],
            in_scope: true,
        };
        sync_cards(&mut connection, vec![snapshot()]).unwrap();
        connection
            .execute(
                "UPDATE kanban_cards SET status = 'approved' WHERE id = 'superthread:42'",
                [],
            )
            .unwrap();
        let mut changed = snapshot();
        changed.title = "Updated upstream".into();
        let cards = sync_cards(&mut connection, vec![changed]).unwrap();
        assert_eq!(cards[0].status, "approved");
        assert_eq!(cards[0].title, "Updated upstream");
    }

    #[test]
    fn rejects_unknown_statuses() {
        assert!(!STATUSES.contains(&"waiting_for_magic"));
    }

    #[test]
    fn does_not_reimport_cleaned_cards() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        connection.execute(
            "INSERT INTO kanban_cleaned_cards (external_provider, external_id, cleaned_at) VALUES ('superthread', '42', 1)",
            [],
        ).unwrap();
        let cards = sync_cards(
            &mut connection,
            vec![KanbanCardSnapshot {
                id: "42".into(),
                title: "Already cleaned".into(),
                content: String::new(),
                board_id: "b1".into(),
                board_title: "Roadmap".into(),
                list_id: "doing".into(),
                list_title: "Doing".into(),
                card_url: String::new(),
                assignee_names: Vec::new(),
                in_scope: true,
            }],
        )
        .unwrap();
        assert!(cards.is_empty());
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
    fn makes_card_ids_safe_for_directories() {
        assert_eq!(
            safe_card_key("superthread:42/../../oops"),
            "superthread_42_______oops"
        );
    }
}
