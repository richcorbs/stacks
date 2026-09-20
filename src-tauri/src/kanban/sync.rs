use super::*;
#[allow(unused_imports)]
use super::{cards::*, domain::*, health::*, repository::*};

pub(in crate::kanban) fn kanban_sync_superthread_cards_operation(
    owner_project_id: String,
    snapshot: SuperthreadSyncSnapshot,
) -> Result<BoardSnapshot, String> {
    with_board_mutation(|connection| sync_cards(connection, &owner_project_id, snapshot).map(|_| ()))?;
    with_read_connection(board_snapshot)
}

pub(in crate::kanban) fn sync_cards(
    connection: &mut Connection,
    owner_project_id: &str,
    snapshot: SuperthreadSyncSnapshot,
) -> Result<Vec<KanbanCard>, String> {
    let owner = connection
        .query_row(
            "SELECT name, COALESCE(kanban_source, 'local'), COALESCE(superthread_spaces, ''), COALESCE(superthread_board_id,''), COALESCE(superthread_incoming_columns,'[]') FROM projects WHERE id=?1",
            [owner_project_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?)),
        )
        .optional()
        .map_err(db_error)?;
    match owner {
        None => return Err("Superthread sync owner project was not found.".to_string()),
        Some((name, source, _, _, _)) if source != "superthread" => {
            return Err(format!(
                "Project {name} is not the configured Superthread owner."
            ))
        }
        Some((name, _, spaces, _, _)) if spaces.trim().is_empty() => {
            return Err(format!(
                "Configure Superthread spaces on {name} before syncing."
            ));
        }
        Some((name, _, _, board, _)) if board.trim().is_empty() => {
            return Err(format!(
                "Configure the Superthread board and columns on {name} before syncing."
            ));
        }
        Some(_) => {}
    }
    let binding_id: String = connection.query_row(
        "SELECT b.id FROM superthread_bindings b JOIN projects p ON p.superthread_binding_id=b.id WHERE p.id=?1 AND b.state='active' AND b.validated_at IS NOT NULL",
        [owner_project_id], |row| row.get(0)
    ).optional().map_err(db_error)?.ok_or_else(|| "Superthread synchronization is paused until this project's legacy binding is validated with stable IDs".to_string())?;

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
    let _failure_details_are_well_formed = snapshot
        .failed_scopes
        .iter()
        .all(|failure| !failure.scope.trim().is_empty() && !failure.message.trim().is_empty());
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
            child_claims
                .entry(child.id.trim().to_string())
                .or_default()
                .push(parent_id.to_string());
        }
    }
    for parents in child_claims.values().filter(|parents| parents.len() > 1) {
        unsafe_parents.extend(parents.iter().cloned());
    }

    let transaction = connection.savepoint().map_err(db_error)?;
    transaction.execute("UPDATE kanban_cards SET binding_id=?1 WHERE project_id=?2 AND external_provider='superthread' AND binding_id IS NULL", params![binding_id,owner_project_id]).map_err(db_error)?;
    for card in snapshot.cards {
        if card.id.trim().is_empty() || card.title.trim().is_empty() {
            continue;
        }
        let existing_id = transaction.query_row(
            "SELECT id FROM kanban_cards WHERE binding_id=?1 AND external_id=?2",
            params![binding_id,card.id.trim()], |row| row.get::<_,String>(0)
        ).optional().map_err(db_error)?;
        let was_existing = existing_id.is_some();
        let local_id = if let Some(id) = existing_id { id } else {
            let preferred = format!("superthread:{}", card.id.trim());
            let occupied = transaction.query_row("SELECT 1 FROM kanban_cards WHERE id=?1", [&preferred], |_| Ok(())).optional().map_err(db_error)?.is_some();
            if occupied { format!("superthread:{}:{}", binding_id, card.id.trim()) } else { preferred }
        };
        let parent_local_id = if let Some(parent_external_id) = card.task_parent_id.as_deref() {
            transaction.query_row("SELECT id FROM kanban_cards WHERE binding_id=?1 AND external_id=?2", params![binding_id,parent_external_id], |row| row.get::<_,String>(0)).optional().map_err(db_error)?
        } else { None };
        transaction.execute(
            "INSERT INTO kanban_cards (
                id, external_provider, external_id, title, content, board_id, board_title,
                list_id, list_title, card_url, assignee_names, status, project_id, parent_id, provider_parent_title,
                provider_child_count, hierarchy_finalized, created_at, updated_at, sort_order, in_scope, binding_id
             ) VALUES (?1, 'superthread', ?2, ?3, COALESCE(?4, ''), ?5, ?6, ?7, ?8, ?9, ?10,
                'needs_refinement', ?11, ?12, ?13, ?14, 0, ?15, ?15,
                (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards WHERE status='needs_refinement'), COALESCE(?16, 0), ?18)
             ON CONFLICT(id) DO UPDATE SET
                title=excluded.title,
                content=CASE WHEN ?4 IS NULL THEN kanban_cards.content ELSE ?4 END,
                board_id=excluded.board_id, board_title=excluded.board_title,
                list_id=excluded.list_id, list_title=excluded.list_title,
                card_url=excluded.card_url, assignee_names=excluded.assignee_names,
                project_id=excluded.project_id,
                parent_id=CASE WHEN ?17 THEN excluded.parent_id ELSE kanban_cards.parent_id END,
                provider_parent_title=CASE WHEN ?17 THEN excluded.provider_parent_title ELSE kanban_cards.provider_parent_title END,
                provider_child_count=excluded.provider_child_count,
                in_scope=CASE WHEN ?16 IS NULL THEN kanban_cards.in_scope ELSE 1 END, updated_at=excluded.updated_at",
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
                parent_local_id,
                card.task_parent_title,
                card.total_task_children as i64,
                now,
                card.in_scope.map(i64::from),
                card.parent_relationship_hydrated,
                binding_id,
            ],
        ).map_err(db_error)?;
        match card.in_scope {
            Some(false) if was_existing => {
                transaction.execute(
                    "UPDATE kanban_cards SET scope_suspended=1,scope_prior_status=status,status='done',completion_outcome='closed',workflow_revision=workflow_revision+1,in_scope=1,updated_at=?1
                     WHERE id=?2 AND scope_suspended=0 AND status IN ('needs_refinement','needs_refinement_input','ready')",
                    params![now, local_id],
                ).map_err(db_error)?;
            }
            Some(true) => {
                transaction.execute(
                    "UPDATE kanban_cards SET status=scope_prior_status,completion_outcome=NULL,scope_suspended=0,scope_prior_status=NULL,workflow_revision=workflow_revision+1,in_scope=1,updated_at=?1
                     WHERE id=?2 AND scope_suspended=1 AND scope_prior_status IS NOT NULL",
                    params![now, local_id],
                ).map_err(db_error)?;
            }
            Some(false) | None => {}
        }
    }
    // Parent detail collections are authoritative only after provider-side completeness
    // validation. Clear all safe parents first, then assign children in stable order so
    // reparenting cannot depend on request completion order.
    for hydration in parent_hydrations
        .iter()
        .filter(|hydration| !unsafe_parents.contains(hydration.parent_id.trim()))
    {
        let Some(parent_local_id) = transaction.query_row("SELECT id FROM kanban_cards WHERE binding_id=?1 AND external_id=?2", params![binding_id,hydration.parent_id.trim()], |row| row.get::<_,String>(0)).optional().map_err(db_error)? else { continue; };
        transaction
            .execute(
                "UPDATE kanban_cards SET parent_id=NULL, provider_parent_title=NULL, updated_at=?1
             WHERE binding_id=?2 AND parent_id=?3",
                params![now, binding_id, parent_local_id],
            )
            .map_err(db_error)?;
    }
    for hydration in parent_hydrations
        .iter()
        .filter(|hydration| !unsafe_parents.contains(hydration.parent_id.trim()))
    {
        let Some(parent_local_id) = transaction.query_row("SELECT id FROM kanban_cards WHERE binding_id=?1 AND external_id=?2", params![binding_id,hydration.parent_id.trim()], |row| row.get::<_,String>(0)).optional().map_err(db_error)? else { continue; };
        for child in &hydration.children {
            transaction.execute(
                "UPDATE kanban_cards SET parent_id=?1, provider_parent_title=?2, updated_at=?3
                 WHERE binding_id=?4 AND external_id=?5
                   AND EXISTS (SELECT 1 FROM kanban_cards parent WHERE parent.id=?1 AND parent.binding_id=?4)",
                params![parent_local_id, hydration.parent_title.trim(), now, binding_id, child.id.trim()],
            ).map_err(db_error)?;
        }
    }
    // A provider child remains board-visible while an in-scope authoritative parent
    // references it, even when the child's own list is outside discovery scope.
    transaction
        .execute(
            "UPDATE kanban_cards SET in_scope=1,updated_at=?1
         WHERE binding_id=?2 AND parent_id IN (
            SELECT id FROM kanban_cards WHERE binding_id=?2 AND in_scope=1
         ) AND in_scope=0",
            params![now,binding_id],
        )
        .map_err(db_error)?;
    if complete {
        let retained = transaction
            .prepare("SELECT external_id FROM kanban_cards WHERE binding_id=?1")
            .map_err(db_error)?
            .query_map([&binding_id], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        for external_id in retained {
            if !fetched_ids.contains(&external_id) {
                transaction
                    .execute(
                        "UPDATE kanban_cards SET in_scope=0, updated_at=?1
                         WHERE binding_id=?2 AND external_id=?3
                           AND NOT EXISTS (
                             SELECT 1 FROM kanban_cards parent
                             WHERE parent.id=kanban_cards.parent_id AND parent.binding_id=?2 AND parent.in_scope=1
                           )",
                        params![now, binding_id, external_id],
                    )
                    .map_err(db_error)?;
            }
        }
    }
    provider_sync::enqueue_repairs(&transaction, owner_project_id)?;
    transaction.commit().map_err(db_error)?;
    list_cards(connection)
}
