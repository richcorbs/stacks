//! Help: the keymap table rendered directly from `keys::KEYMAP`.

use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
};

use crate::{app::App, keys::KEYMAP};

pub fn render(frame: &mut Frame, app: &App, area: Rect) {
    let theme = app.theme;
    let mut lines = Vec::new();
    for group in KEYMAP {
        lines.push(Line::from(Span::styled(
            group.group.to_uppercase(),
            Style::default()
                .fg(theme.accent)
                .add_modifier(Modifier::BOLD),
        )));
        for (key, description) in group.entries {
            lines.push(Line::from(vec![
                Span::styled(format!("  {:<18}", key), Style::default().fg(theme.text)),
                Span::styled(*description, Style::default().fg(theme.muted)),
            ]));
        }
        lines.push(Line::from(""));
    }
    let total = lines.len() as u16;
    let offset = app.help_scroll.min(total.saturating_sub(area.height));
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().bg(theme.canvas))
            .scroll((offset, 0)),
        area,
    );
}
