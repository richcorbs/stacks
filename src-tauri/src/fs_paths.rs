use std::{
    fs,
    path::{Path, PathBuf},
};

pub const PRODUCTION_APP_DATA_DIR_NAME: &str = "stacks-tauri";
pub const DEVELOPMENT_APP_DATA_DIR_NAME: &str = "stacks-tauri-dev";
const AUTOMATION_SOCKET_NAME: &str = "automation.sock";

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
        assert_eq!(production, base.join("stacks-tauri"));
        assert_eq!(development, base.join("stacks-tauri-dev"));
        assert_ne!(
            production.join(AUTOMATION_SOCKET_NAME),
            development.join(AUTOMATION_SOCKET_NAME)
        );
    }
}
