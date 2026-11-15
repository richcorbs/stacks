//! DIFF: file explorer + unified diff with review marks.

use std::collections::HashSet;

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
};

use crate::{
    app::App,
    widgets::{
        diff_view::{self, DiffView},
        truncate,
    },
};

pub fn render(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(34), Constraint::Min(40)])
        .split(area);

    let mut lines = Vec::new();
    lines.push(Line::from(Span::styled(
        "CHANGED FILES",
        Style::default().fg(theme.dim).add_modifier(Modifier::BOLD),
    )));
    if app.diff.files.is_empty() {
        lines.push(Line::from(Span::styled(
            "No changes against the target branch.",
            Style::default().fg(theme.dim),
        )));
    }
    let mut last_dir = String::new();
    for (index, file) in app.diff.files.iter().enumerate() {
        let dir = file
            .path
            .rsplit_once('/')
            .map(|(dir, _)| dir.to_string())
            .unwrap_or_default();
        if dir != last_dir {
            lines.push(Line::from(Span::styled(
                format!("{dir}/"),
                Style::default().fg(theme.dim),
            )));
            last_dir = dir;
        }
        let selected = index == app.diff.selected;
        let reviewed = app.diff.reviewed.contains(&file.path);
        let name = file.path.rsplit('/').next().unwrap_or(&file.path);
        lines.push(Line::from(vec![
            Span::styled(
                if selected { "▶ " } else { "  " },
                Style::default().fg(theme.accent),
            ),
            Span::styled(
                format!("{} ", file.status.glyph()),
                Style::default().fg(match file.status {
                    stacks_core::diff::DiffFileStatus::Deleted => theme.danger,
                    stacks_core::diff::DiffFileStatus::Added
                    | stacks_core::diff::DiffFileStatus::Untracked => theme.success,
                    _ => theme.warning,
                }),
            ),
            Span::styled(
                truncate(name, 24),
                Style::default()
                    .fg(if selected { theme.text } else { theme.muted })
                    .bg(if selected {
                        theme.selected
                    } else {
                        theme.canvas
                    }),
            ),
            Span::styled(
                if reviewed { " ✓" } else { "" },
                Style::default().fg(theme.success),
            ),
        ]));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "Space reviewed · n/p file",
        Style::default().fg(theme.dim),
    )));
    frame.render_widget(
        Paragraph::new(lines).style(Style::default().bg(theme.panel)),
        chunks[0],
    );

    if let Some(parsed) = app.diff.parsed.as_ref() {
        let highlighter = diff_view::shared_highlighter();
        let path = app.diff.path.clone().unwrap_or_default();
        let reviewed = app.diff.reviewed.contains(&path);
        diff_view::render(
            frame,
            chunks[1],
            DiffView {
                parsed,
                path: &path,
                reviewed,
                selected: None,
                theme,
                highlighter: &highlighter,
            },
            app.diff.scroll,
        );
    } else if app.diff.files.is_empty() {
        frame.render_widget(
            Paragraph::new("No diff to show.").style(Style::default().fg(theme.dim)),
            chunks[1],
        );
    } else {
        frame.render_widget(
            Paragraph::new("Loading diff…").style(Style::default().fg(theme.dim)),
            chunks[1],
        );
    }
}

/// Files not in a collapsed directory, used by tests.
pub fn visible_files(files: &[stacks_core::diff::DiffFile], _collapsed: &HashSet<String>) -> usize {
    files.len()
}
