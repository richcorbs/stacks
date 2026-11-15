//! Card row formatting shared by the board and palette.

use ratatui::{
    style::{Modifier, Style},
    text::{Line, Span},
};

use stacks_core::{CardSummary, Project};

use crate::theme::{Theme, status_color, status_glyph};
use crate::widgets::truncate;

pub fn card_line(
    card: &CardSummary,
    projects: &[Project],
    theme: Theme,
    width: usize,
    selected: bool,
    depth: usize,
    marker: Option<char>,
    show_project: bool,
) -> Line<'static> {
    let (glyph, _) = status_glyph(card.status);
    let mut indent = "  ".repeat(depth);
    if let Some(marker) = marker {
        indent.push(marker);
        indent.push(' ');
    }
    let number = format!("#{}", card.external_id);
    let project = card.project(projects);
    let mut metadata = Vec::new();
    if show_project {
        if let Some(project) = project {
            metadata.push(project.name.clone());
        }
    }
    if let Some(environment) = &card.environment {
        metadata.push(format!(
            "{} @ {}",
            environment.branch,
            environment
                .worktree_path
                .rsplit('/')
                .next()
                .unwrap_or_default()
        ));
    }
    if let Some(pull_request) = &card.pull_request {
        metadata.push(format!("PR #{}", pull_request.number));
    }
    if !card.children.is_empty() {
        metadata.push(format!("{} children", card.children.len()));
    }
    if card.parent.is_some() {
        metadata.push("child".into());
    }
    let metadata = metadata.join(" · ");
    let used = indent.width() + glyph.width() + 1 + number.width() + 1 + metadata.width() + 3;
    let title_width = width.saturating_sub(used);
    let title = truncate(&card.title, title_width.max(8));

    let indent_width = indent.width();
    let number_width = number.width();
    let title_width_used = title.width();
    let metadata_width = metadata.width();
    let base = if selected {
        Style::default().bg(theme.selected)
    } else {
        Style::default()
    };
    let mut spans = vec![
        Span::styled(indent, base),
        Span::styled(
            glyph.to_string(),
            base.fg(status_color(theme, card.status))
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(" ", base),
        Span::styled(number, base.fg(theme.muted)),
        Span::styled(" ", base),
        Span::styled(
            title,
            base.fg(if selected { theme.text } else { theme.text })
                .add_modifier(if selected {
                    Modifier::BOLD
                } else {
                    Modifier::empty()
                }),
        ),
    ];
    if !metadata.is_empty() {
        spans.push(Span::styled(format!("  {metadata}"), base.fg(theme.dim)));
    }
    let used = indent_width + glyph.width() + number_width + title_width_used + metadata_width + 4;
    if selected && used < width {
        spans.push(Span::styled(" ".repeat(width - used), base));
    }
    Line::from(spans)
}

use unicode_width::UnicodeWidthStr;
