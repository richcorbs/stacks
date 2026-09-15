use super::*;
#[allow(unused_imports)]
use super::{
    cards::*, cleanup::*, domain::*, environment::*, git_effects::*, github_delivery::*, health::*,
    local_delivery::*, repository::*,
};

pub(in crate::kanban) fn unique_superthread_project_id(
    connection: &Connection,
) -> Result<String, String> {
    let ids = connection
        .prepare("SELECT id FROM projects WHERE kanban_source = 'superthread' ORDER BY id")
        .map_err(db_error)?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    match ids.as_slice() {
        [id] => Ok(id.clone()),
        [] => Err("Superthread sync requires exactly one Stacks project configured with kanban_source 'superthread'.".to_string()),
        _ => Err("Superthread sync is blocked because multiple Stacks projects are configured with kanban_source 'superthread'.".to_string()),
    }
}

pub(in crate::kanban) fn reconcile_card_ownership(connection: &Connection) -> Result<(), String> {
    let projects = connection
        .prepare("SELECT id, COALESCE(kanban_source, 'local') FROM projects ORDER BY id")
        .map_err(db_error)?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(db_error)?;
    let superthread_ids = projects
        .iter()
        .filter_map(|(id, source)| (source == "superthread").then(|| id.clone()))
        .collect::<Vec<_>>();
    let rows = connection
        .prepare("SELECT id, external_provider, project_id, board_id FROM kanban_cards ORDER BY id")
        .map_err(db_error)?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    for (id, provider, stored_project, board_id) in rows {
        let owner = if provider == "superthread" {
            match superthread_ids.as_slice() {
                [owner] => owner.clone(),
                [] => return Err(format!("Card {id} has no owner: configure exactly one Superthread Kanban project.")),
                _ => return Err(format!("Card {id} has ambiguous ownership: multiple Superthread Kanban projects are configured.")),
            }
        } else if provider.starts_with("local:") {
            let provider_project = provider.strip_prefix("local:").unwrap_or_default();
            stored_project
                .clone()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| (!provider_project.is_empty()).then(|| provider_project.to_string()))
                .or_else(|| (!board_id.trim().is_empty()).then(|| board_id.clone()))
                .ok_or_else(|| format!("Local card {id} has no deterministic project ownership."))?
        } else {
            return Err(format!("Card {id} uses unsupported provider {provider}."));
        };
        let source = projects.get(&owner).map(String::as_str);
        let compatible = matches!(
            (provider.as_str(), source),
            ("superthread", Some("superthread"))
        ) || (provider.starts_with("local:") && source == Some("local"));
        if !compatible {
            return Err(format!("Card {id} references missing or incompatible project {owner}. Repair its project configuration before using the board."));
        }
        if stored_project.as_deref() != Some(owner.as_str()) {
            connection
                .execute(
                    "UPDATE kanban_cards SET project_id=?1 WHERE id=?2",
                    params![owner, id],
                )
                .map_err(db_error)?;
        }
    }
    Ok(())
}

pub(in crate::kanban) fn kanban_sync_superthread_cards_operation(
    cards: Vec<KanbanCardSnapshot>,
) -> Result<BoardSnapshot, String> {
    with_connection(|connection| {
        reconcile_card_ownership(connection)?;
        sync_cards(connection, cards).map(|_| ())
    })?;
    with_connection(board_snapshot)
}

pub(in crate::kanban) fn sync_cards(
    connection: &mut Connection,
    cards: Vec<KanbanCardSnapshot>,
) -> Result<Vec<KanbanCard>, String> {
    let superthread_project_id = unique_superthread_project_id(connection)?;
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
                    assignee_names = ?8, parent_id=?9, provider_parent_title=?10, provider_child_count=?11,
                    hierarchy_finalized=CASE WHEN ?11 > 0 THEN 1 ELSE hierarchy_finalized END, in_scope = 0, updated_at = ?12
                 WHERE external_provider = 'superthread' AND external_id = ?13",
                params![card.title.trim(), card.content, card.board_id, card.board_title, card.list_id,
                    card.list_title, card.card_url, serde_json::to_string(&card.assignee_names).map_err(|error| error.to_string())?,
                    card.task_parent_id.as_ref().map(|value| format!("superthread:{}", value)), card.task_parent_title,
                    card.total_task_children as i64, now, card.id.trim()],
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
                list_id, list_title, card_url, assignee_names, status, project_id, parent_id, provider_parent_title,
                provider_child_count, hierarchy_finalized, created_at, updated_at, sort_order, in_scope
             ) VALUES (?1, 'superthread', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'needs_refinement', ?11, ?12, ?13, ?14,
                CASE WHEN ?14 > 0 THEN 1 ELSE 0 END, ?15, ?15,
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
                project_id = excluded.project_id,
                parent_id = excluded.parent_id,
                provider_parent_title = excluded.provider_parent_title,
                provider_child_count = excluded.provider_child_count,
                hierarchy_finalized = excluded.hierarchy_finalized,
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
                superthread_project_id,
                card.task_parent_id.as_ref().map(|value| format!("superthread:{}", value)),
                card.task_parent_title,
                card.total_task_children as i64,
                now,
            ],
        ).map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)?;
    list_cards(connection)
}
