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
            "Terminal scrollback",
            format!("{} lines", app.preferences.terminal_scrollback),
            "applies to new panes; shared with the GUI",
        ),
        (
            "Confirm quitting",
            if app.preferences.confirm_close {
                "on"
            } else {
                "off"
            }
            .to_string(),
            "off quits immediately; shared with the GUI",
        ),
        (
            "Confirm delete",
            if app.preferences.confirm_delete {
                "on"
            } else {
                "off"
            }
            .to_string(),
            "shared with the GUI",
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
            "Terminal font size",
            app.preferences
                .terminal_font_size
                .map(|size| size.to_string())
                .unwrap_or_else(|| "default".into()),
            "informational in the TUI; the terminal owns the font",
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
        format!("File: {}", crate::short_path()),
        Style::default().fg(theme.dim),
    )));
    lines.push(Line::from(Span::styled(
        "j/k field · h/l change · Esc save & close",
        Style::default().fg(theme.dim),
    )));
    frame.render_widget(
        Paragraph::new(lines).style(Style::default().bg(theme.canvas)),
        area,
    );
}
