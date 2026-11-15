//! Board: project sidebar + grouped card list.

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
};

use crate::{
    app::{App, BoardRowKind, Focus},
    theme::status_glyph,
    widgets::{card_list::card_line, truncate},
};

pub fn render(frame: &mut Frame, app: &mut App, area: Rect) {
    if app.sidebar_visible {
        let chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Length(27), Constraint::Min(40)])
            .split(area);
        render_sidebar(frame, app, chunks[0]);
        render_cards(frame, app, chunks[1]);
    } else {
        render_cards(frame, app, area);
    }
}

fn render_sidebar(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let focused = app.focus == Focus::Sidebar;
    let total = app
        .board
        .as_ref()
        .map(|board| board.cards.len())
        .unwrap_or(0);
    let mut lines = Vec::new();
    let selected = app.project_scope.is_none();
    lines.push(Line::from(vec![
        Span::styled(
            if selected { "◆ " } else { "◇ " },
            Style::default().fg(theme.accent),
        ),
        Span::styled(
            "All projects",
            Style::default()
                .fg(if selected { theme.text } else { theme.muted })
                .bg(if selected {
                    theme.selected
                } else {
                    theme.panel
                }),
        ),
        Span::styled(format!("  {total}"), Style::default().fg(theme.dim)),
    ]));
    if let Some(board) = app.board.as_ref() {
        for project in &board.projects {
            let active = app.project_scope.as_deref() == Some(project.id.as_str());
            let color = crate::theme::project_accent(app.depth, project.color_id.as_deref());
            let count = app.project_count(&project.id);
            lines.push(Line::from(vec![
                Span::styled(if active { "◆ " } else { "◇ " }, Style::default().fg(color)),
                Span::styled(
                    truncate(&project.name, 18),
                    Style::default()
                        .fg(if active { theme.text } else { theme.muted })
                        .bg(if active { theme.selected } else { theme.panel }),
                ),
                Span::styled(format!("  {count}"), Style::default().fg(theme.dim)),
            ]));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "Ctrl-B hide · Ctrl-F",
        Style::default().fg(theme.dim),
    )));
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(if focused { theme.accent } else { theme.muted }))
        .title(Span::styled(
            format!(
                " PROJECTS {} ",
                app.board
                    .as_ref()
                    .map(|board| board.projects.len())
                    .unwrap_or(0)
            ),
            Style::default()
                .fg(if focused { theme.accent } else { theme.dim })
                .add_modifier(Modifier::BOLD),
        ))
        .style(Style::default().bg(theme.panel));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    frame.render_widget(
        Paragraph::new(lines).style(Style::default().bg(theme.panel)),
        inner,
    );
}

fn render_cards(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let focused = app.focus == Focus::Board;
    let scope = app
        .selected_project()
        .map(|project| project.name.clone())
        .unwrap_or_else(|| "All projects".into());
    let visible = app
        .selected_project()
        .map(|project| app.project_count(&project.id))
        .or_else(|| app.board.as_ref().map(|board| board.cards.len()))
        .unwrap_or(0);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(if focused { theme.accent } else { theme.muted }))
        .title(Span::styled(
            format!(" CARDS · {scope} · {visible} "),
            Style::default()
                .fg(if focused { theme.accent } else { theme.dim })
                .add_modifier(Modifier::BOLD),
        ))
        .style(Style::default().bg(theme.canvas));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let area = inner;
    if app.board.is_none() {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    "No workflow database",
                    Style::default()
                        .fg(theme.danger)
                        .add_modifier(Modifier::BOLD),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "Start Stacks once, or pass --db /path/to/workflow.sqlite3.",
                    Style::default().fg(theme.muted),
                )),
            ])
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(theme.muted))
                    .style(Style::default().bg(theme.canvas)),
            ),
            area,
        );
        return;
    }
    if app.board_rows.is_empty() {
        frame.render_widget(
            Paragraph::new("No cards match this filter.")
                .style(Style::default().fg(theme.dim).bg(theme.canvas)),
            area,
        );
        return;
    }
    let width = area.width as usize;
    let rows = &app.board_rows;
    let mut lines = Vec::new();
    let projects = app
        .board
        .as_ref()
        .map(|board| board.projects.clone())
        .unwrap_or_default();
    for (index, row) in rows.iter().enumerate() {
        let selected = index == app.board_cursor;
        match row.kind {
            BoardRowKind::Group => {
                let marker = if row.collapsed { "▸" } else { "▾" };
                let style = Style::default()
                    .fg(if selected { theme.text } else { theme.muted })
                    .bg(if selected {
                        theme.selected
                    } else {
                        theme.canvas
                    })
                    .add_modifier(Modifier::BOLD);
                lines.push(Line::from(vec![
                    Span::styled(format!("{marker} "), style),
                    Span::styled(row.label.clone(), style),
                    Span::styled(format!("   {}", row.count), Style::default().fg(theme.dim)),
                ]));
            }
            BoardRowKind::Card => {
                if let Some(card) = row
                    .card_id
                    .as_deref()
                    .and_then(|id| app.board.as_ref()?.cards.iter().find(|card| card.id == id))
                {
                    let marker = if row.has_children {
                        Some(if row.expanded { '▾' } else { '▸' })
                    } else {
                        None
                    };
                    lines.push(card_line(
                        card,
                        &projects,
                        theme,
                        width,
                        selected,
                        row.depth,
                        marker,
                        app.project_scope.is_none(),
                    ));
                }
            }
        }
    }
    let height = area.height as usize;
    let offset = app.board_cursor.saturating_sub(height.saturating_sub(1));
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().bg(theme.canvas))
            .scroll((offset as u16, 0)),
        area,
    );

    // Group/selection position is shown in the status line instead of a title.
    if app.loading_board && area.height > 0 {
        let line = Line::from(vec![Span::styled(
            " ● refreshing ",
            Style::default().fg(theme.warning),
        )]);
        frame.render_widget(
            Paragraph::new(line).style(Style::default().bg(theme.panel)),
            Rect {
                y: area.y,
                height: 1,
                ..area
            },
        );
    }
}

/// Status-right text: group and visible card counts.
pub fn position(app: &App) -> Option<String> {
    let index = app
        .board_rows
        .iter()
        .take(app.board_cursor + 1)
        .filter(|row| row.kind == BoardRowKind::Card)
        .count();
    let total = app
        .board_rows
        .iter()
        .filter(|row| row.kind == BoardRowKind::Card)
        .count();
    let (glyph, word) = app
        .selected_board_card()
        .map(|card| status_glyph(card.status))
        .unwrap_or(("·", ""));
    Some(format!("{index}/{total}  {glyph} {word}"))
}
