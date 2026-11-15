//! Unified diff rendering with syntax highlighting and a sticky hunk header.

use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Wrap},
};
use stacks_core::diff::{DiffLine, DiffLineKind, ParsedDiff};
use syntect::{
    easy::HighlightLines,
    highlighting::{Style as SyntectStyle, ThemeSet},
    parsing::SyntaxSet,
    util::LinesWithEndings,
};

use crate::theme::Theme;

static HIGHLIGHTER: std::sync::OnceLock<Highlighter> = std::sync::OnceLock::new();

/// Shared syntax/theme data; loading syntect defaults per frame is too slow.
pub fn shared_highlighter() -> &'static Highlighter {
    HIGHLIGHTER.get_or_init(Highlighter::new)
}
use crate::widgets::truncate;

pub struct Highlighter {
    syntaxes: SyntaxSet,
    theme: Option<syntect::highlighting::Theme>,
}

impl Default for Highlighter {
    fn default() -> Self {
        Self::new()
    }
}

impl Highlighter {
    pub fn new() -> Self {
        let syntaxes = SyntaxSet::load_defaults_newlines();
        let theme = ThemeSet::load_defaults()
            .themes
            .get("base16-ocean.dark")
            .cloned();
        Self { syntaxes, theme }
    }

    /// Render highlighted text as terminal styles.
    pub fn highlight_lines(&self, path: &str, text: &str, theme: Theme) -> Vec<Line<'static>> {
        let Some(syntect_theme) = self.theme.as_ref() else {
            return text
                .lines()
                .map(|line| {
                    Line::from(Span::styled(
                        line.to_string(),
                        Style::default().fg(theme.text),
                    ))
                })
                .collect();
        };
        let syntax = self
            .syntaxes
            .find_syntax_for_file(path)
            .ok()
            .flatten()
            .unwrap_or_else(|| self.syntaxes.find_syntax_plain_text());
        let mut highlighter = HighlightLines::new(syntax, syntect_theme);
        let mut output = Vec::new();
        for line in LinesWithEndings::from(text) {
            match highlighter.highlight_line(line, &self.syntaxes) {
                Ok(regions) => {
                    output.push(Line::from(
                        regions
                            .into_iter()
                            .map(|(style, chunk)| {
                                Span::styled(
                                    chunk.trim_end_matches('\n').to_string(),
                                    syntect_style(style),
                                )
                            })
                            .collect::<Vec<_>>(),
                    ));
                }
                Err(_) => output.push(Line::from(Span::styled(
                    line.trim_end_matches('\n').to_string(),
                    Style::default().fg(theme.text),
                ))),
            }
        }
        output
    }
}

fn syntect_style(style: SyntectStyle) -> Style {
    Style::default().fg(ratatui::style::Color::Rgb(
        style.foreground.r,
        style.foreground.g,
        style.foreground.b,
    ))
}

pub struct DiffView<'a> {
    pub parsed: &'a ParsedDiff,
    pub path: &'a str,
    pub reviewed: bool,
    pub selected: Option<usize>,
    pub theme: Theme,
    pub highlighter: &'a Highlighter,
}

pub fn render(frame: &mut Frame, area: Rect, view: DiffView<'_>, scroll: u16) {
    if area.height == 0 || area.width == 0 {
        return;
    }
    let theme = view.theme;
    // Sticky hunk header: the last hunk at or above the viewport top.
    let header = view
        .parsed
        .hunk_starts
        .iter()
        .rev()
        .find(|index| **index <= scroll as usize)
        .and_then(|index| view.parsed.lines.get(*index))
        .map(|line| line.text.clone());
    let header_height = u16::from(header.is_some() && area.height > 2);
    let body_area = Rect {
        y: area.y + header_height,
        height: area.height.saturating_sub(header_height),
        ..area
    };
    if let Some(header) = header {
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                truncate(&header, area.width as usize),
                Style::default()
                    .fg(theme.diff_hunk)
                    .add_modifier(Modifier::BOLD),
            )))
            .style(Style::default().bg(theme.raised)),
            Rect { height: 1, ..area },
        );
    }

    let visible = view
        .parsed
        .lines
        .iter()
        .enumerate()
        .skip(scroll as usize)
        .take(body_area.height as usize);
    let mut lines = Vec::new();
    for (index, line) in visible {
        let selected = view.selected == Some(index);
        lines.push(view.highlighter.render_diff_line(
            view.path,
            line,
            selected,
            theme,
            area.width as usize,
        ));
    }
    if lines.is_empty() {
        lines.push(Line::from(Span::styled(
            if view.reviewed {
                "Reviewed. No diff text for this file."
            } else {
                "No diff text for this file."
            },
            Style::default().fg(theme.dim),
        )));
    }
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().bg(theme.canvas))
            .wrap(Wrap { trim: false }),
        body_area,
    );
}

impl Highlighter {
    fn render_diff_line(
        &self,
        path: &str,
        line: &DiffLine,
        selected: bool,
        theme: Theme,
        width: usize,
    ) -> Line<'static> {
        let (foreground, background) = match line.kind {
            DiffLineKind::Added => (theme.success, theme.canvas),
            DiffLineKind::Removed => (theme.danger, theme.canvas),
            DiffLineKind::Hunk => (theme.diff_hunk, theme.raised),
            DiffLineKind::Header => (theme.muted, theme.canvas),
            DiffLineKind::Meta => (theme.dim, theme.canvas),
            DiffLineKind::Context => (theme.text, theme.canvas),
        };
        let background = if selected { theme.selected } else { background };
        let number = match (line.old_line, line.new_line) {
            (Some(old), Some(new)) => format!("{old:>4} {new:>4} "),
            (Some(old), None) => format!("{old:>4}      "),
            (None, Some(new)) => format!("     {new:>4} "),
            (None, None) => "          ".to_string(),
        };
        let mut spans = vec![Span::styled(
            number,
            Style::default().fg(theme.dim).bg(background),
        )];
        let content = match line.kind {
            DiffLineKind::Added | DiffLineKind::Removed | DiffLineKind::Context => {
                line.text.get(1..).unwrap_or_default()
            }
            _ => line.text.as_str(),
        };
        if matches!(
            line.kind,
            DiffLineKind::Added | DiffLineKind::Removed | DiffLineKind::Context
        ) && !content.trim().is_empty()
        {
            let prefix = line.text.chars().next().unwrap_or(' ');
            spans.push(Span::styled(
                prefix.to_string(),
                Style::default().fg(foreground).bg(background),
            ));
            let highlighted = self.highlight_fragment(path, content);
            if highlighted.is_empty() {
                spans.push(Span::styled(
                    truncate(content, width.saturating_sub(12)),
                    Style::default().fg(foreground).bg(background),
                ));
            } else {
                for (style, text) in highlighted {
                    spans.push(Span::styled(
                        text,
                        Style::default()
                            .fg(style.fg.unwrap_or(foreground))
                            .bg(background),
                    ));
                }
            }
        } else {
            spans.push(Span::styled(
                truncate(&line.text, width.saturating_sub(11)),
                Style::default().fg(foreground).bg(background),
            ));
        }
        Line::from(spans)
    }

    fn highlight_fragment(&self, path: &str, text: &str) -> Vec<(ratatui::style::Style, String)> {
        let Some(theme) = self.theme.as_ref() else {
            return Vec::new();
        };
        let syntax = self
            .syntaxes
            .find_syntax_for_file(path)
            .ok()
            .flatten()
            .unwrap_or_else(|| self.syntaxes.find_syntax_plain_text());
        let mut highlighter = HighlightLines::new(syntax, theme);
        match highlighter.highlight_line(&format!("{text}\n"), &self.syntaxes) {
            Ok(regions) => regions
                .into_iter()
                .map(|(style, chunk)| {
                    (
                        syntect_style(style),
                        chunk.trim_end_matches('\n').to_string(),
                    )
                })
                .collect(),
            Err(_) => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use stacks_core::diff::parse_unified;

    #[test]
    fn renders_added_and_removed_lines_with_line_numbers() {
        let parsed = parse_unified("@@ -1 +1 @@\n-old\n+new\n");
        let highlighter = Highlighter::new();
        let theme = crate::theme::theme(crate::theme::ColorDepth::Ansi16, None);
        let line = highlighter.render_diff_line("x.rs", &parsed.lines[1], false, theme, 80);
        let debug = format!("{line:?}");
        assert!(debug.contains("old"));
        assert!(debug.contains('1'));
        assert!(
            !highlighter
                .highlight_lines("x.rs", "fn main() {}", theme)
                .is_empty()
        );
    }
}
