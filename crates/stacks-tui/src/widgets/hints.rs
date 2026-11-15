//! Footer key hints and the status line.

use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
};

use crate::theme::Theme;

pub fn hint_line(theme: Theme, hints: &[(&str, &str)]) -> Line<'static> {
    let mut spans = Vec::new();
    for (index, (key, description)) in hints.iter().enumerate() {
        if index > 0 {
            spans.push(Span::styled("  ·  ", Style::default().fg(theme.dim)));
        }
        spans.push(Span::styled(
            (*key).to_string(),
            Style::default()
                .fg(theme.accent)
                .add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(
            format!(" {description}"),
            Style::default().fg(theme.muted),
        ));
    }
    Line::from(spans)
}

pub fn render_hints(frame: &mut Frame, area: Rect, theme: Theme, hints: &[(&str, &str)]) {
    frame.render_widget(
        Paragraph::new(hint_line(theme, hints)).style(Style::default().bg(theme.panel)),
        area,
    );
}

pub struct StatusLine<'a> {
    pub message: &'a str,
    pub error: Option<&'a str>,
    pub busy: bool,
    pub position: Option<&'a str>,
}

pub fn render_status(frame: &mut Frame, area: Rect, theme: Theme, status: &StatusLine<'_>) {
    let mut spans = Vec::new();
    if status.busy {
        spans.push(Span::styled(
            "● working  ",
            Style::default().fg(theme.warning),
        ));
    }
    if let Some(error) = status.error {
        spans.push(Span::styled(
            format!("◆ {error}"),
            Style::default().fg(theme.danger),
        ));
    } else {
        spans.push(Span::styled(
            status.message.to_string(),
            Style::default().fg(theme.muted),
        ));
    }
    if let Some(position) = status.position {
        spans.push(Span::styled(
            format!("  {position}"),
            Style::default().fg(theme.dim),
        ));
    }
    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(theme.panel)),
        area,
    );
}
