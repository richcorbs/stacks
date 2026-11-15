//! Card detail shell: header, tabs, body and footer.

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
};

use crate::{
    app::{App, DetailTab},
    screens::{chat, diff, terminal},
    theme::{status_color, status_glyph},
    widgets::{markdown, tabs, truncate},
};

pub fn render(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let Some(detail) = app.detail.as_ref() else {
        let title = if app.detail_loading {
            "Loading card…"
        } else {
            "Select a card"
        };
        frame.render_widget(
            Paragraph::new(Span::styled(title, Style::default().fg(theme.muted))).block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(theme.muted)),
            ),
            area,
        );
        return;
    };
    let card = detail.card.clone();
    let board_projects = app
        .board
        .as_ref()
        .map(|board| board.projects.clone())
        .unwrap_or_default();
    let project = card.project(&board_projects);
    let (glyph, word) = status_glyph(card.status);
    let mut header = Vec::new();
    header.push(Line::from(vec![
        Span::styled(
            glyph,
            Style::default()
                .fg(status_color(theme, card.status))
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(" ", Style::default()),
        Span::styled(
            card.title.clone(),
            Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("  #{}", card.external_id),
            Style::default().fg(theme.dim),
        ),
    ]));
    let mut meta = vec![
        project
            .map(|project| project.name.clone())
            .unwrap_or_else(|| "no project".into()),
        word.to_string(),
        format!("rev {}", card.workflow_revision),
    ];
    if let Some(environment) = &card.environment {
        meta.push(environment.branch.clone());
        meta.push(environment.worktree_path.clone());
    }
    if let Some(pull_request) = &card.pull_request {
        meta.push(format!(
            "PR #{} {}",
            pull_request.number, pull_request.ci_status
        ));
    }
    header.push(Line::from(Span::styled(
        truncate(&meta.join("  ·  "), area.width as usize),
        Style::default().fg(theme.muted),
    )));
    let header_height = header.len() as u16;
    let footer_height = if app.actions.is_empty() { 1 } else { 2 };
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(header_height),
            Constraint::Length(1),
            Constraint::Min(6),
            Constraint::Length(footer_height),
        ])
        .split(area);
    frame.render_widget(
        Paragraph::new(header).style(Style::default().bg(theme.canvas)),
        chunks[0],
    );

    let tab_entries = DetailTab::ALL
        .iter()
        .map(|tab| tabs::Tab {
            number: tab.index() + 1,
            label: tab.label(),
            enabled: tab_enabled(app, *tab),
        })
        .collect::<Vec<_>>();
    tabs::render(
        frame,
        chunks[1],
        theme,
        &tab_entries,
        app.detail_tab_index(),
    );

    let body = chunks[2];
    match app.detail_tab {
        DetailTab::Overview => render_overview(frame, app, body),
        DetailTab::Chat => chat::render(frame, app, body, DetailTab::Chat),
        DetailTab::Work => chat::render(frame, app, body, DetailTab::Work),
        DetailTab::Diff => diff::render(frame, app, body),
        DetailTab::Terminal => terminal::render_card(frame, app, body),
    }

    render_footer(frame, app, chunks[3]);
}

fn tab_enabled(app: &App, tab: DetailTab) -> bool {
    match tab {
        DetailTab::Overview | DetailTab::Chat => true,
        DetailTab::Diff | DetailTab::Terminal | DetailTab::Work => app
            .detail
            .as_ref()
            .is_some_and(|detail| detail.card.environment.is_some()),
    }
}

fn render_overview(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let Some(detail) = app.detail.as_ref() else {
        return;
    };
    let width = area.width as usize;
    let mut lines = Vec::new();
    if !detail.content.trim().is_empty() {
        lines.extend(markdown::lines(&detail.content, width, theme));
    } else {
        lines.push(Line::from(Span::styled(
            "No description yet. Press e to write one.",
            Style::default().fg(theme.dim),
        )));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "EVENTS",
        Style::default().fg(theme.dim).add_modifier(Modifier::BOLD),
    )));
    for event in detail.events.iter().take(20) {
        let status = if event.outcome == "failure" {
            theme.danger
        } else {
            theme.muted
        };
        lines.push(Line::from(vec![
            Span::styled(
                format!("{} ", event.event_type),
                Style::default().fg(status),
            ),
            Span::styled(
                event.summary.clone().unwrap_or_default(),
                Style::default().fg(theme.dim),
            ),
        ]));
    }
    let total = lines.len() as u16;
    let offset = app.detail_scroll.min(total.saturating_sub(area.height));
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().bg(theme.canvas))
            .wrap(Wrap { trim: false })
            .scroll((offset, 0)),
        area,
    );
}

fn render_footer(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let mut lines = Vec::new();
    if app.actions.is_empty() {
        lines.push(Line::from(Span::styled(
            "No actions for this card state.",
            Style::default().fg(theme.dim),
        )));
    } else {
        let mut spans = Vec::new();
        for (index, action) in app.actions.iter().enumerate() {
            if index > 0 {
                spans.push(Span::styled("  ·  ", Style::default().fg(theme.dim)));
            }
            let style = if action.disabled_reason.is_some() {
                Style::default().fg(theme.dim)
            } else if action.primary {
                Style::default()
                    .fg(theme.canvas)
                    .bg(theme.accent)
                    .add_modifier(Modifier::BOLD)
            } else if matches!(
                action.appearance,
                stacks_core::WorkflowActionAppearance::DangerGhost
            ) {
                Style::default().fg(theme.danger)
            } else {
                Style::default().fg(theme.muted)
            };
            spans.push(Span::styled(
                format!(
                    "{} {}{}",
                    if action.primary { "▶" } else { "·" },
                    action.label,
                    if action.disabled_reason.is_some() {
                        " ✕"
                    } else {
                        ""
                    }
                ),
                style,
            ));
        }
        lines.push(Line::from(spans));
        let disabled = app
            .actions
            .iter()
            .find_map(|action| action.disabled_reason.clone());
        lines.push(Line::from(Span::styled(
            disabled.unwrap_or_else(|| "a actions · 1..4 tabs · Esc back".into()),
            Style::default().fg(if app.actions.iter().any(|a| a.disabled_reason.is_some()) {
                theme.warning
            } else {
                theme.dim
            }),
        )));
    }
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().bg(theme.panel))
            .wrap(Wrap { trim: true }),
        area,
    );
}

pub fn title(app: &App) -> String {
    let Some(detail) = app.detail.as_ref() else {
        return "Card".into();
    };
    let project = app
        .detail_project()
        .map(|project| project.name.clone())
        .unwrap_or_default();
    format!(
        "{project} · #{} {}",
        detail.card.external_id, detail.card.title
    )
}
