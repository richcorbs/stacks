use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// Decode this field independently: bad usage data must not discard unrelated settings.
fn deserialize_command_usage<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<BTreeMap<String, u64>>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    if value.is_null() {
        return Ok(None);
    }
    let counts = value.as_object().map(|object| {
        object.iter().map(|(id, value)| {
            let count = value.as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .map(|n| n.floor().min(9_007_199_254_740_991.0) as u64)
                .unwrap_or(0);
            (id.clone(), count)
        }).collect()
    }).unwrap_or_default();
    Ok(Some(counts))
}

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
    #[serde(default, deserialize_with = "deserialize_command_usage")]
    pub command_usage_counts: Option<BTreeMap<String, u64>>,
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
    pub kanban_backlog_collapsed: Option<bool>,
    #[serde(default)]
    pub kanban_attention_collapsed: Option<bool>,
    #[serde(default)]
    pub kanban_progress_collapsed: Option<bool>,
    #[serde(default)]
    pub kanban_view: Option<String>,
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
                "kanban_backlog_collapsed" => self.kanban_backlog_collapsed = next.kanban_backlog_collapsed,
                "kanban_attention_collapsed" => self.kanban_attention_collapsed = next.kanban_attention_collapsed,
                "kanban_progress_collapsed" => self.kanban_progress_collapsed = next.kanban_progress_collapsed,
                "kanban_view" => self.kanban_view = valid_kanban_view(next.kanban_view.clone()),
                "activity_notifications" => self.activity_notifications = next.activity_notifications,
                "command_usage_counts" => self.command_usage_counts = next.command_usage_counts.clone(),
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
        self.kanban_backlog_collapsed = next.kanban_backlog_collapsed;
        self.kanban_attention_collapsed = next.kanban_attention_collapsed;
        self.kanban_progress_collapsed = next.kanban_progress_collapsed;
        self.kanban_view = valid_kanban_view(next.kanban_view);
        self.activity_notifications = next.activity_notifications;
        self.command_usage_counts = next.command_usage_counts;
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

fn valid_kanban_view(value: Option<String>) -> Option<String> {
    value.filter(|value| matches!(value.as_str(), "list" | "board"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_usage_normalizes_without_discarding_settings_or_reseeding() {
        let missing: AppSettings = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(missing.command_usage_counts, None);
        for json in [r#"{}"#, r#"[]"#, r#""bad""#] {
            let settings: AppSettings = serde_json::from_str(&format!(r#"{{"editor_app":"custom","command_usage_counts":{json}}}"#)).unwrap();
            assert_eq!(settings.editor_app.as_deref(), Some("custom"));
            assert_eq!(settings.command_usage_counts, Some(BTreeMap::new()));
        }
        let mut current: AppSettings = serde_json::from_str(r#"{"editor_app":"custom","command_usage_counts":{"unavailable":9,"negative":-1,"fraction":2.9,"text":"4","null":null,"huge":1e30}}"#).unwrap();
        let counts = current.command_usage_counts.as_ref().unwrap();
        assert_eq!(counts["negative"], 0);
        assert_eq!(counts["fraction"], 2);
        assert_eq!(counts["text"], 0);
        assert_eq!(counts["null"], 0);
        assert_eq!(counts["huge"], 9_007_199_254_740_991);
        let restored: AppSettings = serde_json::from_str(&serde_json::to_string(&current).unwrap()).unwrap();
        assert_eq!(restored.command_usage_counts, current.command_usage_counts);
        current.apply_patch(AppSettings { ui_font_size: Some(14), ..Default::default() }, &["ui_font_size".into()]);
        assert_eq!(current.command_usage_counts.as_ref().unwrap()["unavailable"], 9);
        current.apply_patch(AppSettings { command_usage_counts: Some(BTreeMap::new()), ..Default::default() }, &["command_usage_counts".into()]);
        assert_eq!(current.command_usage_counts, Some(BTreeMap::new()));
        assert_eq!(current.editor_app.as_deref(), Some("custom"));
        current.apply_user_settings(restored);
        assert_eq!(current.command_usage_counts.as_ref().unwrap()["unavailable"], 9);
    }

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
    fn kanban_view_only_accepts_known_presentations() {
        let mut settings = AppSettings::default();
        settings.apply_patch(AppSettings { kanban_view: Some("unknown".into()), ..Default::default() }, &["kanban_view".into()]);
        assert_eq!(settings.kanban_view, None);
        settings.apply_patch(AppSettings { kanban_view: Some("board".into()), ..Default::default() }, &["kanban_view".into()]);
        assert_eq!(settings.kanban_view.as_deref(), Some("board"));
    }

    #[test]
    fn backlog_and_done_settings_patch_and_serialize_independently() {
        let mut current = AppSettings { kanban_backlog_collapsed: Some(true), kanban_done_collapsed: Some(true), ..Default::default() };
        current.apply_patch(AppSettings { kanban_backlog_collapsed: Some(false), ..Default::default() }, &["kanban_backlog_collapsed".into()]);
        assert_eq!(current.kanban_backlog_collapsed, Some(false));
        assert_eq!(current.kanban_done_collapsed, Some(true));
        let stored = serde_json::to_string(&current).unwrap();
        let restored: AppSettings = serde_json::from_str(&stored).unwrap();
        assert_eq!(restored.kanban_backlog_collapsed, Some(false));
        assert_eq!(restored.kanban_done_collapsed, Some(true));
        current.apply_user_settings(AppSettings { kanban_backlog_collapsed: Some(true), kanban_done_collapsed: Some(false), ..Default::default() });
        assert_eq!(current.kanban_backlog_collapsed, Some(true));
        assert_eq!(current.kanban_done_collapsed, Some(false));
    }

    #[test]
    fn attention_and_progress_patch_and_serialize_independently() {
        let mut current = AppSettings::default();
        current.apply_patch(AppSettings { kanban_attention_collapsed: Some(true), ..Default::default() }, &["kanban_attention_collapsed".into()]);
        assert_eq!(current.kanban_attention_collapsed, Some(true));
        assert_eq!(current.kanban_progress_collapsed, None);
        current.apply_patch(AppSettings { kanban_progress_collapsed: Some(false), ..Default::default() }, &["kanban_progress_collapsed".into()]);
        let restored: AppSettings = serde_json::from_str(&serde_json::to_string(&current).unwrap()).unwrap();
        assert_eq!(restored.kanban_attention_collapsed, Some(true));
        assert_eq!(restored.kanban_progress_collapsed, Some(false));
        current.apply_user_settings(AppSettings { kanban_attention_collapsed: Some(false), kanban_progress_collapsed: Some(true), ..Default::default() });
        assert_eq!(current.kanban_attention_collapsed, Some(false));
        assert_eq!(current.kanban_progress_collapsed, Some(true));
    }

    #[test]
    fn patch_can_clear_a_nullable_runtime_preference() {
        let mut current = AppSettings { kanban_project_id: Some("project".into()), ..Default::default() };
        current.apply_patch(AppSettings::default(), &["kanban_project_id".into()]);
        assert_eq!(current.kanban_project_id, None);
    }
}
