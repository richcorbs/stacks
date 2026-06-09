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

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}
