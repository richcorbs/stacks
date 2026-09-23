use super::health::db_error;
use super::*;

/// Return the project's currently usable Superthread binding. Refinement and
/// background sync intentionally share this gate so one cannot import cards
/// that the other would reject.
pub(in crate::kanban) fn active_superthread_binding(
    connection: &Connection,
    project_id: &str,
) -> Result<String, String> {
    connection
        .query_row(
            "SELECT b.id
             FROM projects p
             JOIN superthread_bindings b
               ON b.id=p.superthread_binding_id AND b.project_id=p.id
             WHERE p.id=?1 AND b.state='active' AND b.validated_at IS NOT NULL",
            [project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| {
            "Superthread synchronization is paused until this project's legacy binding is validated with stable IDs".to_string()
        })
}

/// Preserve the migration/adoption behavior used by provider sync. This is
/// deliberately transaction-scoped when called by refinement.
pub(in crate::kanban) fn adopt_legacy_superthread_rows(
    connection: &Connection,
    project_id: &str,
    binding_id: &str,
) -> Result<(), String> {
    connection
        .execute(
            "UPDATE kanban_cards SET binding_id=?1
             WHERE project_id=?2 AND external_provider='superthread' AND binding_id IS NULL",
            params![binding_id, project_id],
        )
        .map(|_| ())
        .map_err(|error| {
            format!("Could not adopt legacy Superthread cards for binding {binding_id}: {error}")
        })
}

/// Resolve the one canonical local identity for a provider card without ever
/// reusing an ID owned by another provider identity or binding.
pub(in crate::kanban) fn resolve_superthread_local_id(
    connection: &Connection,
    binding_id: &str,
    external_id: &str,
) -> Result<String, String> {
    let external_id = external_id.trim();
    if external_id.is_empty() {
        return Err("Cannot resolve a Superthread card without an external ID".to_string());
    }

    if let Some(id) = connection
        .query_row(
            "SELECT id FROM kanban_cards WHERE binding_id=?1 AND external_id=?2",
            params![binding_id, external_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| {
            format!("Could not resolve Superthread identity {binding_id}/{external_id}: {error}")
        })?
    {
        return Ok(id);
    }

    let legacy_id = format!("superthread:{external_id}");
    if !local_id_is_occupied(connection, &legacy_id)? {
        return Ok(legacy_id);
    }

    let qualified_id = format!("superthread:{binding_id}:{external_id}");
    if !local_id_is_occupied(connection, &qualified_id)? {
        return Ok(qualified_id);
    }

    Err(format!(
        "Superthread identity collision for binding {binding_id}, card {external_id}: both {legacy_id} and {qualified_id} are owned by other cards"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kanban::repository::{initialize_connection, migrate};

    fn database() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        initialize_connection(&mut connection, false).unwrap();
        connection
    }

    fn occupy(
        connection: &Connection,
        id: &str,
        provider: &str,
        external_id: &str,
        binding: Option<&str>,
    ) {
        connection.execute(
            "INSERT INTO kanban_cards(id,external_provider,external_id,title,status,created_at,updated_at,binding_id) VALUES (?1,?2,?3,'Card','needs_refinement',1,1,?4)",
            params![id, provider, external_id, binding],
        ).unwrap();
    }

    #[test]
    fn resolution_reuses_binding_identity_then_selects_legacy_or_qualified_ids() {
        let connection = database();
        occupy(
            &connection,
            "noncanonical",
            "superthread",
            "card",
            Some("binding"),
        );
        assert_eq!(
            resolve_superthread_local_id(&connection, "binding", "card").unwrap(),
            "noncanonical"
        );
        occupy(
            &connection,
            "superthread:legacy",
            "superthread",
            "legacy",
            Some("binding"),
        );
        assert_eq!(
            resolve_superthread_local_id(&connection, "binding", "legacy").unwrap(),
            "superthread:legacy"
        );
        occupy(
            &connection,
            "superthread:qualified",
            "local:other",
            "qualified",
            None,
        );
        assert_eq!(
            resolve_superthread_local_id(&connection, "binding", "qualified").unwrap(),
            "superthread:binding:qualified"
        );
    }

    #[test]
    fn resolution_reports_collision_without_claiming_an_identity_owned_elsewhere() {
        let connection = database();
        occupy(
            &connection,
            "superthread:card",
            "local:other",
            "other",
            None,
        );
        occupy(
            &connection,
            "superthread:binding:card",
            "local:also-other",
            "also-other",
            None,
        );
        let error = resolve_superthread_local_id(&connection, "binding", "card").unwrap_err();
        assert!(error.contains("identity collision"));
        assert!(error.contains("superthread:binding:card"));
        assert_eq!(
            connection
                .query_row(
                    "SELECT external_id FROM kanban_cards WHERE id='superthread:card'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "other"
        );
    }
}

fn local_id_is_occupied(connection: &Connection, id: &str) -> Result<bool, String> {
    connection
        .query_row("SELECT 1 FROM kanban_cards WHERE id=?1", [id], |_| Ok(()))
        .optional()
        .map(|row| row.is_some())
        .map_err(|error| format!("Could not inspect local card identity {id}: {error}"))
}
