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
    let active_name = app
        .selected_project()
        .map(|project| project.name.clone())
        .unwrap_or_else(|| "All projects".into());
    let mut lines = Vec::new();

    let render_row = |lines: &mut Vec<Line<'static>>,
                      index: usize,
                      label: String,
                      count: usize,
                      active: bool,
                      accent: ratatui::style::Color| {
        let cursor = focused && index == app.sidebar_cursor;
        let marker = if cursor {
            "▶"
        } else if active {
            "◆"
        } else {
            "◇"
        };
        let row_style = if cursor {
            Style::default()
                .fg(theme.text)
                .bg(theme.selected)
                .add_modifier(Modifier::BOLD)
        } else if active {
            Style::default()
                .fg(theme.text)
                .bg(theme.raised)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme.muted).bg(theme.panel)
        };
        lines.push(Line::from(vec![
            Span::styled(
                format!("{marker} "),
                Style::default()
                    .fg(if cursor { theme.accent } else { accent })
                    .bg(if cursor { theme.selected } else { theme.panel }),
            ),
            Span::styled(format!("{:<18}", truncate(&label, 18)), row_style),
            Span::styled(
                format!("{count:>4}"),
                Style::default()
                    .fg(if cursor { theme.text } else { theme.dim })
                    .bg(if cursor { theme.selected } else { theme.panel }),
            ),
        ]));
    };

    render_row(
        &mut lines,
        0,
        "All projects".into(),
        total,
        app.project_scope.is_none(),
        theme.accent,
    );
    if let Some(board) = app.board.as_ref() {
        for (index, project) in board.projects.iter().enumerate() {
            let active = app.project_scope.as_deref() == Some(project.id.as_str());
            let accent = crate::theme::project_accent(app.depth, project.color_id.as_deref());
            render_row(
                &mut lines,
                index + 1,
                project.name.clone(),
                app.project_count(&project.id),
                active,
                accent,
            );
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        if focused {
            "j/k move · Enter filter · Esc back"
        } else {
            "h or Tab to browse projects"
        },
        Style::default().fg(if focused { theme.accent } else { theme.dim }),
    )));

    let project_count = app
        .board
        .as_ref()
        .map(|board| board.projects.len())
        .unwrap_or(0);
    let title = if app.project_scope.is_some() {
        format!(" PROJECTS {project_count} · {active_name} ")
    } else {
        format!(
            " PROJECTS {} ",
            app.board
                .as_ref()
                .map(|board| board.projects.len())
                .unwrap_or(0)
        )
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(if focused { theme.accent } else { theme.muted }))
        .title(Span::styled(
            truncate(&title, area.width.saturating_sub(2) as usize),
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
    let number_width = app
        .board
        .as_ref()
        .map(|board| {
            board
                .cards
                .iter()
                .map(|card| card.external_id.chars().count())
                .max()
                .unwrap_or(3)
                .max(3)
                + 1
        })
        .unwrap_or(4);
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
                    Span::styled(row.label.to_uppercase(), style),
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
                        number_width,
                        app.project_scope.is_none(),
                    ));
                    if selected {
                        lines.push(details_line(
                            app,
                            card,
                            row.depth,
                            number_width,
                            width,
                            theme,
                        ));
                    }
                }
            }
        }
    }
    let height = area.height as usize;
    let detail_rows = usize::from(app.selected_board_card().is_some());
    let offset = app
        .board_cursor
        .saturating_sub(height.saturating_sub(1 + detail_rows));
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

fn details_line(
    app: &App,
    card: &stacks_core::CardSummary,
    depth: usize,
    number_width: usize,
    width: usize,
    theme: crate::theme::Theme,
) -> Line<'static> {
    let title_column = 2 * (depth + 1) + 1 + 1 + 2 + number_width + 1;
    let branch = app
        .selected_git
        .as_ref()
        .map(|status| status.branch.clone())
        .or_else(|| {
            card.environment
                .as_ref()
                .map(|environment| environment.branch.clone())
        })
        .unwrap_or_else(|| "no worktree".into());
    let git = if card.environment.is_none() {
        "—".to_string()
    } else if app.selected_git_loading {
        "checking…".to_string()
    } else if let Some(error) = app.selected_git_error.as_ref() {
        format!("◆ {}", truncate(error, 60))
    } else if let Some(status) = app.selected_git.as_ref() {
        format!(
            "+{} ~{} -{}",
            status.created, status.changed, status.deleted
        )
    } else {
        "—".to_string()
    };
    let pull_request = card
        .pull_request
        .as_ref()
        .map(|pull_request| {
            format!(
                "PR #{} {}{} · CI {} · review {}",
                pull_request.number,
                pull_request.state,
                if pull_request.draft { " draft" } else { "" },
                pull_request.ci_status,
                pull_request.review_state
            )
        })
        .unwrap_or_else(|| "no PR".into());
    let text = format!(
        "{}  ·  {}  ·  {}",
        truncate(&branch, 34),
        truncate(&git, 24),
        pull_request
    );
    let available = width.saturating_sub(title_column);
    Line::from(Span::styled(
        format!(
            "{}{}",
            " ".repeat(title_column),
            truncate(&text, available.max(8))
        ),
        Style::default().fg(theme.muted).bg(theme.raised),
    ))
}

/// Status-right text: group and visible card counts.
pub fn position(app: &App) -> Option<String> {
    if let Some(row) = app.board_rows.get(app.board_cursor) {
        if row.kind == BoardRowKind::Group {
            return Some(format!(
                "{} · {} cards",
                row.label.to_uppercase(),
                row.count
            ));
        }
    }
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
