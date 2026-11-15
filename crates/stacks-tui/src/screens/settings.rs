//! Settings: a small write-through subset of `settings.json`.

use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
};

use crate::app::App;

pub fn render(frame: &mut Frame, app: &App, area: Rect) {
    let theme = app.theme;
    let rows = [
        (
            "Confirmation delay",
            format!("{} ms", app.preferences.confirmation_delay_ms),
            "destructive actions stay disabled until this elapses",
        ),
        (
            "Copy on select",
            if app.preferences.copy_on_select {
                "on"
            } else {
                "off"
            }
            .to_string(),
            "shared with the GUI",
        ),
        (
            "Terminal font size",
            app.preferences
                .terminal_font_size
                .map(|size| size.to_string())
                .unwrap_or_else(|| "default".into()),
            "informational in the TUI; the terminal owns the font",
        ),
        (
            "Theme accent",
            app.preferences
                .accent
                .clone()
                .unwrap_or_else(|| "project default".into()),
            "project colours still come from Stacks",
        ),
        (
            "Hide Done by default",
            if app.preferences.hide_done {
                "on"
            } else {
                "off"
            }
            .to_string(),
            "same intent as Ctrl-A",
        ),
        (
            "Settings file",
            crate::short_path(),
            "each change is written immediately",
        ),
    ];
    let mut lines = Vec::new();
    for (index, (label, value, note)) in rows.iter().enumerate() {
        let selected = index == app.settings_cursor;
        lines.push(Line::from(vec![
            Span::styled(
                if selected { "▶ " } else { "  " },
                Style::default().fg(theme.accent),
            ),
            Span::styled(
                format!("{label:<22}"),
                Style::default()
                    .fg(if selected { theme.text } else { theme.muted })
                    .add_modifier(if selected {
                        Modifier::BOLD
                    } else {
                        Modifier::empty()
                    }),
            ),
            Span::styled(value.clone(), Style::default().fg(theme.info)),
        ]));
        lines.push(Line::from(Span::styled(
            format!("    {note}"),
            Style::default().fg(theme.dim),
        )));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "j/k field · h/l change · Esc save & close",
        Style::default().fg(theme.dim),
    )));
    frame.render_widget(
        Paragraph::new(lines).style(Style::default().bg(theme.canvas)),
        area,
    );
}
