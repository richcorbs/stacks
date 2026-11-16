//! Native Pi Agent pane (Pi's own TUI in a managed PTY).

use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
};

use crate::app::{App, DetailTab};

pub fn render(frame: &mut Frame, app: &mut App, area: Rect, _tab: DetailTab) {
    let theme = app.theme;
    let focused = app.terminal_focus;
    let depth = app.depth;
    let workspace = &mut app.work;
    if workspace.is_empty() {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    "Pi is not running for this thread.",
                    Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "Persistent sessions are started with `pi --continue` in the card's worktree.",
                    Style::default().fg(theme.muted),
                )),
                Line::from(Span::styled(
                    "Press r to start, or check PI_PATH / the Pi CLI.",
                    Style::default().fg(theme.dim),
                )),
            ])
            .style(Style::default().bg(theme.canvas)),
            area,
        );
        return;
    }
    workspace.resize(area.width, area.height);
    workspace.render(frame, area, focused, depth);
}
