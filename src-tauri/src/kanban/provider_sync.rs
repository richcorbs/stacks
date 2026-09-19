use super::health::{db_error, unix_timestamp};
use super::*;
use crate::superthread::SuperthreadService;
use rusqlite::OptionalExtension;
use std::sync::{Mutex, OnceLock};

static PROVIDER_SYNC_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProviderSyncOperationSummary {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub destination_column_name: String,
    pub attempts: i64,
    pub error: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug)]
struct Operation {
    id: String,
    card_id: String,
    kind: String,
    provider: String,
    external_id: String,
    board_id: String,
    source_column_id: String,
    source_column_name: String,
    destination_column_id: String,
    destination_column_name: String,
    workflow_revision: i64,
    integration_revision: i64,
    project_id: String,
    api_token_env_var: String,
}

pub(in crate::kanban) fn enqueue_transition(
    connection: &Connection,
    card_id: &str,
    kind: &str,
    workflow_revision: i64,
) -> Result<Option<String>, String> {
    let row: Option<(String, String, String, String, String, String, i64, String, String, String, String)> = connection.query_row(
        "SELECT c.external_provider,c.external_id,c.board_id,c.list_id,c.list_title,c.project_id,
                p.superthread_mapping_revision,COALESCE(p.superthread_api_token_env_var,'ST_TOKEN'),
                CASE ?2 WHEN 'start_work' THEN COALESCE(p.superthread_in_progress_column_id,'') ELSE COALESCE(p.superthread_done_column_id,'') END,
                CASE ?2 WHEN 'start_work' THEN COALESCE(p.superthread_in_progress_column_name,'') ELSE COALESCE(p.superthread_done_column_name,'') END,
                c.status
         FROM kanban_cards c JOIN projects p ON p.id=c.project_id WHERE c.id=?1",
        params![card_id, kind],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?)),
    ).optional().map_err(db_error)?;
    let Some((
        provider,
        external_id,
        board_id,
        source_id,
        source_name,
        project_id,
        integration_revision,
        token_env,
        destination_id,
        destination_name,
        status,
    )) = row
    else {
        return Ok(None);
    };
    if provider != "superthread" || destination_id.is_empty() || board_id.is_empty() {
        return Ok(None);
    }
    if kind == "start_work" && status != "agent_working" || kind == "done" && status != "done" {
        return Ok(None);
    }

    let existing: Option<String> = connection.query_row("SELECT id FROM provider_sync_operations WHERE card_id=?1 AND kind=?2 AND workflow_revision=?3 AND integration_revision=?4 AND destination_column_id=?5 AND state IN ('pending','running','failed') ORDER BY created_at DESC LIMIT 1", params![card_id,kind,workflow_revision,integration_revision,destination_id], |row| row.get(0)).optional().map_err(db_error)?;
    if existing.is_some() {
        return Ok(existing);
    }
    connection.execute(
        "UPDATE provider_sync_operations SET state='superseded',updated_at=?1,error='Superseded by a newer workflow transition' WHERE card_id=?2 AND kind=?3 AND state IN ('pending','failed')",
        params![unix_timestamp(),card_id,kind],
    ).map_err(db_error)?;
    let logical_revision: i64 = connection.query_row("SELECT COALESCE(MAX(logical_revision),-1)+1 FROM provider_sync_operations WHERE card_id=?1 AND kind=?2 AND workflow_revision=?3 AND integration_revision=?4", params![card_id,kind,workflow_revision,integration_revision], |row| row.get(0)).map_err(db_error)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = unix_timestamp();
    connection.execute(
        "INSERT INTO provider_sync_operations
         (id,card_id,kind,provider,external_id,board_id,source_column_id,source_column_name,destination_column_id,destination_column_name,workflow_revision,integration_revision,project_id,api_token_env_var,state,logical_revision,attempts,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'pending',?15,0,?16,?16)",
        params![id,card_id,kind,provider,external_id,board_id,source_id,source_name,destination_id,destination_name,workflow_revision,integration_revision,project_id,token_env,logical_revision,now],
    ).map_err(db_error)?;
    let inserted = connection.changes() == 1;
    if inserted {
        connection.execute("INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,summary) VALUES (?1,?2,'system','provider_sync_queued','success',?3)", params![card_id,now,format!("Queued Superthread move from {source_name} to {destination_name}")]).map_err(db_error)?;
        Ok(Some(id))
    } else {
        Ok(None)
    }
}

pub(in crate::kanban) fn enqueue_repairs(
    connection: &Connection,
    project_id: &str,
) -> Result<(), String> {
    let rows = {
        let mut statement = connection.prepare(
            "SELECT c.id,c.status,c.workflow_revision,c.list_id,c.scope_suspended,
                    COALESCE(p.superthread_in_progress_column_id,''),COALESCE(p.superthread_done_column_id,'')
             FROM kanban_cards c JOIN projects p ON p.id=c.project_id
             WHERE c.project_id=?1 AND c.external_provider='superthread' AND c.in_scope=1") .map_err(db_error)?;
        let rows = statement
            .query_map([project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)? != 0,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        rows
    };
    for (id, status, revision, list, suspended, progress, done) in rows {
        let kind = if matches!(
            status.as_str(),
            "agent_working" | "needs_human" | "approved"
        ) && list != progress
        {
            Some("start_work")
        } else if status == "done" && !suspended && list != done {
            Some("done")
        } else {
            None
        };
        if let Some(kind) = kind {
            enqueue_transition(connection, &id, kind, revision)?;
        }
    }
    Ok(())
}

pub(crate) fn supersede_for_mapping_change(
    connection: &Connection,
    project_id: &str,
) -> Result<(), String> {
    let running: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM provider_sync_operations WHERE project_id=?1 AND state='running'",
            [project_id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if running > 0 {
        return Err("Superthread column mapping cannot be saved while provider synchronization is executing".into());
    }
    connection.execute("UPDATE provider_sync_operations SET state='superseded',error='Superseded by updated Superthread column mapping',updated_at=?1 WHERE project_id=?2 AND state IN ('pending','failed')", params![unix_timestamp(),project_id]).map_err(db_error)?;
    enqueue_repairs(connection, project_id)
}

pub(crate) fn unresolved_for_project(
    connection: &Connection,
    project_id: &str,
) -> Result<i64, String> {
    connection.query_row("SELECT COUNT(*) FROM provider_sync_operations WHERE project_id=?1 AND state IN ('pending','running','failed')", [project_id], |row| row.get(0)).map_err(db_error)
}

pub(crate) fn executing_for_project(
    connection: &Connection,
    project_id: &str,
) -> Result<bool, String> {
    connection.query_row("SELECT EXISTS(SELECT 1 FROM provider_sync_operations WHERE project_id=?1 AND state='running')", [project_id], |row| row.get::<_,i64>(0)).map(|value|value!=0).map_err(db_error)
}

fn operation(connection: &Connection, id: &str) -> Result<Option<Operation>, String> {
    connection.query_row(
        "SELECT id,card_id,kind,provider,external_id,board_id,source_column_id,source_column_name,destination_column_id,destination_column_name,workflow_revision,integration_revision,project_id,api_token_env_var FROM provider_sync_operations WHERE id=?1",
        [id], |r| Ok(Operation{id:r.get(0)?,card_id:r.get(1)?,kind:r.get(2)?,provider:r.get(3)?,external_id:r.get(4)?,board_id:r.get(5)?,source_column_id:r.get(6)?,source_column_name:r.get(7)?,destination_column_id:r.get(8)?,destination_column_name:r.get(9)?,workflow_revision:r.get(10)?,integration_revision:r.get(11)?,project_id:r.get(12)?,api_token_env_var:r.get(13)?})
    ).optional().map_err(db_error)
}

fn finish(
    connection: &Connection,
    op: &Operation,
    state: &str,
    error: Option<&str>,
    summary: &str,
) -> Result<(), String> {
    let now = unix_timestamp();
    connection.execute("UPDATE provider_sync_operations SET state=?1,error=?2,updated_at=?3,completed_at=CASE WHEN ?1 IN ('succeeded','stale','superseded') THEN ?3 ELSE completed_at END WHERE id=?4", params![state,error,now,op.id]).map_err(db_error)?;
    connection.execute("UPDATE provider_sync_attempts SET finished_at=?1,outcome=?2,error=?3 WHERE id=(SELECT MAX(id) FROM provider_sync_attempts WHERE operation_id=?4)", params![now,state,error,op.id]).map_err(db_error)?;
    connection.execute("INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,summary,error_code,error_detail) VALUES (?1,?2,'system','provider_sync',?3,?4,?5,?6)", params![op.card_id,now,if state=="failed"{"failure"}else{"success"},summary,if state=="failed"{Some("provider_sync_failed")}else{None},error]).map_err(db_error)?;
    Ok(())
}

fn attempt(service: &SuperthreadService, id: &str) -> Result<(), String> {
    with_connection(|connection| {
        let Some(op) = operation(connection, id)? else {
            return Ok(());
        };
        let state: String = connection
            .query_row(
                "SELECT state FROM provider_sync_operations WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        if !matches!(state.as_str(), "pending" | "failed") {
            return Ok(());
        }
        let current:Option<(String,String,String,i64,i64,String,i64)>=connection.query_row(
            "SELECT c.external_provider,c.external_id,c.board_id,c.workflow_revision,p.superthread_mapping_revision,c.status,c.scope_suspended FROM kanban_cards c JOIN projects p ON p.id=c.project_id WHERE c.id=?1 AND c.project_id=?2",
            params![op.card_id,op.project_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional().map_err(db_error)?;
        let applies = current.as_ref().is_some_and(
            |(provider, external, board, workflow, integration, status, suspended)| {
                provider == &op.provider
                    && external == &op.external_id
                    && board == &op.board_id
                    && *workflow == op.workflow_revision
                    && *integration == op.integration_revision
                    && ((op.kind == "start_work"
                        && matches!(
                            status.as_str(),
                            "agent_working" | "needs_human" | "approved"
                        ))
                        || (op.kind == "done" && status == "done" && *suspended == 0))
            },
        );
        if !applies {
            return finish(
                connection,
                &op,
                "stale",
                None,
                "Skipped stale Superthread synchronization",
            );
        }
        let now = unix_timestamp();
        connection.execute("UPDATE provider_sync_operations SET state='running',attempts=attempts+1,error=NULL,updated_at=?1 WHERE id=?2",params![now,id]).map_err(db_error)?;
        connection.execute("INSERT INTO provider_sync_attempts(operation_id,attempt_number,started_at) SELECT id,attempts,?1 FROM provider_sync_operations WHERE id=?2",params![now,id]).map_err(db_error)?;
        if let Err(error) = service.configure_token_env(&op.api_token_env_var) {
            return finish(
                connection,
                &op,
                "failed",
                Some(&error),
                "Superthread synchronization failed",
            );
        }
        let live = match service.card(&op.external_id, None) {
            Ok(card) => card,
            Err(error) => {
                return finish(
                    connection,
                    &op,
                    "failed",
                    Some(&error),
                    "Superthread synchronization failed",
                )
            }
        };
        if live.id != op.external_id || live.board_id != op.board_id {
            return finish(
                connection,
                &op,
                "failed",
                Some("The exact Superthread card is no longer on the configured board"),
                "Superthread identity validation failed",
            );
        }
        if live.list_id != op.destination_column_id {
            if let Err(error) =
                service.move_card(&op.external_id, &op.board_id, &op.destination_column_id)
            {
                return finish(
                    connection,
                    &op,
                    "failed",
                    Some(&error),
                    "Superthread synchronization failed",
                );
            }
        }
        connection
            .execute(
                "UPDATE kanban_cards SET list_id=?1,list_title=?2,updated_at=?3 WHERE id=?4",
                params![
                    op.destination_column_id,
                    op.destination_column_name,
                    unix_timestamp(),
                    op.card_id
                ],
            )
            .map_err(db_error)?;
        finish(
            connection,
            &op,
            "succeeded",
            None,
            &format!(
                "Moved Superthread card from {} ({}) to {}",
                op.source_column_name, op.source_column_id, op.destination_column_name
            ),
        )
    })
}

pub(crate) fn run_pending_once(
    service: SuperthreadService,
    card_id: Option<&str>,
) -> Result<(), String> {
    let _guard = PROVIDER_SYNC_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Provider synchronization lock failed".to_string())?;
    with_connection(|connection| {
        let projects = if let Some(card_id) = card_id {
            connection
                .query_row(
                    "SELECT project_id FROM kanban_cards WHERE id=?1",
                    [card_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(db_error)?
                .flatten()
                .into_iter()
                .collect::<Vec<_>>()
        } else {
            let mut statement = connection
                .prepare("SELECT id FROM projects WHERE kanban_source='superthread'")
                .map_err(db_error)?;
            let projects = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            projects
        };
        for project in projects {
            enqueue_repairs(connection, &project)?;
        }
        Ok(())
    })?;
    let ids = with_connection(|connection| {
        let sql = if card_id.is_some() {
            "SELECT id FROM provider_sync_operations WHERE card_id=?1 AND state IN ('pending','failed') ORDER BY created_at,id"
        } else {
            "SELECT id FROM provider_sync_operations WHERE (?1 IS NULL) AND state IN ('pending','failed') ORDER BY created_at,id"
        };
        let mut statement = connection.prepare(sql).map_err(db_error)?;
        let ids = statement
            .query_map([card_id], |r| r.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(ids)
    })?;
    for id in ids {
        let _ = attempt(&service, &id);
    }
    Ok(())
}

pub(in crate::kanban) fn load_summaries(
    connection: &Connection,
    cards: &mut [KanbanCard],
) -> Result<(), String> {
    let indexes = cards
        .iter()
        .enumerate()
        .map(|(index, card)| (card.id.clone(), index))
        .collect::<std::collections::HashMap<_, _>>();
    let mut statement=connection.prepare("SELECT card_id,id,kind,state,destination_column_name,attempts,error,updated_at FROM provider_sync_operations ORDER BY card_id,CASE state WHEN 'failed' THEN 0 WHEN 'running' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,created_at DESC").map_err(db_error)?;
    let rows = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                ProviderSyncOperationSummary {
                    id: r.get(1)?,
                    kind: r.get(2)?,
                    state: r.get(3)?,
                    destination_column_name: r.get(4)?,
                    attempts: r.get(5)?,
                    error: r.get(6)?,
                    updated_at: r.get(7)?,
                },
            ))
        })
        .map_err(db_error)?;
    for row in rows {
        let (card_id, summary) = row.map_err(db_error)?;
        if let Some(index) = indexes.get(&card_id) {
            if cards[*index].provider_sync.is_none() {
                cards[*index].provider_sync = Some(summary);
            }
        }
    }
    Ok(())
}

pub(in crate::kanban) fn load_summary(
    connection: &Connection,
    card_id: &str,
) -> Result<Option<ProviderSyncOperationSummary>, String> {
    connection.query_row(
        "SELECT id,kind,state,destination_column_name,attempts,error,updated_at FROM provider_sync_operations WHERE card_id=?1 ORDER BY CASE state WHEN 'failed' THEN 0 WHEN 'running' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,created_at DESC LIMIT 1",
        [card_id], |r| Ok(ProviderSyncOperationSummary{id:r.get(0)?,kind:r.get(1)?,state:r.get(2)?,destination_column_name:r.get(3)?,attempts:r.get(4)?,error:r.get(5)?,updated_at:r.get(6)?})
    ).optional().map_err(db_error)
}

pub(crate) fn recover_interrupted(connection: &Connection) -> Result<(), String> {
    connection.execute("UPDATE provider_sync_operations SET state='failed',error='Stacks stopped while provider synchronization was executing',updated_at=?1 WHERE state='running'",[unix_timestamp()]).map(|_|()).map_err(db_error)
}
