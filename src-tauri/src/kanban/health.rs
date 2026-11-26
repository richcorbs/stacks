use super::*;
#[allow(unused_imports)]
use super::{
    cards::*, cleanup::*, domain::*, environment::*, git_effects::*, github_delivery::*,
    local_delivery::*, repository::*, sync::*,
};

pub(in crate::kanban) fn validate_card_environment_project(
    connection: &Connection,
    card_id: &str,
) -> Result<(), String> {
    let (card_project, environment_project, repository_id, provider): (String, String, Option<String>, String) = connection.query_row(
        "SELECT c.project_id, e.project_id, e.repository_id, c.external_provider FROM kanban_cards c JOIN card_environments e ON e.card_id=c.id WHERE c.id=?1",
        [card_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional().map_err(db_error)?.ok_or_else(|| "The card environment or project ownership is missing".to_string())?;
    if card_project != environment_project {
        return Err("The card/environment project mismatch blocks this operation".to_string());
    }
    let (project_path, source): (String, String) = connection
        .query_row(
            "SELECT path, COALESCE(kanban_source, 'local') FROM projects WHERE id=?1",
            [&card_project],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "The card's owning project no longer exists".to_string())?;
    if (provider == "superthread") != (source == "superthread") {
        return Err("The card's owning project is not compatible with its provider".to_string());
    }
    if let Some(expected) = repository_id.filter(|value| !value.trim().is_empty()) {
        if repository_identity(&project_path)? != expected {
            return Err(
                "The owning project's configured checkout belongs to a different Git repository"
                    .to_string(),
            );
        }
    }
    Ok(())
}

/// The environment banner reads the gate verdict; it does not own a checklist.
pub(in crate::kanban) fn environment_health(
    connection: &Connection,
    card_id: &str,
) -> Result<CardEnvironmentHealth, String> {
    super::gate::environment_health(connection, card_id)
}

pub(in crate::kanban) fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub(in crate::kanban) fn db_error(error: rusqlite::Error) -> String {
    format!("Kanban database error: {error}")
}
