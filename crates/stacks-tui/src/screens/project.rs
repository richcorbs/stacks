//! Project workspace: project notes, Agent, terminal, server and console.

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
};

use crate::{
    app::{App, ProjectTab},
    widgets::{markdown, render_text_area, tabs},
};

pub fn render(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    if app.project.is_none() {
        frame.render_widget(
            Paragraph::new(Span::styled(
                "No project workspace is open.",
                Style::default().fg(theme.muted),
            ))
            .style(Style::default().bg(theme.canvas)),
            area,
        );
        return;
    }
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Min(4),
        ])
        .split(area);
    let tabs_list = app.project_tabs();
    let active = app.project_tab_index();
    let entries = tabs_list
        .iter()
        .enumerate()
        .map(|(index, tab)| tabs::Tab {
            number: index + 1,
            label: tab.label(),
            enabled: true,
        })
        .collect::<Vec<_>>();
    tabs::render(frame, chunks[0], theme, &entries, active);
    frame.render_widget(
        Paragraph::new("").style(Style::default().bg(theme.canvas)),
        chunks[1],
    );
    let body = chunks[2];
    let tab = app
        .project
        .as_ref()
        .map(|state| state.tab)
        .unwrap_or(ProjectTab::Notes);
    match tab {
        ProjectTab::Notes => render_notes(frame, app, body),
        ProjectTab::Agent | ProjectTab::Terminal | ProjectTab::Server | ProjectTab::Console => {
            render_terminal(frame, app, body)
        }
    }
}

fn render_notes(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let focused = app
        .project
        .as_ref()
        .is_some_and(|state| state.notes_editing);
    let Some(state) = app.project.as_mut() else {
        return;
    };
    if focused {
        render_text_area(
            frame,
            area,
            &state.notes.value,
            Some(state.notes.cursor),
            "PROJECT NOTES · Ctrl-S save · Esc done",
            true,
            theme,
        );
        return;
    }
    let width = area.width as usize;
    let mut lines = if state.notes.value.trim().is_empty() {
        vec![
            Line::from(Span::styled(
                "No project notes yet.",
                Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
            )),
            Line::from(""),
            Line::from(Span::styled(
                "Press e to write a scratch pad for this project.",
                Style::default().fg(theme.muted),
            )),
        ]
    } else {
        markdown::lines(&state.notes.value, width, theme)
    };
    let total = lines.len() as u16;
    let offset = state.notes_scroll.min(total.saturating_sub(area.height));
    if offset > 0 {
        lines.drain(0..(offset as usize).min(lines.len()));
    }
    frame.render_widget(
        Paragraph::new(lines).style(Style::default().bg(theme.canvas)),
        area,
    );
}

fn render_terminal(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let focused = app.terminal_focus;
    let depth = app.depth;
    let Some(state) = app.project.as_mut() else {
        return;
    };
    let (workspace, label) = match state.tab {
        ProjectTab::Agent => (&mut state.agent, "Project Agent"),
        ProjectTab::Terminal => (&mut state.terminal, "Project Terminal"),
        ProjectTab::Server => (&mut state.server, "Project Server"),
        ProjectTab::Console => (&mut state.console, "Project Console"),
        ProjectTab::Notes => return,
    };
    if workspace.is_empty() {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    format!("{label} is not running."),
                    Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "Press Tab to leave and return, or check the project command/Pi CLI.",
                    Style::default().fg(theme.muted),
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
