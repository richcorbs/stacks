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
    number_width: usize,
    show_project: bool,
) -> Line<'static> {
    let (glyph, _) = status_glyph(card.status);
    // Section titles start at column 0; their text starts at column 2. Every
    // card starts at that same column, then uses a fixed disclosure slot so
    // status glyphs, numbers and titles line up across siblings.
    let indent = "  ".repeat(depth + 1);
    let slot = marker
        .map(|marker| format!("{marker} "))
        .unwrap_or_else(|| "  ".into());
    let number = format!(
        "#{:<width$}",
        card.external_id,
        width = number_width.max(2).saturating_sub(1)
    );
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
    let metadata_width = if metadata.is_empty() {
        0
    } else {
        2 + metadata.width()
    };
    let before_title = indent.width() + 1 + 1 + 2 + number.width() + 1;
    let title_width = width
        .saturating_sub(before_title)
        .saturating_sub(metadata_width);
    let title = truncate(&card.title, title_width.max(8));

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
        Span::styled(slot, base.fg(theme.dim)),
        Span::styled(number, base.fg(theme.muted)),
        Span::styled(" ", base),
        Span::styled(
            title.clone(),
            base.fg(theme.text).add_modifier(if selected {
                Modifier::BOLD
            } else {
                Modifier::empty()
            }),
        ),
    ];
    if !metadata.is_empty() {
        spans.push(Span::styled(format!("  {metadata}"), base.fg(theme.dim)));
    }
    let used = before_title + title.width() + metadata_width;
    if selected && used < width {
        spans.push(Span::styled(" ".repeat(width - used), base));
    }
    Line::from(spans)
}

use unicode_width::UnicodeWidthStr;
