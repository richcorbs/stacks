use std::{
    fs,
    sync::{Mutex, OnceLock},
};
use tauri::Window;

use crate::fs_paths::app_data_file;
pub use crate::settings_model::{AppSettings, WindowState};

static SETTINGS_FILE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn settings_file_lock() -> &'static Mutex<()> {
    SETTINGS_FILE_LOCK.get_or_init(|| Mutex::new(()))
}

fn settings_path() -> Result<std::path::PathBuf, String> {
    app_data_file("settings.json")
}

fn read_settings_from_disk_unlocked() -> AppSettings {
    settings_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<AppSettings>(&text).ok())
        .unwrap_or_default()
}

fn write_settings_to_disk_unlocked(settings: &AppSettings) -> Result<(), String> {
    let path = settings_path()?;
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|e| e.to_string())
}

fn load_settings_from_disk() -> AppSettings {
    let _guard = settings_file_lock().lock().ok();
    read_settings_from_disk_unlocked()
}

fn update_settings_on_disk(update: impl FnOnce(&mut AppSettings)) -> Result<(), String> {
    let _guard = settings_file_lock()
        .lock()
        .map_err(|_| "Settings file lock poisoned".to_string())?;
    let mut settings = read_settings_from_disk_unlocked();
    update(&mut settings);
    write_settings_to_disk_unlocked(&settings)
}

#[tauri::command]
pub fn load_settings() -> AppSettings {
    load_settings_from_disk()
}

#[tauri::command]
pub fn persist_window_state(state: WindowState) -> Result<(), String> {
    update_settings_on_disk(|settings| {
        settings.window = Some(state.clamped());
    })
}

#[tauri::command]
pub fn save_window_state(state: WindowState) -> Result<(), String> {
    persist_window_state(state)
}

#[tauri::command]
pub fn save_current_window_state(window: Window) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    persist_window_state(WindowState::new(
        ((size.width as f64) / scale).round() as u32,
        ((size.height as f64) / scale).round() as u32,
        Some(((position.x as f64) / scale).round() as i32),
        Some(((position.y as f64) / scale).round() as i32),
    ))
}

#[tauri::command]
pub fn save_app_settings(next: AppSettings) -> Result<(), String> {
    update_settings_on_disk(|settings| settings.apply_user_settings(next))
}

pub fn reset_settings_file() -> Result<(), String> {
    update_settings_on_disk(|settings| {
        settings.window = None;
    })
}

#[tauri::command]
pub fn reset_settings() -> Result<(), String> {
    reset_settings_file()
}

pub(crate) fn migrate_superthread_project_configuration(
    connection: &mut rusqlite::Connection,
) -> Result<(), String> {
    let legacy = load_settings_from_disk();
    if !migrate_superthread_values(connection, &legacy)? {
        return Ok(());
    }
    update_settings_on_disk(|settings| {
        settings.superthread_spaces = None;
        settings.superthread_workspace_slug = None;
        settings.superthread_start_work_command = None;
    })
}

fn migrate_superthread_values(
    connection: &mut rusqlite::Connection,
    legacy: &AppSettings,
) -> Result<bool, String> {
    let already_applied = connection
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = 65",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Stacks database error: {error}"))?
        > 0;
    if already_applied {
        return Ok(true);
    }
    let owners = connection
        .prepare("SELECT id FROM projects WHERE kanban_source='superthread' ORDER BY id")
        .map_err(|error| format!("Stacks database error: {error}"))?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Stacks database error: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Stacks database error: {error}"))?;
    // Do not retire recoverable legacy values until there is an unambiguous recipient.
    let [owner_id] = owners.as_slice() else {
        return Ok(false);
    };
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Stacks database error: {error}"))?;
    transaction
        .execute(
            "UPDATE projects SET
           superthread_spaces=COALESCE(NULLIF(TRIM(superthread_spaces), ''), ?1),
           superthread_workspace_slug=COALESCE(NULLIF(TRIM(superthread_workspace_slug), ''), ?2),
           start_work_command=COALESCE(NULLIF(TRIM(start_work_command), ''), ?3)
         WHERE id=?4",
            rusqlite::params![
                legacy.superthread_spaces,
                legacy.superthread_workspace_slug,
                legacy.superthread_start_work_command,
                owner_id
            ],
        )
        .map_err(|error| format!("Stacks database error: {error}"))?;
    transaction
        .execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (65, unixepoch())",
            [],
        )
        .map_err(|error| format!("Stacks database error: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Stacks database error: {error}"))?;
    Ok(true)
}

pub fn load_window_state() -> Option<WindowState> {
    load_settings_from_disk().window
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn migrates_legacy_superthread_values_once_without_overwriting_project_values() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::kanban::migrate(&connection).unwrap();
        crate::store::migrate_store_schema(&connection).unwrap();
        connection.execute(
            "INSERT INTO projects(id, name, path, kanban_source, superthread_workspace_slug) VALUES ('owner','Owner','/tmp/owner','superthread','kept-slug')",
            [],
        ).unwrap();
        let mut legacy = AppSettings::default();
        legacy.superthread_spaces = Some("Product".into());
        legacy.superthread_workspace_slug = Some("legacy-slug".into());
        legacy.superthread_start_work_command = Some("stwork {card_number}".into());

        assert!(migrate_superthread_values(&mut connection, &legacy).unwrap());
        let migrated: (String, String, String) = connection.query_row(
            "SELECT superthread_spaces, superthread_workspace_slug, start_work_command FROM projects WHERE id='owner'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(
            migrated,
            (
                "Product".into(),
                "kept-slug".into(),
                "stwork {card_number}".into()
            )
        );

        legacy.superthread_spaces = Some("Should not overwrite".into());
        assert!(migrate_superthread_values(&mut connection, &legacy).unwrap());
        assert_eq!(
            connection
                .query_row(
                    "SELECT superthread_spaces FROM projects WHERE id='owner'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "Product"
        );
    }

    #[test]
    fn preserves_legacy_values_until_there_is_one_owner() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::kanban::migrate(&connection).unwrap();
        crate::store::migrate_store_schema(&connection).unwrap();
        assert!(!migrate_superthread_values(&mut connection, &AppSettings::default()).unwrap());
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM schema_migrations WHERE version=65",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
}
