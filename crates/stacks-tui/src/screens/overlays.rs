//! Modal overlays: confirm, palette, project picker, actions, text editors.

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Wrap},
};

use crate::{
    app::{App, ConfirmOutcome, Overlay},
    widgets::{TextInput, centered, modal, render_input, render_text_area, truncate},
};

pub fn render(frame: &mut Frame, app: &mut App, area: Rect) {
    match app.overlay.clone() {
        Some(Overlay::Help) => render_help(frame, app, area),
        Some(Overlay::Settings) => render_settings(frame, app, area),
        Some(Overlay::Palette) => render_palette(frame, app, area),
        Some(Overlay::Projects) => render_projects(frame, app, area),
        Some(Overlay::Actions) => render_actions(frame, app, area),
        Some(Overlay::NewCard) => render_new_card(frame, app, area),
        Some(Overlay::EditCard) => render_edit_card(frame, app, area),
        Some(Overlay::FinishRefinement) => render_refinement(frame, app, area),
        Some(Overlay::Filter) => render_filter(frame, app, area),
        Some(Overlay::GlobalTerminal) => {}
        None => {}
    }
    if app.confirm.is_some() {
        render_confirm(frame, app, area);
    }
}

fn render_help(frame: &mut Frame, app: &mut App, area: Rect) {
    let modal_area = centered(area, 100, area.height.saturating_sub(4).max(10));
    modal(frame, modal_area, "Keyboard reference", app.theme);
    let inner = modal_area.inner(ratatui::layout::Margin::new(2, 1));
    crate::screens::help::render(frame, app, inner);
}

fn render_settings(frame: &mut Frame, app: &mut App, area: Rect) {
    let modal_area = centered(area, 90, area.height.saturating_sub(6).max(14));
    modal(frame, modal_area, "Settings · settings.json", app.theme);
    let inner = modal_area.inner(ratatui::layout::Margin::new(2, 1));
    crate::screens::settings::render(frame, app, inner);
}

fn render_confirm(frame: &mut Frame, app: &mut App, area: Rect) {
    let Some(confirm) = app.confirm.as_ref() else {
        return;
    };
    let theme = app.theme;
    let modal_area = centered(area, 70, 10);
    modal(frame, modal_area, "Confirm", theme);
    let inner = modal_area.inner(ratatui::layout::Margin::new(2, 1));
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(2),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .split(inner);
    frame.render_widget(
        Paragraph::new(Span::styled(
            confirm.title.clone(),
            Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
        )),
        chunks[0],
    );
    frame.render_widget(
        Paragraph::new(confirm.detail.clone())
            .style(Style::default().fg(theme.muted))
            .wrap(Wrap { trim: false }),
        chunks[1],
    );
    let outcome = confirm.outcome();
    let status = match outcome {
        ConfirmOutcome::Pending => format!(
            "two-step confirmation: {} — the primary action stays disabled",
            confirm.countdown()
        ),
        _ => "ready".to_string(),
    };
    frame.render_widget(
        Paragraph::new(Span::styled(status, Style::default().fg(theme.warning)))
            .wrap(Wrap { trim: false }),
        chunks[2],
    );
    let mut spans = Vec::new();
    let cancel_style = if !confirm.focus_primary {
        Style::default()
            .fg(theme.canvas)
            .bg(theme.muted)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(theme.muted)
    };
    let primary_style = if confirm.focus_primary && confirm.ready() {
        Style::default()
            .fg(theme.canvas)
            .bg(if confirm.destructive {
                theme.danger
            } else {
                theme.accent
            })
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(theme.dim)
    };
    spans.push(Span::styled(" [ No / Esc ] ", cancel_style));
    spans.push(Span::raw("   "));
    spans.push(Span::styled(
        format!(" [ {} ] ", truncate(&confirm.primary_label, 26)),
        primary_style,
    ));
    spans.push(Span::styled(
        "    Tab to move",
        Style::default().fg(theme.dim),
    ));
    frame.render_widget(Paragraph::new(Line::from(spans)), chunks[3]);
}

fn render_palette(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let modal_area = centered(area, 84, area.height.saturating_sub(6).max(16));
    modal(
        frame,
        modal_area,
        "Command palette · actions, cards, projects",
        theme,
    );
    let inner = modal_area.inner(ratatui::layout::Margin::new(1, 1));
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(6)])
        .split(inner);
    render_input(
        frame,
        Rect {
            height: 3,
            ..chunks[0]
        },
        &app.palette_query,
        "Search",
        true,
        theme,
    );
    let height = chunks[1].height as usize;
    let offset = app.palette_cursor.saturating_sub(height.saturating_sub(1));
    let mut lines = Vec::new();
    for (index, item) in app
        .palette_items
        .iter()
        .enumerate()
        .skip(offset)
        .take(height)
    {
        let selected = index == app.palette_cursor;
        let uses = app.usage.get(&item.id).copied().unwrap_or(0);
        lines.push(Line::from(vec![
            Span::styled(
                if selected { "▶ " } else { "  " },
                Style::default().fg(theme.accent),
            ),
            Span::styled(
                truncate(&item.label, (chunks[1].width as usize).saturating_sub(24)),
                Style::default()
                    .fg(if selected { theme.text } else { theme.muted })
                    .bg(if selected {
                        theme.selected
                    } else {
                        theme.panel
                    }),
            ),
            Span::styled(
                format!(
                    "  {}  {}",
                    item.hint,
                    if uses > 0 {
                        format!("used {uses}×")
                    } else {
                        String::new()
                    }
                ),
                Style::default().fg(theme.dim),
            ),
        ]));
    }
    if lines.is_empty() {
        lines.push(Line::from(Span::styled(
            "No matches",
            Style::default().fg(theme.dim),
        )));
    }
    frame.render_widget(
        Paragraph::new(lines).style(Style::default().bg(theme.panel)),
        chunks[1],
    );
}

fn render_projects(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let modal_area = centered(area, 66, 18);
    modal(frame, modal_area, "Projects · Ctrl-N new card", theme);
    let inner = modal_area.inner(ratatui::layout::Margin::new(1, 1));
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(4)])
        .split(inner);
    render_input(
        frame,
        Rect {
            height: 3,
            ..chunks[0]
        },
        &app.project_query,
        "Search",
        true,
        theme,
    );
    let mut lines = Vec::new();
    let query = app.project_query.value.to_ascii_lowercase();
    let mut entries: Vec<(String, String)> = vec![("All projects".into(), String::new())];
    if let Some(board) = app.board.as_ref() {
        for project in &board.projects {
            let label = project.name.clone();
            if query.is_empty() || crate::app::fuzzy(&query, &label.to_ascii_lowercase()) {
                entries.push((label, project.id.clone()));
            }
        }
    }
    for (index, (label, _)) in entries.iter().enumerate().take(chunks[1].height as usize) {
        let selected = index == app.project_picker_cursor;
        lines.push(Line::from(vec![
            Span::styled(
                if selected { "▶ " } else { "  " },
                Style::default().fg(theme.accent),
            ),
            Span::styled(
                label.clone(),
                Style::default()
                    .fg(if selected { theme.text } else { theme.muted })
                    .bg(if selected {
                        theme.selected
                    } else {
                        theme.panel
                    }),
            ),
        ]));
    }
    frame.render_widget(
        Paragraph::new(lines).style(Style::default().bg(theme.panel)),
        chunks[1],
    );
}

fn render_actions(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let modal_area = centered(area, 78, 18);
    modal(frame, modal_area, "Actions · backend capabilities", theme);
    let inner = modal_area.inner(ratatui::layout::Margin::new(1, 1));
    let mut lines = Vec::new();
    for (index, action) in app.actions.iter().enumerate() {
        let selected = index == app.action_cursor;
        let style = if action.disabled_reason.is_some() {
            Style::default().fg(theme.dim)
        } else if selected {
            Style::default().fg(theme.text).bg(theme.selected)
        } else {
            Style::default().fg(theme.muted)
        };
        lines.push(Line::from(vec![
            Span::styled(
                if selected { "▶ " } else { "  " },
                Style::default().fg(theme.accent),
            ),
            Span::styled(
                format!(
                    "{} {}{}",
                    if action.primary { "★" } else { "·" },
                    action.label,
                    if action.confirmation.is_some() {
                        "  ◆ confirm"
                    } else {
                        ""
                    }
                ),
                style.add_modifier(if action.primary {
                    Modifier::BOLD
                } else {
                    Modifier::empty()
                }),
            ),
        ]));
        if let Some(reason) = &action.disabled_reason {
            lines.push(Line::from(Span::styled(
                format!("    ✕ {reason}"),
                Style::default().fg(theme.warning),
            )));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "j/k choose · Enter run · Esc close",
        Style::default().fg(theme.dim),
    )));
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().bg(theme.panel))
            .wrap(Wrap { trim: false }),
        inner,
    );
}

fn render_new_card(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let Some(state) = app.new_card.as_ref() else {
        return;
    };
    let modal_area = centered(area, 90, area.height.saturating_sub(6).max(18));
    modal(
        frame,
        modal_area,
        "New card · Tab switches field · Enter sends",
        theme,
    );
    let inner = modal_area.inner(ratatui::layout::Margin::new(2, 1));
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(8),
            Constraint::Length(1),
        ])
        .split(inner);
    render_input(
        frame,
        chunks[0],
        &state.title,
        "Title",
        state.focus == 0,
        theme,
    );
    render_text_area(
        frame,
        chunks[1],
        &state.content.value,
        Some(state.content.cursor).filter(|_| state.focus == 1),
        "Description (Alt-Enter newline)",
        state.focus == 1,
        theme,
    );
    frame.render_widget(
        Paragraph::new(
            "Enter on title moves to description; Enter on description creates. Esc keeps a draft.",
        )
        .style(Style::default().fg(theme.dim)),
        chunks[2],
    );
}

fn render_edit_card(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let Some(state) = app.edit_card.as_ref() else {
        return;
    };
    let modal_area = centered(area, 90, area.height.saturating_sub(6).max(18));
    modal(frame, modal_area, "Edit card · Ctrl-S save", theme);
    let inner = modal_area.inner(ratatui::layout::Margin::new(2, 1));
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(8),
            Constraint::Length(1),
        ])
        .split(inner);
    render_input(
        frame,
        chunks[0],
        &state.title,
        "Title",
        state.focus == 0,
        theme,
    );
    render_text_area(
        frame,
        chunks[1],
        &state.content.value,
        Some(state.content.cursor).filter(|_| state.focus == 1),
        "Description (Alt-Enter newline)",
        state.focus == 1,
        theme,
    );
    frame.render_widget(
        Paragraph::new("Ctrl-S saves with the workflow revision shown in the header. Esc cancels.")
            .style(Style::default().fg(theme.dim)),
        chunks[2],
    );
}

fn render_refinement(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let Some(state) = app.refinement.as_ref() else {
        return;
    };
    let modal_area = centered(area, 90, area.height.saturating_sub(4).max(18));
    modal(
        frame,
        modal_area,
        "Finish refinement · Ctrl-S saves & moves to Ready",
        theme,
    );
    let inner = modal_area.inner(ratatui::layout::Margin::new(1, 1));
    render_text_area(
        frame,
        inner,
        &state.content.value,
        Some(state.content.cursor),
        "Final brief",
        true,
        theme,
    );
}

fn render_filter(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let width = area.width.min(70);
    let filter_area = Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y,
        width,
        height: 3,
    };
    render_input(
        frame,
        filter_area,
        &app.filter_input,
        "Filter cards",
        true,
        theme,
    );
}

/// Used by the tests to validate palette query echoing.
pub fn palette_input(app: &App) -> &TextInput {
    &app.palette_query
}
