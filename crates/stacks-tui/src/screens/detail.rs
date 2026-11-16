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
    theme::status_glyph,
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
    let (_, word) = status_glyph(card.status);

    let mut parts = vec![word.to_string()];
    if let Some(environment) = &card.environment {
        let branch_width = (area.width as usize / 4).clamp(12, 30);
        let path_width = (area.width as usize / 3).clamp(16, 44);
        parts.push(truncate(&environment.branch, branch_width));
        parts.push(truncate(&environment.worktree_path, path_width));
        let counts = if app.selected_git_card.as_deref() == Some(card.id.as_str()) {
            if app.selected_git_loading {
                "checking…".to_string()
            } else if let Some(error) = app.selected_git_error.as_ref() {
                format!("◆ {}", truncate(error, 40))
            } else if let Some(status) = app.selected_git.as_ref() {
                format!(
                    "+{} ~{} -{}",
                    status.created, status.changed, status.deleted
                )
            } else {
                "—".to_string()
            }
        } else {
            "—".to_string()
        };
        parts.push(counts);
    } else {
        parts.push("no worktree".to_string());
    }
    let meta = parts.join("  ·  ");
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Min(6),
        ])
        .split(area);
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            truncate(&meta, area.width.saturating_sub(2) as usize),
            Style::default().fg(theme.muted),
        )))
        .style(Style::default().bg(theme.canvas)),
        chunks[0],
    );
    // Intentional breathing room above the tab bar; the title lives once in
    // the app header, and this line carries workflow/worktree context.
    frame.render_widget(
        Paragraph::new("").style(Style::default().bg(theme.canvas)),
        chunks[1],
    );

    let tab_entries = app
        .visible_detail_tabs()
        .iter()
        .enumerate()
        .map(|(index, tab)| tabs::Tab {
            number: index + 1,
            label: tab.label(),
            enabled: tab_enabled(app, *tab),
        })
        .collect::<Vec<_>>();
    tabs::render(
        frame,
        chunks[2],
        theme,
        &tab_entries,
        app.detail_tab_index(),
    );
    frame.render_widget(
        Paragraph::new("").style(Style::default().bg(theme.canvas)),
        chunks[3],
    );
    let body = chunks[4];
    match app.detail_tab {
        DetailTab::Overview => render_overview(frame, app, body),
        DetailTab::Agent => chat::render(frame, app, body, DetailTab::Agent),
        DetailTab::Diff => diff::render(frame, app, body),
        DetailTab::Server => terminal::render_service(frame, app, body, DetailTab::Server),
        DetailTab::Console => terminal::render_service(frame, app, body, DetailTab::Console),
        DetailTab::Terminal => terminal::render_card(frame, app, body),
    }
}

fn tab_enabled(app: &App, tab: DetailTab) -> bool {
    match tab {
        DetailTab::Overview | DetailTab::Server | DetailTab::Console => true,
        DetailTab::Diff | DetailTab::Terminal | DetailTab::Agent => app
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
        lines.extend(markdown::card_lines(&detail.content, width, theme));
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

pub fn title(app: &App) -> String {
    let Some(detail) = app.detail.as_ref() else {
        return "Card".into();
    };
    let project = app
        .detail_project()
        .map(|project| project.name.clone())
        .unwrap_or_default();
    if project.is_empty() {
        format!("#{} {}", detail.card.external_id, detail.card.title)
    } else {
        format!(
            "{project} · #{} {}",
            detail.card.external_id, detail.card.title
        )
    }
}
