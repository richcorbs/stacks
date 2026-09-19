use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowState {
    width: u32,
    height: u32,
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub window: Option<WindowState>,
    #[serde(default)]
    pub ui_font_size: Option<u32>,
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
    // Read only for the one-time migration to project-owned configuration.
    #[serde(default, skip_serializing)]
    pub(crate) superthread_workspace_slug: Option<String>,
    #[serde(default, skip_serializing)]
    pub(crate) superthread_spaces: Option<String>,
    #[serde(default, skip_serializing)]
    pub(crate) superthread_start_work_command: Option<String>,
    #[serde(default)]
    pub superthread_enabled: Option<bool>,
    #[serde(default)]
    pub kanban_project_id: Option<String>,
    #[serde(default)]
    pub kanban_done_collapsed: Option<bool>,
    #[serde(default)]
    pub activity_notifications: Option<bool>,
}

impl AppSettings {
    pub fn apply_patch(&mut self, next: AppSettings, fields: &[String]) {
        for field in fields {
            match field.as_str() {
                "ui_font_size" => self.ui_font_size = next.ui_font_size.map(|value| value.clamp(10, 20)),
                "terminal_font_size" => self.terminal_font_size = next.terminal_font_size.map(|value| value.clamp(8, 32)),
                "terminal_font_family" => self.terminal_font_family = non_empty(next.terminal_font_family.clone()),
                "terminal_scrollback" => self.terminal_scrollback = next.terminal_scrollback.map(|value| value.clamp(100, 200_000)),
                "copy_on_select" => self.copy_on_select = next.copy_on_select,
                "confirm_close" => self.confirm_close = next.confirm_close,
                "confirm_delete" => self.confirm_delete = next.confirm_delete,
                "editor_app" => self.editor_app = non_empty(next.editor_app.clone()),
                "focused_terminal_border_color" => self.focused_terminal_border_color = non_empty(next.focused_terminal_border_color.clone()),
                "maximized_terminal_border_color" => self.maximized_terminal_border_color = non_empty(next.maximized_terminal_border_color.clone()),
                "superthread_enabled" => self.superthread_enabled = next.superthread_enabled,
                "kanban_project_id" => self.kanban_project_id = non_empty(next.kanban_project_id.clone()),
                "kanban_done_collapsed" => self.kanban_done_collapsed = next.kanban_done_collapsed,
                "activity_notifications" => self.activity_notifications = next.activity_notifications,
                _ => {}
            }
        }
    }

    pub fn apply_user_settings(&mut self, next: AppSettings) {
        self.ui_font_size = next.ui_font_size.map(|value| value.clamp(10, 20));
        self.terminal_font_size = next.terminal_font_size.map(|value| value.clamp(8, 32));
        self.terminal_font_family = non_empty(next.terminal_font_family);
        self.terminal_scrollback = next
            .terminal_scrollback
            .map(|value| value.clamp(100, 200_000));
        self.copy_on_select = next.copy_on_select;
        self.confirm_close = next.confirm_close;
        self.confirm_delete = next.confirm_delete;
        self.editor_app = non_empty(next.editor_app);
        self.focused_terminal_border_color = non_empty(next.focused_terminal_border_color);
        self.maximized_terminal_border_color = non_empty(next.maximized_terminal_border_color);
        self.superthread_enabled = next.superthread_enabled;
        self.kanban_project_id = non_empty(next.kanban_project_id);
        self.kanban_done_collapsed = next.kanban_done_collapsed;
        self.activity_notifications = next.activity_notifications;
    }
}

impl WindowState {
    pub fn new(width: u32, height: u32, x: Option<i32>, y: Option<i32>) -> Self {
        Self {
            width,
            height,
            x,
            y,
        }
    }

    pub fn clamped(&self) -> Self {
        Self {
            width: self.width.clamp(780, 10_000),
            height: self.height.clamp(500, 10_000),
            x: self.x,
            y: self.y,
        }
    }

    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn x(&self) -> Option<i32> {
        self.x
    }
    pub fn y(&self) -> Option<i32> {
        self.y
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_changes_only_named_settings_and_normalizes_values() {
        let mut current = AppSettings {
            ui_font_size: Some(14), terminal_font_size: Some(18),
            editor_app: Some("Zed".into()), confirm_close: Some(true),
            window: Some(WindowState::new(1200, 800, Some(10), Some(20))),
            ..Default::default()
        };
        let next = AppSettings {
            ui_font_size: Some(99), terminal_font_size: Some(8),
            editor_app: Some("Other".into()), confirm_close: Some(false),
            ..Default::default()
        };
        current.apply_patch(next, &["ui_font_size".into(), "confirm_close".into()]);

        assert_eq!(current.ui_font_size, Some(20));
        assert_eq!(current.confirm_close, Some(false));
        assert_eq!(current.terminal_font_size, Some(18));
        assert_eq!(current.editor_app.as_deref(), Some("Zed"));
        assert_eq!(current.window.as_ref().map(WindowState::width), Some(1200));
    }

    #[test]
    fn patch_can_clear_a_nullable_runtime_preference() {
        let mut current = AppSettings { kanban_project_id: Some("project".into()), ..Default::default() };
        current.apply_patch(AppSettings::default(), &["kanban_project_id".into()]);
        assert_eq!(current.kanban_project_id, None);
    }
}
