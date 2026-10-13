use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

pub const PRODUCTION_APP_DATA_DIR_NAME: &str = "stacks";
pub const DEVELOPMENT_APP_DATA_DIR_NAME: &str = "stacks-dev";
const AUTOMATION_SOCKET_NAME: &str = "automation.sock";
const VERIFIED_DATA_LOCATION_MARKER: &str = ".data-location-verified";

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
        dirs::data_dir().ok_or_else(|| "Could not locate user data directory".to_string())?;
    Ok(app_data_dir_in(&base, profile))
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
    // Once the new database has initialized successfully, it owns this profile. Its files
    // may legitimately diverge from the retained rollback copy on subsequent launches.
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
        // An empty leftover WAL has no pending database changes to copy.
        if name == "workflow.sqlite3-wal" && source.len() == 0 {
            continue;
        }
        let new = current.join(name);
        let copied = new.metadata().map_err(|_| format!(
            "Stacks data migration is incomplete: {} is missing. Quit the old app and copy the entire Application Support/stacks-tauri directory to Application Support/stacks before starting this version.", new.display()
        ))?;
        // Finder copies can round modification times down to whole seconds. A difference
        // smaller than one second does not mean the legacy data changed after copying.
        let source_modified = source.modified().map_err(|error| error.to_string())?;
        let copied_modified = copied.modified().map_err(|error| error.to_string())?;
        if source.len() != copied.len() || legacy_is_newer(source_modified, copied_modified) {
            return Err(format!("Stacks data in {} changed after the copy. Quit the old app and update the copy in {} before starting this version.", legacy.display(), current.display()));
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

pub fn app_data_dir() -> Result<PathBuf, String> {
    let dir = app_data_dir_for(current_app_profile())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn app_data_file(name: &str) -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join(name))
}

pub fn automation_socket_path_for(profile: AppProfile) -> Result<PathBuf, String> {
    Ok(app_data_dir_for(profile)?.join(AUTOMATION_SOCKET_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_and_development_resources_have_distinct_namespaces() {
        let base = Path::new("/application-support");
        let production = app_data_dir_in(base, AppProfile::Production);
        let development = app_data_dir_in(base, AppProfile::Development);
        assert_eq!(production, base.join("stacks"));
        assert_eq!(development, base.join("stacks-dev"));
        assert_ne!(
            production.join(AUTOMATION_SOCKET_NAME),
            development.join(AUTOMATION_SOCKET_NAME)
        );
    }

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
        assert!(verify_production_data_copy_in(&base)
            .unwrap_err()
            .contains("migration is incomplete"));
        fs::create_dir_all(&current).unwrap();
        fs::copy(
            legacy.join("workflow.sqlite3"),
            current.join("workflow.sqlite3"),
        )
        .unwrap();
        assert!(verify_production_data_copy_in(&base).is_ok());
        // After a successful startup, changes made by the new app are not stale copies.
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
            assert!(verify_production_data_copy_in(&base)
                .unwrap_err()
                .contains("still running"));
            drop(listener);
        }
        fs::remove_dir_all(base).unwrap();
    }
}
