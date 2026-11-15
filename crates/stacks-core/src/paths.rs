//! Stacks data locations.
//!
//! Mirrors `src-tauri/src/fs_paths.rs` so a native peer opens exactly the same
//! `workflow.sqlite3` and `settings.json` the GUI uses.

use std::{
    fs,
    path::{Path, PathBuf},
};

pub const PRODUCTION_APP_DATA_DIR_NAME: &str = "stacks";
pub const DEVELOPMENT_APP_DATA_DIR_NAME: &str = "stacks-dev";
pub const AUTOMATION_SOCKET_NAME: &str = "automation.sock";
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

/// The shipped data directory. Native clients default to production data so
/// they observe the real workflow; use `STACKS_TUI_DATA_DIR` or `--db` in
/// tests and development.
pub fn app_data_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("STACKS_TUI_DATA_DIR") {
        let path = PathBuf::from(path);
        fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        return Ok(path);
    }
    let dir = app_data_dir_for(AppProfile::Production)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

pub fn app_data_file(name: &str) -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join(name))
}

pub fn database_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("STACKS_TUI_DB") {
        return Ok(PathBuf::from(path));
    }
    app_data_file(DATABASE_FILE)
}

pub fn settings_path() -> Result<PathBuf, String> {
    app_data_file(SETTINGS_FILE)
}

pub fn automation_socket_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join(AUTOMATION_SOCKET_NAME))
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
    Ok(app_data_dir()?.join("cards").join(safe))
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
