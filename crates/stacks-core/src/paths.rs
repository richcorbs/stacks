//! Stacks data locations.
//!
//! Mirrors `src-tauri/src/fs_paths.rs` so a native peer opens exactly the same
//! `workflow.sqlite3` and `settings.json` the GUI uses.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

pub const PRODUCTION_APP_DATA_DIR_NAME: &str = "stacks";
pub const DEVELOPMENT_APP_DATA_DIR_NAME: &str = "stacks-dev";
pub const AUTOMATION_SOCKET_NAME: &str = "automation.sock";
pub const VERIFIED_DATA_LOCATION_MARKER: &str = ".data-location-verified";
pub const DATABASE_FILE: &str = "workflow.sqlite3";
pub const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppProfile {
    Production,
    Development,
}

pub const fn current_app_profile() -> AppProfile {
    if cfg!(debug_assertions) {
        AppProfile::Development
    } else {
        AppProfile::Production
    }
}

pub const fn app_data_dir_name(profile: AppProfile) -> &'static str {
    match profile {
        AppProfile::Production => PRODUCTION_APP_DATA_DIR_NAME,
        AppProfile::Development => DEVELOPMENT_APP_DATA_DIR_NAME,
    }
}

pub fn app_data_dir_in(base: &Path, profile: AppProfile) -> PathBuf {
    base.join(app_data_dir_name(profile))
}

pub fn app_data_dir_for(profile: AppProfile) -> Result<PathBuf, String> {
    let base =
        dirs::data_dir().ok_or_else(|| "Could not locate the user data directory".to_string())?;
    Ok(app_data_dir_in(&base, profile))
}

pub fn app_data_dir() -> Result<PathBuf, String> {
    let dir = app_data_dir_for(current_app_profile())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

pub fn app_data_file(name: &str) -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join(name))
}

/// Product data used by both hosts. Native TUI clients always observe the
/// shipped production data, with an explicit escape hatch for tests/demos.
pub fn product_data_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("STACKS_TUI_DATA_DIR") {
        let path = PathBuf::from(path);
        fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        return Ok(path);
    }
    let dir = app_data_dir_for(AppProfile::Production)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

pub fn automation_socket_path_for(profile: AppProfile) -> Result<PathBuf, String> {
    Ok(app_data_dir_for(profile)?.join(AUTOMATION_SOCKET_NAME))
}

// Refuse to create an empty production profile over an unmigrated existing one.
// The actual copy must happen while the old application is closed (SQLite uses WAL).
pub fn verify_production_data_copy() -> Result<(), String> {
    if current_app_profile() != AppProfile::Production {
        return Ok(());
    }
    let base =
        dirs::data_dir().ok_or_else(|| "Could not locate user data directory".to_string())?;
    verify_production_data_copy_in(&base)
}

fn verify_production_data_copy_in(base: &Path) -> Result<(), String> {
    let legacy = base.join("stacks-tauri");
    let current = app_data_dir_in(base, AppProfile::Production);
    if !legacy.join("workflow.sqlite3").exists() {
        return Ok(());
    }
    #[cfg(unix)]
    if std::os::unix::net::UnixStream::connect(legacy.join(AUTOMATION_SOCKET_NAME)).is_ok() {
        return Err("The old Stacks app is still running against Application Support/stacks-tauri. Quit it and update the copy in Application Support/stacks before starting this version.".into());
    }
    if current.join(VERIFIED_DATA_LOCATION_MARKER).is_file() {
        return Ok(());
    }
    for name in [
        "workflow.sqlite3",
        "workflow.sqlite3-wal",
        "settings.json",
        "projects.json",
        "pi-trusted-projects.json",
        "pi-sessions",
        "cards",
        "releases",
        "setup-results",
    ] {
        let old = legacy.join(name);
        if !old.exists() {
            continue;
        }
        let source = old.metadata().map_err(|error| error.to_string())?;
        if name == "workflow.sqlite3-wal" && source.len() == 0 {
            continue;
        }
        let new = current.join(name);
        let copied = new.metadata().map_err(|_| format!(
            "Stacks data migration is incomplete: {} is missing. Quit the old app and copy the entire Application Support/stacks-tauri directory to Application Support/stacks before starting this version.", new.display()
        ))?;
        let source_modified = source.modified().map_err(|error| error.to_string())?;
        let copied_modified = copied.modified().map_err(|error| error.to_string())?;
        if source.len() != copied.len() || legacy_is_newer(source_modified, copied_modified) {
            return Err(format!(
                "Stacks data in {} changed after the copy. Quit the old app and update the copy in {} before starting this version.",
                legacy.display(),
                current.display()
            ));
        }
    }
    Ok(())
}

pub fn mark_production_data_copy_verified() -> Result<(), String> {
    if current_app_profile() == AppProfile::Production {
        fs::write(
            app_data_dir()?.join(VERIFIED_DATA_LOCATION_MARKER),
            b"verified\n",
        )
        .map_err(|error| format!("Could not record Stacks data migration: {error}"))?;
    }
    Ok(())
}

fn legacy_is_newer(source: SystemTime, copied: SystemTime) -> bool {
    source
        .duration_since(copied)
        .is_ok_and(|difference| difference >= Duration::from_secs(1))
}

pub fn database_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("STACKS_TUI_DB") {
        return Ok(PathBuf::from(path));
    }
    Ok(product_data_dir()?.join(DATABASE_FILE))
}

pub fn settings_path() -> Result<PathBuf, String> {
    Ok(product_data_dir()?.join(SETTINGS_FILE))
}

pub fn automation_socket_path() -> Result<PathBuf, String> {
    Ok(product_data_dir()?.join(AUTOMATION_SOCKET_NAME))
}

/// Per-card scratch space (setup results, sessions). Matches the GUI layout.
pub fn card_directory(card_id: &str) -> Result<PathBuf, String> {
    let safe: String = card_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    Ok(product_data_dir()?.join("cards").join(safe))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_have_distinct_namespaces() {
        let base = Path::new("/application-support");
        assert_ne!(
            app_data_dir_in(base, AppProfile::Production),
            app_data_dir_in(base, AppProfile::Development)
        );
    }

    #[test]
    fn card_directories_reject_path_separators() {
        assert!(
            card_directory("local:../escape")
                .unwrap()
                .ends_with("cards/local____escape")
        );
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    #[test]
    fn finder_timestamp_rounding_does_not_invalidate_a_copy() {
        let copied = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
        assert!(!legacy_is_newer(
            copied + Duration::from_millis(999),
            copied
        ));
        assert!(legacy_is_newer(copied + Duration::from_secs(1), copied));
    }

    #[test]
    fn existing_production_data_must_be_copied_before_starting_at_new_path() {
        // Keep the Unix socket path below macOS's SUN_LEN limit.
        let base = Path::new("/tmp").join(format!("s-{}", uuid::Uuid::new_v4()));
        let legacy = base.join("stacks-tauri");
        let current = base.join("stacks");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("workflow.sqlite3"), b"database fixture").unwrap();
        assert!(
            verify_production_data_copy_in(&base)
                .unwrap_err()
                .contains("migration is incomplete")
        );
        fs::create_dir_all(&current).unwrap();
        fs::copy(
            legacy.join("workflow.sqlite3"),
            current.join("workflow.sqlite3"),
        )
        .unwrap();
        assert!(verify_production_data_copy_in(&base).is_ok());
        fs::write(current.join(VERIFIED_DATA_LOCATION_MARKER), b"verified\n").unwrap();
        fs::write(
            current.join("workflow.sqlite3"),
            b"database fixture plus new writes",
        )
        .unwrap();
        assert!(verify_production_data_copy_in(&base).is_ok());
        #[cfg(unix)]
        {
            let listener =
                std::os::unix::net::UnixListener::bind(legacy.join(AUTOMATION_SOCKET_NAME))
                    .unwrap();
            assert!(
                verify_production_data_copy_in(&base)
                    .unwrap_err()
                    .contains("still running")
            );
            drop(listener);
        }
        fs::remove_dir_all(base).unwrap();
    }
}
