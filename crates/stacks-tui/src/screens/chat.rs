//! Native Pi Chat/Work panes (Pi's own TUI in a managed PTY).

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
};

use crate::{
    app::{App, DetailTab},
    theme::Theme,
};

pub fn render(frame: &mut Frame, app: &mut App, area: Rect, tab: DetailTab) {
    let theme = app.theme;
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(3)])
        .split(area);
    let mode = if app.terminal_focus {
        "INPUT"
    } else {
        "NORMAL"
    };
    let header = Line::from(vec![
        Span::styled(
            format!(" Pi · {} ", tab.thread()),
            Style::default()
                .fg(theme.success)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(" native session · {mode} "),
            Style::default().fg(if app.terminal_focus {
                theme.warning
            } else {
                theme.muted
            }),
        ),
        Span::styled(
            " Ctrl-W n normal · Ctrl-W [ copy · Ctrl-G global terminal ",
            Style::default().fg(theme.dim),
        ),
    ]);
    frame.render_widget(
        Paragraph::new(header).style(Style::default().bg(theme.panel)),
        chunks[0],
    );
    let focused = app.terminal_focus;
    let depth = app.depth;
    let workspace = if tab == DetailTab::Work {
        &mut app.work
    } else {
        &mut app.chat
    };
    if workspace.is_empty() {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    "Pi is not running for this thread.",
                    Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "Persistent sessions are started with `pi --continue` in the card's project (planning) or worktree (work).",
                    Style::default().fg(theme.muted),
                )),
                Line::from(Span::styled(
                    "Press r to start, or check PI_PATH / the Pi CLI.",
                    Style::default().fg(theme.dim),
                )),
            ])
            .style(Style::default().bg(theme.canvas)),
            chunks[1],
        );
        return;
    }
    workspace.resize(chunks[1].width, chunks[1].height);
    workspace.render(frame, chunks[1], focused, depth);
    if !focused {
        let hint = Rect {
            y: chunks[1].y + chunks[1].height.saturating_sub(1),
            height: 1,
            ..chunks[1]
        };
        frame.render_widget(
            Paragraph::new(Span::styled(
                " NORMAL — i focuses Pi · Esc goes back ",
                Style::default().fg(theme.canvas).bg(theme.warning),
            )),
            hint,
        );
    }
}

pub fn theme_for(app: &App) -> Theme {
    app.theme
}
