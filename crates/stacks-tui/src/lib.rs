//! Keyboard-only terminal client for Stacks.

pub mod app;
pub mod core_bridge;
pub mod event;
pub mod headless;
pub mod keys;
pub mod render;
pub mod screens;
pub mod split_tree;
pub mod theme;
pub mod widgets;

use stacks_core::paths;

/// `~/Library/Application Support/stacks/settings.json` shortened for display.
pub fn short_path() -> String {
    let path = paths::settings_path().unwrap_or_else(|_| "settings.json".into());
    let home = dirs::home_dir().unwrap_or_default();
    match path.strip_prefix(&home) {
        Ok(relative) => format!("~/{}", relative.display()),
        Err(_) => path.display().to_string(),
    }
}
