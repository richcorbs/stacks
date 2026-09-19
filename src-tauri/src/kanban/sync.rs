use super::*;
#[allow(unused_imports)]
use super::{cards::*, domain::*, health::*, repository::*};

pub(in crate::kanban) fn kanban_sync_superthread_cards_operation(
    owner_project_id: String,
    snapshot: SuperthreadSyncSnapshot,
) -> Result<BoardSnapshot, String> {
    with_connection(|connection| sync_cards(connection, &owner_project_id, snapshot).map(|_| ()))?;
    with_connection(board_snapshot)
}

pub(in crate::kanban) fn sync_cards(
    connection: &mut Connection,
    owner_project_id: &str,
    snapshot: SuperthreadSyncSnapshot,
) -> Result<Vec<KanbanCard>, String> {
    let owner = connection
        .query_row(
            "SELECT name, COALESCE(kanban_source, 'local'), COALESCE(superthread_spaces, '') FROM projects WHERE id=?1",
            [owner_project_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .optional()
        .map_err(db_error)?;
    match owner {
        None => return Err("Superthread sync owner project was not found.".to_string()),
        Some((name, source, _)) if source != "superthread" => {
            return Err(format!("Project {name} is not the configured Superthread owner."))
        }
        Some((name, _, spaces)) if spaces.trim().is_empty() => {
            return Err(format!("Configure Superthread spaces on {name} before syncing."));
        }
        Some(_) => {}
    }
    let competing_owner = connection
        .query_row(
            "SELECT name FROM projects WHERE kanban_source='superthread' AND id != ?1 ORDER BY id LIMIT 1",
            [owner_project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    if let Some(name) = competing_owner {
        return Err(format!(
            "Superthread sync is blocked because {name} is also configured as an owner."
        ));
    }

    let now = unix_timestamp();
    let cards_are_valid = snapshot
        .cards
        .iter()
        .all(|card| !card.id.trim().is_empty() && !card.title.trim().is_empty());
    let complete = snapshot.complete && snapshot.failed_scopes.is_empty() && cards_are_valid;
    let _reported_coverage = (
        snapshot.successful_scope_ids.len(),
        snapshot.successful_board_ids.len(),
    );
    let _failure_details_are_well_formed = snapshot.failed_scopes.iter().all(|failure| {
        !failure.scope.trim().is_empty() && !failure.message.trim().is_empty()
    });
    let fetched_ids = snapshot
        .cards
        .iter()
        .filter_map(|card| {
            let id = card.id.trim();
            (!id.is_empty() && !card.title.trim().is_empty()).then(|| id.to_string())
        })
        .collect::<HashSet<_>>();
    let mut parent_hydrations = snapshot.parent_hydrations;
    parent_hydrations.sort_by(|left, right| left.parent_id.cmp(&right.parent_id));
    let mut unsafe_parents = HashSet::new();
    let mut child_claims: HashMap<String, Vec<String>> = HashMap::new();
    for hydration in &parent_hydrations {
        let parent_id = hydration.parent_id.trim();
        let mut unique_children = HashSet::new();
        if parent_id.is_empty()
            || hydration.parent_title.trim().is_empty()
            || hydration.children.iter().any(|child| {
                child.id.trim().is_empty()
                    || child.title.trim().is_empty()
                    || !unique_children.insert(child.id.trim())
            })
        {
            unsafe_parents.insert(parent_id.to_string());
            continue;
        }
        for child in &hydration.children {
            child_claims.entry(child.id.trim().to_string()).or_default().push(parent_id.to_string());
        }
    }
    for parents in child_claims.values().filter(|parents| parents.len() > 1) {
        unsafe_parents.extend(parents.iter().cloned());
    }

    let transaction = connection.transaction().map_err(db_error)?;
    for card in snapshot.cards {
        if card.id.trim().is_empty() || card.title.trim().is_empty() {
            continue;
        }
        let local_id = format!("superthread:{}", card.id.trim());
        transaction.execute(
            "INSERT INTO kanban_cards (
                id, external_provider, external_id, title, content, board_id, board_title,
                list_id, list_title, card_url, assignee_names, status, project_id, parent_id, provider_parent_title,
                provider_child_count, hierarchy_finalized, created_at, updated_at, sort_order, in_scope
             ) VALUES (?1, 'superthread', ?2, ?3, COALESCE(?4, ''), ?5, ?6, ?7, ?8, ?9, ?10,
                'needs_refinement', ?11, ?12, ?13, ?14, 0, ?15, ?15,
                (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards WHERE status='needs_refinement'), COALESCE(?16, 0))
             ON CONFLICT(external_provider, external_id) DO UPDATE SET
                title=excluded.title,
                content=CASE WHEN ?4 IS NULL THEN kanban_cards.content ELSE ?4 END,
                board_id=excluded.board_id, board_title=excluded.board_title,
                list_id=excluded.list_id, list_title=excluded.list_title,
                card_url=excluded.card_url, assignee_names=excluded.assignee_names,
                project_id=excluded.project_id,
                parent_id=CASE WHEN ?17 THEN excluded.parent_id ELSE kanban_cards.parent_id END,
                provider_parent_title=CASE WHEN ?17 THEN excluded.provider_parent_title ELSE kanban_cards.provider_parent_title END,
                provider_child_count=excluded.provider_child_count,
                in_scope=CASE WHEN ?16 IS NULL THEN kanban_cards.in_scope ELSE ?16 END, updated_at=excluded.updated_at",
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
                owner_project_id,
                card.task_parent_id.as_ref().map(|value| format!("superthread:{}", value)),
                card.task_parent_title,
                card.total_task_children as i64,
                now,
                card.in_scope.map(i64::from),
                card.parent_relationship_hydrated,
            ],
        ).map_err(db_error)?;
    }
    // Parent detail collections are authoritative only after provider-side completeness
    // validation. Clear all safe parents first, then assign children in stable order so
    // reparenting cannot depend on request completion order.
    for hydration in parent_hydrations.iter().filter(|hydration| !unsafe_parents.contains(hydration.parent_id.trim())) {
        let parent_local_id = format!("superthread:{}", hydration.parent_id.trim());
        transaction.execute(
            "UPDATE kanban_cards SET parent_id=NULL, provider_parent_title=NULL, updated_at=?1
             WHERE external_provider='superthread' AND parent_id=?2",
            params![now, parent_local_id],
        ).map_err(db_error)?;
    }
    for hydration in parent_hydrations.iter().filter(|hydration| !unsafe_parents.contains(hydration.parent_id.trim())) {
        let parent_local_id = format!("superthread:{}", hydration.parent_id.trim());
        for child in &hydration.children {
            transaction.execute(
                "UPDATE kanban_cards SET parent_id=?1, provider_parent_title=?2, updated_at=?3
                 WHERE external_provider='superthread' AND external_id=?4
                   AND EXISTS (SELECT 1 FROM kanban_cards parent WHERE parent.id=?1 AND parent.external_provider='superthread')",
                params![parent_local_id, hydration.parent_title.trim(), now, child.id.trim()],
            ).map_err(db_error)?;
        }
    }
    // A provider child remains board-visible while an in-scope authoritative parent
    // references it, even when the child's own list is outside discovery scope.
    transaction.execute(
        "UPDATE kanban_cards SET in_scope=1,updated_at=?1
         WHERE external_provider='superthread' AND parent_id IN (
            SELECT id FROM kanban_cards WHERE external_provider='superthread' AND in_scope=1
         ) AND in_scope=0",
        [now],
    ).map_err(db_error)?;
    if complete {
        let retained = transaction
            .prepare("SELECT external_id FROM kanban_cards WHERE external_provider='superthread'")
            .map_err(db_error)?
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        for external_id in retained {
            if !fetched_ids.contains(&external_id) {
                transaction
                    .execute(
                        "UPDATE kanban_cards SET in_scope=0, updated_at=?1
                         WHERE external_provider='superthread' AND external_id=?2
                           AND NOT EXISTS (
                             SELECT 1 FROM kanban_cards parent
                             WHERE parent.id=kanban_cards.parent_id AND parent.external_provider='superthread' AND parent.in_scope=1
                           )",
                        params![now, external_id],
                    )
                    .map_err(db_error)?;
            }
        }
    }
    transaction.commit().map_err(db_error)?;
    list_cards(connection)
}
