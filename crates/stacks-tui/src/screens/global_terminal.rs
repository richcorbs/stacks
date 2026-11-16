//! Full-screen global terminal overlay with tabs.

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
};

use crate::app::App;

pub fn render(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let tabs_height = if app.global_tabs.is_empty() { 0 } else { 1 };
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(tabs_height),
            Constraint::Min(4),
            Constraint::Length(1),
        ])
        .split(area);
    if tabs_height == 1 {
        let mut spans = Vec::new();
        for (index, tab) in app.global_tabs.iter().enumerate() {
            let active = index == app.global_active;
            spans.push(Span::styled(
                format!(" {} {} ", index + 1, tab.title),
                if active {
                    Style::default()
                        .fg(theme.canvas)
                        .bg(theme.accent)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(theme.muted).bg(theme.panel)
                },
            ));
            spans.push(Span::raw(" "));
        }
        frame.render_widget(Paragraph::new(Line::from(spans)), chunks[0]);
    }
    let active = app
        .global_active
        .min(app.global_tabs.len().saturating_sub(1));
    if let Some(tab) = app.global_tabs.get_mut(active) {
        tab.workspace.resize(chunks[1].width, chunks[1].height);
        tab.workspace
            .render(frame, chunks[1], app.global_terminal_focus, app.depth);
    } else {
        frame.render_widget(
            Paragraph::new("No global terminal tab. Press n.")
                .style(Style::default().fg(theme.muted)),
            chunks[1],
        );
    }
    let hint = if app.global_terminal_focus {
        " Ctrl-G close · Ctrl-\\ release · Ctrl-W [ copy "
    } else {
        " Tab bar · n new tab · x close tab · Tab next · i focus · Esc close "
    };
    frame.render_widget(
        Paragraph::new(Span::styled(
            hint,
            Style::default()
                .fg(if app.global_terminal_focus {
                    theme.canvas
                } else {
                    theme.canvas
                })
                .bg(if app.global_terminal_focus {
                    theme.panel
                } else {
                    theme.warning
                }),
        ))
        .block(
            Block::default()
                .borders(Borders::TOP)
                .border_style(Style::default().fg(theme.panel)),
        ),
        chunks[2],
    );
}
