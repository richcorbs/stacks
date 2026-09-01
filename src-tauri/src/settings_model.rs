use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowState {
    width: u32,
    height: u32,
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomCmdPCommand {
    pub id: String,
    pub label: String,
    pub command: String,
    pub direction: String,
    #[serde(default = "default_true")]
    pub execute: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub window: Option<WindowState>,
    #[serde(default)]
    pub sidebar_width: Option<u32>,
    #[serde(default)]
    pub terminal_font_size: Option<u32>,
    #[serde(default)]
    pub terminal_font_family: Option<String>,
    #[serde(default)]
    pub terminal_scrollback: Option<u32>,
    #[serde(default)]
    pub copy_on_select: Option<bool>,
    #[serde(default)]
    pub confirm_close: Option<bool>,
    #[serde(default)]
    pub confirm_delete: Option<bool>,
    #[serde(default)]
    pub editor_app: Option<String>,
    #[serde(default)]
    pub focused_terminal_border_color: Option<String>,
    #[serde(default)]
    pub maximized_terminal_border_color: Option<String>,
    #[serde(default)]
    pub alive_dot_color: Option<String>,
    #[serde(default)]
    pub active_dot_color: Option<String>,
    #[serde(default)]
    pub unseen_dot_color: Option<String>,
    #[serde(default)]
    pub custom_cmd_p_commands: Option<Vec<CustomCmdPCommand>>,
    #[serde(default)]
    pub superthread_workspace_slug: Option<String>,
    #[serde(default)]
    pub superthread_spaces: Option<String>,
    #[serde(default)]
    pub superthread_start_work_command: Option<String>,
    #[serde(default)]
    pub superthread_workspace_name_template: Option<String>,
    #[serde(default)]
    pub superthread_enabled: Option<bool>,
    #[serde(default)]
    pub github_poll_interval_seconds: Option<u32>,
    #[serde(default)]
    pub github_merge_strategy: Option<String>,
    #[serde(default)]
    pub active_project_id: Option<String>,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
    #[serde(default)]
    pub focused_terminal_by_workspace_id: Option<HashMap<String, String>>,
    #[serde(default)]
    pub maximized_workspace_ids: Option<HashMap<String, bool>>,
}

impl AppSettings {
    pub fn apply_user_settings(&mut self, next: AppSettings) {
        self.terminal_font_size = next.terminal_font_size.map(|value| value.clamp(8, 32));
        self.terminal_font_family = non_empty(next.terminal_font_family);
        self.terminal_scrollback = next.terminal_scrollback.map(|value| value.clamp(100, 200_000));
        self.copy_on_select = next.copy_on_select;
        self.confirm_close = next.confirm_close;
        self.confirm_delete = next.confirm_delete;
        self.editor_app = non_empty(next.editor_app);
        self.focused_terminal_border_color = non_empty(next.focused_terminal_border_color);
        self.maximized_terminal_border_color = non_empty(next.maximized_terminal_border_color);
        self.alive_dot_color = non_empty(next.alive_dot_color);
        self.active_dot_color = non_empty(next.active_dot_color);
        self.unseen_dot_color = non_empty(next.unseen_dot_color);
        self.superthread_workspace_slug = non_empty(next.superthread_workspace_slug);
        self.superthread_spaces = non_empty(next.superthread_spaces);
        self.superthread_start_work_command = non_empty(next.superthread_start_work_command);
        self.superthread_workspace_name_template = non_empty(next.superthread_workspace_name_template);
        self.superthread_enabled = next.superthread_enabled;
        self.github_poll_interval_seconds = next.github_poll_interval_seconds.map(|value| value.clamp(10, 3600));
        self.github_merge_strategy = next.github_merge_strategy.filter(|value| matches!(value.as_str(), "merge" | "squash" | "rebase"));
        self.custom_cmd_p_commands = next.custom_cmd_p_commands.map(|commands| {
            commands.into_iter().filter(|item| {
                !item.id.trim().is_empty()
                    && !item.label.trim().is_empty()
                    && !item.command.trim().is_empty()
                    && matches!(item.direction.as_str(), "row" | "column")
            }).collect()
        });
    }
}

impl WindowState {
    pub fn new(width: u32, height: u32, x: Option<i32>, y: Option<i32>) -> Self {
        Self { width, height, x, y }
    }

    pub fn clamped(&self) -> Self {
        Self {
            width: self.width.clamp(780, 10_000),
            height: self.height.clamp(500, 10_000),
            x: self.x,
            y: self.y,
        }
    }

    pub fn width(&self) -> u32 { self.width }
    pub fn height(&self) -> u32 { self.height }
    pub fn x(&self) -> Option<i32> { self.x }
    pub fn y(&self) -> Option<i32> { self.y }
}

fn default_true() -> bool { true }

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}
