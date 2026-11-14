//! Settings and persistence stubs for the GPUI app-shell spike.
//!
//! This is deliberately JSON, not Stacks' SQLite. The point is to prove the
//! shell can own settings and window/layout state without a web frontend, not
//! to design the final schema. Release/debug directories mirror Stacks'
//! `stacks/` vs `stacks-dev/` convention.

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use stacks_terminal::{split_tree::SplitNode, terminal_surface::TerminalStyle};

pub const DATA_DIR_ENV: &str = "STACKS_GPUI_DATA_DIR";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct ShellSettings {
    pub font_family: String,
    pub font_size: f32,
    pub line_height: f32,
    pub scrollback_bytes: usize,
    pub copy_on_select: bool,
    pub notifications: bool,
    /// Optional shell override. `None` uses `$SHELL` (login shell), like the
    /// shipped global terminal.
    pub shell: Option<String>,
    pub theme: String,
}

impl Default for ShellSettings {
    fn default() -> Self {
        Self {
            font_family: "Menlo".into(),
            font_size: 14.0,
            line_height: 18.0,
            scrollback_bytes: 2_000_000,
            copy_on_select: true,
            notifications: true,
            shell: None,
            theme: "stacks-dark".into(),
        }
    }
}

impl ShellSettings {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("settings.json");
        match fs::read_to_string(&path) {
            Ok(json) => serde_json::from_str(&json).unwrap_or_else(|error| {
                eprintln!("settings: ignoring {}: {error:#}", path.display());
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    /// Clamp values that come from a hand-edited JSON file so a bad settings
    /// file cannot make the window unusable.
    pub fn normalized(mut self) -> Self {
        self.font_size = self.font_size.clamp(8.0, 32.0);
        self.line_height = self.line_height.clamp(self.font_size, self.font_size * 2.5);
        self.scrollback_bytes = self.scrollback_bytes.clamp(10_000, 100_000_000);
        self
    }

    pub fn terminal_style(&self) -> TerminalStyle {
        TerminalStyle {
            font_family: self.font_family.clone().into(),
            font_size: self.font_size,
            line_height: self.line_height,
        }
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        write_json(&dir.join("settings.json"), self)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct ShellState {
    pub window: Option<PersistedWindow>,
    pub selected_tab: usize,
    pub tabs: Vec<PersistedTab>,
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            window: None,
            selected_tab: 0,
            tabs: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct PersistedWindow {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PersistedTab {
    pub layout: SplitNode,
    pub focused: String,
}

impl ShellState {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("shell-state.json");
        match fs::read_to_string(&path) {
            Ok(json) => serde_json::from_str(&json).unwrap_or_else(|error| {
                eprintln!("shell state: ignoring {}: {error:#}", path.display());
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        write_json(&dir.join("shell-state.json"), self)
    }
}

/// Stacks' data directory convention, with an env override for measurement
/// runs and tests. macOS-first, matching the rest of the spike.
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os(DATA_DIR_ENV) {
        return PathBuf::from(dir);
    }
    let app_dir = if cfg!(debug_assertions) {
        "stacks-gpui-dev"
    } else {
        "stacks-gpui"
    };
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    home.join("Library/Application Support").join(app_dir)
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create data dir {}", parent.display()))?;
    }
    let json = serde_json::to_vec_pretty(value).context("serialize state")?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("replace {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use stacks_terminal::split_tree::SplitDirection;

    #[test]
    fn settings_are_clamped() {
        let settings = ShellSettings {
            font_size: 1.0,
            line_height: 100.0,
            scrollback_bytes: 1,
            ..Default::default()
        }
        .normalized();
        assert_eq!(settings.font_size, 8.0);
        assert!(settings.line_height <= settings.font_size * 2.5);
        assert_eq!(settings.scrollback_bytes, 10_000);
    }

    #[test]
    fn state_round_trips_through_json() {
        let state = ShellState {
            window: Some(PersistedWindow {
                x: 10.0,
                y: 20.0,
                width: 900.0,
                height: 600.0,
            }),
            selected_tab: 1,
            tabs: vec![PersistedTab {
                layout: SplitNode::leaf("pane:a").split("pane:a", "pane:b", SplitDirection::Row),
                focused: "pane:b".into(),
            }],
        };
        let json = serde_json::to_string(&state).unwrap();
        let decoded: ShellState = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.tabs.len(), 1);
        assert_eq!(decoded.tabs[0].layout.leaves(), ["pane:a", "pane:b"]);
        assert_eq!(decoded.selected_tab, 1);
    }
}
