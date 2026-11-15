//! Tab bar with numeric hints. Numbers are part of the keymap, not decoration.

use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
};

use crate::theme::Theme;

pub struct Tab<'a> {
    pub number: usize,
    pub label: &'a str,
    pub enabled: bool,
}

pub fn render(frame: &mut Frame, area: Rect, theme: Theme, tabs: &[Tab<'_>], active: usize) -> u16 {
    let mut spans = Vec::new();
    for (index, tab) in tabs.iter().enumerate() {
        if index > 0 {
            spans.push(Span::styled("   ", Style::default().fg(theme.dim)));
        }
        let selected = index == active;
        let style = if !tab.enabled {
            Style::default().fg(theme.dim)
        } else if selected {
            Style::default()
                .fg(theme.canvas)
                .bg(theme.accent)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme.muted)
        };
        spans.push(Span::styled(
            format!(" {} {} ", tab.number, tab.label),
            style,
        ));
    }
    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(theme.panel)),
        area,
    );
    area.height
}
