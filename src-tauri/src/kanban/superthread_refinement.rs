use super::*;
use super::{
    cards::apply_workflow_transition,
    health::{db_error, unix_timestamp},
    repository::get_card,
};
use crate::superthread::{SuperthreadCard, SuperthreadService};

const CHILD_FETCH_CONCURRENCY: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParentHierarchy {
    child_ids: Vec<String>,
    child_count: u64,
}

#[derive(Debug, Clone)]
struct FinishContext {
    local_id: String,
    external_id: String,
    project_id: String,
    workspace_slug: Option<String>,
    board_id: String,
    default_incoming_column_id: String,
    api_token_env_var: String,
    status: CardStatus,
    workflow_revision: i64,
}

#[derive(Debug, Clone)]
pub(in crate::kanban) struct ValidatedSuperthreadRefinement {
    context: FinishContext,
    parent: SuperthreadCard,
    children: Vec<SuperthreadCard>,
    hierarchy: ParentHierarchy,
}

pub(crate) fn finish_superthread_refinement(
    id: String,
    service: &SuperthreadService,
) -> Result<KanbanCard, String> {
    // This short read deliberately completes before any provider calls. The validated
    // provider snapshot is persisted later under the normal board-operation lock.
    let context = with_read_connection(|connection| load_finish_context(connection, &id))?;
    service.configure_token_env(&context.api_token_env_var)?;
    let workspace_slug = context.workspace_slug.as_deref();
    let parent = service.card(&context.external_id, workspace_slug)?;
    validate_refinement_destination(&parent, &context)?;
    let hierarchy = validate_parent_detail(&parent, &context.external_id)?;
    let children = fetch_children(service, &hierarchy.child_ids, workspace_slug)?;
    validate_children(&children, &hierarchy.child_ids, &context.external_id)?;
    for child in &children {
        validate_refinement_destination(child, &context)?;
    }

    // Superthread has no hierarchy revision token. A second authoritative read is
    // therefore required before any local mutation can begin.
    let confirmed_parent = service.card(&context.external_id, workspace_slug)?;
    validate_refinement_destination(&confirmed_parent, &context)?;
    let confirmed_hierarchy = validate_parent_detail(&confirmed_parent, &context.external_id)?;
    if confirmed_hierarchy != hierarchy {
        return Err("The Superthread child hierarchy changed while it was being fetched; retry finish_refinement".to_string());
    }

    let snapshot = ValidatedSuperthreadRefinement {
        context,
        parent: confirmed_parent,
        children,
        hierarchy,
    };
    with_board_mutation(|connection| persist_validated_refinement(connection, &snapshot))
}

fn load_finish_context(connection: &Connection, id: &str) -> Result<FinishContext, String> {
    connection.query_row(
        "SELECT c.id,c.external_id,c.project_id,c.status,c.workflow_revision,
                COALESCE(p.kanban_source,'local'),p.superthread_workspace_slug,c.external_provider,
                COALESCE(p.superthread_board_id,''),COALESCE(p.superthread_default_incoming_column_id,''),COALESCE(p.superthread_api_token_env_var,'ST_TOKEN')
         FROM kanban_cards c JOIN projects p ON p.id=c.project_id WHERE c.id=?1",
        [id],
        |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
            row.get::<_, CardStatus>(3)?, row.get::<_, i64>(4)?, row.get::<_, String>(5)?,
            row.get::<_, Option<String>>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?, row.get::<_, String>(9)?, row.get::<_, String>(10)?,
        )),
    ).optional().map_err(db_error)?.map(|(local_id, external_id, project_id, status, workflow_revision, source, workspace_slug, provider, board_id, default_incoming_column_id, api_token_env_var)| {
        if provider != "superthread" || source != "superthread" {
            return Err("Only a Superthread card owned by the configured Superthread project can use this refinement action".to_string());
        }
        if board_id.is_empty() || default_incoming_column_id.is_empty() { return Err("Configure the Superthread board and default incoming column before finishing refinement".to_string()); }
        Ok(FinishContext { local_id, external_id, project_id, workspace_slug, board_id, default_incoming_column_id, api_token_env_var, status, workflow_revision })
    }).transpose()?.ok_or_else(|| "Kanban card was not found".to_string())
}

fn validate_refinement_destination(
    card: &SuperthreadCard,
    context: &FinishContext,
) -> Result<(), String> {
    if card.board_id.trim() != context.board_id
        || card.list_id.trim() != context.default_incoming_column_id
    {
        return Err(format!(
            "Superthread card {} is not on the configured board and default incoming column",
            card.id
        ));
    }
    Ok(())
}

fn validate_parent_detail(
    card: &SuperthreadCard,
    expected_id: &str,
) -> Result<ParentHierarchy, String> {
    if card.id.trim() != expected_id {
        return Err(format!(
            "Superthread returned card {} while fetching parent {expected_id}",
            card.id
        ));
    }
    let child_count = card.total_task_children.ok_or_else(|| {
        format!("Superthread parent {expected_id} did not include total_task_children")
    })?;
    let children = match card.task_children.as_ref() {
        Some(children) => children,
        None if child_count == 0 => return Ok(ParentHierarchy { child_ids: Vec::new(), child_count }),
        None => return Err(format!("Superthread parent {expected_id} reports {child_count} children but did not include task_children")),
    };
    let mut child_ids = Vec::with_capacity(children.len());
    let mut unique = HashSet::new();
    for child in children {
        let child_id = child.task_id.trim();
        if child_id.is_empty() {
            return Err(format!(
                "Superthread parent {expected_id} included a child without an ID"
            ));
        }
        if !unique.insert(child_id.to_string()) {
            return Err(format!(
                "Superthread parent {expected_id} included duplicate child {child_id}"
            ));
        }
        child_ids.push(child_id.to_string());
    }
    if child_ids.len() as u64 != child_count {
        return Err(format!("Superthread parent {expected_id} reports {child_count} children but returned {} child IDs", child_ids.len()));
    }
    child_ids.sort();
    Ok(ParentHierarchy {
        child_ids,
        child_count,
    })
}

fn fetch_children(
    service: &SuperthreadService,
    child_ids: &[String],
    workspace_slug: Option<&str>,
) -> Result<Vec<SuperthreadCard>, String> {
    let mut cards = Vec::with_capacity(child_ids.len());
    for chunk in child_ids.chunks(CHILD_FETCH_CONCURRENCY) {
        let handles = chunk
            .iter()
            .cloned()
            .map(|child_id| {
                let service = service.clone();
                let slug = workspace_slug.map(str::to_string);
                std::thread::spawn(move || {
                    let result = service.card(&child_id, slug.as_deref());
                    (child_id, result)
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            let (child_id, result) = handle
                .join()
                .map_err(|_| "A Superthread child fetch worker failed".to_string())?;
            cards.push(result.map_err(|error| {
                format!("Could not fetch Superthread child {child_id}: {error}")
            })?);
        }
    }
    Ok(cards)
}

fn validate_children(
    cards: &[SuperthreadCard],
    expected_ids: &[String],
    parent_id: &str,
) -> Result<(), String> {
    let mut returned = Vec::with_capacity(cards.len());
    for card in cards {
        let id = card.id.trim();
        returned.push(id.to_string());
        if card.task_parent.as_ref().map(|parent| parent.id.trim()) != Some(parent_id) {
            return Err(format!(
                "Superthread child {id} does not identify {parent_id} as its task parent"
            ));
        }
    }
    returned.sort();
    if returned != expected_ids {
        return Err(format!(
            "Superthread returned incorrect child identities for parent {parent_id}"
        ));
    }
    Ok(())
}

fn persist_validated_refinement(
    connection: &mut Connection,
    snapshot: &ValidatedSuperthreadRefinement,
) -> Result<KanbanCard, String> {
    let transaction = connection
        .savepoint()
        .map_err(db_error)?;
    let current: (String, String, Option<String>, CardStatus, i64, bool, i64) = transaction.query_row(
        "SELECT external_provider,external_id,project_id,status,workflow_revision,hierarchy_finalized,provider_child_count FROM kanban_cards WHERE id=?1",
        [&snapshot.context.local_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get::<_, i64>(5)? != 0, row.get(6)?)),
    ).optional().map_err(db_error)?.ok_or_else(|| "Kanban card was not found".to_string())?;
    if current.0 != "superthread"
        || current.1 != snapshot.context.external_id
        || current.2.as_deref() != Some(&snapshot.context.project_id)
    {
        return Err(
            "The Superthread parent ownership changed while refinement was finishing".to_string(),
        );
    }

    let linked_ids = linked_external_child_ids(&transaction, &snapshot.context.local_id)?;
    if current.5
        && (linked_ids != snapshot.hierarchy.child_ids
            || current.6 as u64 != snapshot.hierarchy.child_count)
    {
        return Err(
            "The finalized local hierarchy conflicts with the authoritative Superthread hierarchy"
                .to_string(),
        );
    }
    if !current.5
        && (current.3 != snapshot.context.status || current.4 != snapshot.context.workflow_revision)
    {
        return Err("The parent workflow changed while the Superthread hierarchy was being fetched; retry finish_refinement".to_string());
    }

    let now = unix_timestamp();
    upsert_provider_card(
        &transaction,
        &snapshot.parent,
        &snapshot.context.project_id,
        now,
        true,
    )?;
    for child in &snapshot.children {
        upsert_provider_card(&transaction, child, &snapshot.context.project_id, now, true)?;
    }

    // Validate every local child state before touching relationships or emitting transitions.
    for child in &snapshot.children {
        let local_id = format!("superthread:{}", child.id.trim());
        let status: CardStatus = transaction
            .query_row(
                "SELECT status FROM kanban_cards WHERE id=?1",
                [&local_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if matches!(
            status,
            CardStatus::Refining | CardStatus::NeedsRefinementInput
        ) {
            return Err(format!("Superthread child {} has an active refinement session ({status}); finish or stop that child refinement, then retry. Stacks did not interrupt it", child.id.trim()));
        }
    }

    transaction.execute(
        "UPDATE kanban_cards SET parent_id=NULL,provider_parent_title=NULL,updated_at=?1 WHERE external_provider='superthread' AND parent_id=?2",
        params![now, snapshot.context.local_id],
    ).map_err(db_error)?;
    for child in &snapshot.children {
        transaction.execute(
            "UPDATE kanban_cards SET parent_id=?1,provider_parent_title=?2,project_id=?3,in_scope=1,updated_at=?4 WHERE external_provider='superthread' AND external_id=?5",
            params![snapshot.context.local_id, snapshot.parent.title.trim(), snapshot.context.project_id, now, child.id.trim()],
        ).map_err(db_error)?;
        let local_id = format!("superthread:{}", child.id.trim());
        let status: CardStatus = transaction
            .query_row(
                "SELECT status FROM kanban_cards WHERE id=?1",
                [&local_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if status == CardStatus::NeedsRefinement {
            apply_workflow_transition(
                &transaction,
                &local_id,
                WorkflowActor::Agent,
                WorkflowAction::FinishRefinement,
                None,
                "finish_refinement",
                Some("Approved as part of Superthread card breakdown"),
            )?;
        }
    }

    if !current.5 {
        match current.3 {
            CardStatus::NeedsRefinement
            | CardStatus::Refining
            | CardStatus::NeedsRefinementInput => {
                apply_workflow_transition(
                    &transaction,
                    &snapshot.context.local_id,
                    WorkflowActor::Agent,
                    WorkflowAction::FinishRefinement,
                    Some(current.4),
                    "finish_refinement",
                    Some("Approved Superthread card breakdown"),
                )?;
            }
            CardStatus::Ready => {}
            _ => {
                return Err(format!(
                    "finish_refinement is not available while the parent card is {}",
                    current.3
                ))
            }
        }
    } else if current.3 != CardStatus::Ready {
        return Err(format!(
            "The finalized Superthread parent has unexpected workflow state {}",
            current.3
        ));
    }
    transaction.execute(
        "UPDATE kanban_cards SET provider_child_count=?1,hierarchy_finalized=1,in_scope=1,updated_at=?2 WHERE id=?3",
        params![snapshot.hierarchy.child_count as i64, now, snapshot.context.local_id],
    ).map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    get_card(connection, &snapshot.context.local_id)?
        .ok_or_else(|| "Kanban card was not found".to_string())
}

fn linked_external_child_ids(
    connection: &Connection,
    parent_id: &str,
) -> Result<Vec<String>, String> {
    let mut ids = connection.prepare("SELECT external_id FROM kanban_cards WHERE external_provider='superthread' AND parent_id=?1 ORDER BY external_id").map_err(db_error)?
        .query_map([parent_id], |row| row.get::<_, String>(0)).map_err(db_error)?
        .collect::<Result<Vec<_>, _>>().map_err(db_error)?;
    ids.sort();
    Ok(ids)
}

fn upsert_provider_card(
    transaction: &Connection,
    card: &SuperthreadCard,
    project_id: &str,
    now: i64,
    in_scope: bool,
) -> Result<(), String> {
    let external_id = card.id.trim();
    if external_id.is_empty() || card.title.trim().is_empty() {
        return Err("Superthread returned a card without an ID or title".to_string());
    }
    let binding_id: Option<String> = transaction.query_row("SELECT superthread_binding_id FROM projects WHERE id=?1", [project_id], |row| row.get(0)).optional().map_err(db_error)?.flatten();
    let existing_id = if let Some(binding) = binding_id.as_deref() {
        transaction.query_row("SELECT id FROM kanban_cards WHERE binding_id=?1 AND external_id=?2", params![binding,external_id], |row| row.get::<_,String>(0)).optional().map_err(db_error)?
    } else { None };
    let local_id = existing_id.unwrap_or_else(|| binding_id.as_ref().map(|binding| format!("superthread:{binding}:{external_id}")).unwrap_or_else(|| format!("superthread:{external_id}")));
    let parent_id = if let Some(parent) = card.task_parent.as_ref() {
        if let Some(binding) = binding_id.as_deref() {
            transaction.query_row("SELECT id FROM kanban_cards WHERE binding_id=?1 AND external_id=?2", params![binding,parent.id.trim()], |row| row.get::<_,String>(0)).optional().map_err(db_error)?
        } else { Some(format!("superthread:{}", parent.id.trim())) }
    } else { None };
    let parent_title = card
        .task_parent
        .as_ref()
        .map(|parent| parent.title.trim().to_string());
    let child_count = card.total_task_children.unwrap_or(0) as i64;
    transaction.execute(
        "INSERT INTO kanban_cards (id,external_provider,external_id,title,content,board_id,board_title,list_id,list_title,card_url,assignee_names,status,project_id,parent_id,provider_parent_title,provider_child_count,created_at,updated_at,sort_order,in_scope,binding_id)
         VALUES (?1,'superthread',?2,?3,COALESCE(?4,''),?5,?6,?7,?8,?9,?10,'needs_refinement',?11,?12,?13,?14,?15,?15,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM kanban_cards WHERE status='needs_refinement'),?16,?17)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=CASE WHEN ?4 IS NULL THEN kanban_cards.content ELSE ?4 END,board_id=excluded.board_id,board_title=excluded.board_title,list_id=excluded.list_id,list_title=excluded.list_title,card_url=excluded.card_url,assignee_names=excluded.assignee_names,project_id=excluded.project_id,provider_child_count=excluded.provider_child_count,in_scope=MAX(kanban_cards.in_scope,excluded.in_scope),updated_at=excluded.updated_at",
        params![local_id, external_id, card.title.trim(), card.content, card.board_id, card.board_title, card.list_id, card.list_title, card.card_url, serde_json::to_string(&card.assignee_names).map_err(|error| error.to_string())?, project_id, parent_id, parent_title, child_count, now, i64::from(in_scope), binding_id],
    ).map_err(db_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn card(value: serde_json::Value) -> SuperthreadCard {
        serde_json::from_value(value).unwrap()
    }

    fn parent(children: Option<Vec<&str>>, count: Option<u64>) -> SuperthreadCard {
        let task_children = children.map(|ids| {
            ids.into_iter()
                .map(|id| json!({ "task_id": id, "title": format!("Child {id}") }))
                .collect::<Vec<_>>()
        });
        card(json!({
            "id": "parent", "title": "Authoritative parent", "content": "Plan",
            "list_id": "ready-list", "list_title": "Ready", "board_id": "board", "board_title": "Board",
            "task_children": task_children, "total_task_children": count
        }))
    }

    fn child(id: &str) -> SuperthreadCard {
        card(json!({
            "id": id, "title": format!("Authoritative {id}"), "content": format!("Brief {id}"),
            "list_id": "ready-list", "list_title": "Ready", "board_id": "board", "board_title": "Board",
            "task_parent": { "id": "parent", "title": "Authoritative parent" }, "total_task_children": 0
        }))
    }

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        crate::store::migrate_store_schema(&connection).unwrap();
        connection.execute(
            "INSERT INTO projects(id,name,path,kanban_source,superthread_spaces,sort_order) VALUES ('owner','Owner','/tmp/owner','superthread','Product',0)",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO kanban_cards(id,external_provider,external_id,title,status,workflow_revision,project_id,created_at,updated_at,in_scope) VALUES ('superthread:parent','superthread','parent','Old parent','needs_refinement',4,'owner',1,1,1)",
            [],
        ).unwrap();
        connection
    }

    fn snapshot(
        parent: SuperthreadCard,
        children: Vec<SuperthreadCard>,
    ) -> ValidatedSuperthreadRefinement {
        let hierarchy = validate_parent_detail(&parent, "parent").unwrap();
        validate_children(&children, &hierarchy.child_ids, "parent").unwrap();
        ValidatedSuperthreadRefinement {
            context: FinishContext {
                local_id: "superthread:parent".into(),
                external_id: "parent".into(),
                project_id: "owner".into(),
                workspace_slug: None,
                board_id: "board".into(),
                default_incoming_column_id: "ready-list".into(),
                api_token_env_var: "ST_TOKEN".into(),
                status: CardStatus::NeedsRefinement,
                workflow_revision: 4,
            },
            parent,
            children,
            hierarchy,
        }
    }

    #[test]
    fn parent_shape_validation_requires_complete_unique_authoritative_ids() {
        assert_eq!(
            validate_parent_detail(&parent(None, Some(0)), "parent")
                .unwrap()
                .child_ids,
            Vec::<String>::new()
        );
        assert!(validate_parent_detail(&parent(None, Some(1)), "parent")
            .unwrap_err()
            .contains("did not include task_children"));
        assert!(
            validate_parent_detail(&parent(Some(vec!["one"]), None), "parent")
                .unwrap_err()
                .contains("total_task_children")
        );
        assert!(
            validate_parent_detail(&parent(Some(vec!["one", "one"]), Some(2)), "parent")
                .unwrap_err()
                .contains("duplicate")
        );
        assert!(
            validate_parent_detail(&parent(Some(vec!["one"]), Some(2)), "parent")
                .unwrap_err()
                .contains("reports 2")
        );
        let wrong =
            card(json!({ "id":"wrong", "title":"Wrong", "list_id":"l", "total_task_children":0 }));
        assert!(validate_parent_detail(&wrong, "parent")
            .unwrap_err()
            .contains("while fetching parent"));
    }

    #[test]
    fn child_validation_requires_exact_ids_and_parent_claims() {
        assert!(
            validate_children(&[child("wrong")], &["one".into()], "parent")
                .unwrap_err()
                .contains("incorrect child identities")
        );
        let cross_parent = card(json!({
            "id":"one", "title":"One", "list_id":"l", "task_parent":{"id":"other"}, "total_task_children":0
        }));
        assert!(
            validate_children(&[cross_parent], &["one".into()], "parent")
                .unwrap_err()
                .contains("does not identify parent")
        );
    }

    #[test]
    fn aggregate_persistence_imports_links_readies_and_retries_without_duplicate_events() {
        let mut connection = database();
        let value = snapshot(
            parent(Some(vec!["one", "two"]), Some(2)),
            vec![child("one"), child("two")],
        );
        let result = persist_validated_refinement(&mut connection, &value).unwrap();
        assert_eq!(result.status, CardStatus::Ready);
        assert!(result.hierarchy_finalized);
        assert_eq!(result.children.len(), 2);
        assert!(result
            .children
            .iter()
            .all(|child| child.status == CardStatus::Ready));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM card_events", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM kanban_cards WHERE project_id='owner' AND in_scope=1",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            3
        );

        let retried = persist_validated_refinement(&mut connection, &value).unwrap();
        assert!(retried.hierarchy_finalized);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM card_events", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM kanban_cards", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
    }

    #[test]
    fn completed_and_in_progress_child_workflow_states_are_preserved() {
        for status in [
            CardStatus::Ready,
            CardStatus::AgentWorking,
            CardStatus::NeedsHuman,
            CardStatus::Approved,
            CardStatus::Done,
        ] {
            let mut connection = database();
            connection.execute(
                "INSERT INTO kanban_cards(id,external_provider,external_id,title,status,workflow_revision,project_id,created_at,updated_at,in_scope) VALUES ('superthread:one','superthread','one','Old child',?1,7,'owner',1,1,0)",
                [status],
            ).unwrap();
            let value = snapshot(parent(Some(vec!["one"]), Some(1)), vec![child("one")]);
            persist_validated_refinement(&mut connection, &value).unwrap();
            let stored: (CardStatus, i64) = connection
                .query_row(
                    "SELECT status,workflow_revision FROM kanban_cards WHERE id='superthread:one'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(stored, (status, 7));
        }
    }

    #[test]
    fn active_child_conflict_rolls_back_all_metadata_links_and_transitions() {
        let mut connection = database();
        connection.execute(
            "INSERT INTO kanban_cards(id,external_provider,external_id,title,status,workflow_revision,project_id,created_at,updated_at,in_scope) VALUES ('superthread:one','superthread','one','Old child','refining',7,'owner',1,1,0)",
            [],
        ).unwrap();
        let value = snapshot(parent(Some(vec!["one"]), Some(1)), vec![child("one")]);
        let error = persist_validated_refinement(&mut connection, &value).unwrap_err();
        assert!(error.contains("active refinement session"));
        let unchanged: (String, CardStatus, Option<String>, i64) = connection.query_row(
            "SELECT title,status,parent_id,in_scope FROM kanban_cards WHERE id='superthread:one'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
        assert_eq!(
            unchanged,
            ("Old child".into(), CardStatus::Refining, None, 0)
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT hierarchy_finalized FROM kanban_cards WHERE id='superthread:parent'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM card_events", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn zero_children_finalizes_parent_and_valid_snapshot_reconciles_stale_links() {
        let mut connection = database();
        connection.execute(
            "INSERT INTO kanban_cards(id,external_provider,external_id,title,status,project_id,parent_id,created_at,updated_at) VALUES ('superthread:stale','superthread','stale','Stale','approved','owner','superthread:parent',1,1)",
            [],
        ).unwrap();
        let value = snapshot(parent(None, Some(0)), Vec::new());
        let result = persist_validated_refinement(&mut connection, &value).unwrap();
        assert!(result.hierarchy_finalized);
        assert_eq!(result.child_count, 0);
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id FROM kanban_cards WHERE id='superthread:stale'",
                    [],
                    |row| row.get::<_, Option<String>>(0)
                )
                .unwrap(),
            None
        );
    }
}
