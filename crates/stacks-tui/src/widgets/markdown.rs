//! Tiny Markdown presentation for card descriptions and chat text.
//!
//! This is a reading surface: headings, lists, quotes, fences and inline code
//! become styled lines. It intentionally does not render images or HTML.

use ratatui::{
    style::{Modifier, Style},
    text::{Line, Span},
};
use unicode_width::UnicodeWidthStr;

use crate::theme::Theme;
use crate::widgets::wrap;

pub fn lines(markdown: &str, width: usize, theme: Theme) -> Vec<Line<'static>> {
    let mut output = Vec::new();
    let mut in_code = false;
    for raw in markdown.lines() {
        if raw.trim_start().starts_with("```") {
            in_code = !in_code;
            let language = raw.trim().trim_start_matches('`').trim();
            let label = if in_code && !language.is_empty() {
                format!("─ {language} ")
            } else if in_code {
                "─ code ".to_string()
            } else {
                "─".to_string()
            };
            output.push(Line::from(Span::styled(
                format!("{label}{}", "─".repeat(width.saturating_sub(label.width()))),
                Style::default().fg(theme.dim),
            )));
            continue;
        }
        if in_code {
            for line in wrap(raw, width.saturating_sub(2)) {
                output.push(Line::from(Span::styled(
                    format!("  {line}"),
                    Style::default().fg(theme.info),
                )));
            }
            continue;
        }
        if raw.starts_with('#') {
            let text = raw.trim_start_matches('#').trim();
            let level = raw
                .chars()
                .take_while(|character| *character == '#')
                .count();
            for line in wrap(text, width.saturating_sub(level)) {
                output.push(Line::from(Span::styled(
                    line,
                    Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
                )));
            }
            continue;
        }
        if raw.starts_with('>') {
            let text = raw.trim_start_matches('>').trim();
            for line in wrap(text, width.saturating_sub(2)) {
                output.push(Line::from(Span::styled(
                    format!("│ {line}"),
                    Style::default().fg(theme.muted),
                )));
            }
            continue;
        }
        let trimmed = raw.trim_start();
        if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            let text = &trimmed[2..];
            for (index, line) in wrap(text, width.saturating_sub(2)).into_iter().enumerate() {
                output.push(Line::from(Span::styled(
                    format!("{}{}", if index == 0 { "• " } else { "  " }, line),
                    Style::default().fg(theme.text),
                )));
            }
            continue;
        }
        if raw.trim().is_empty() {
            output.push(Line::from(""));
            continue;
        }
        for line in wrap(raw, width) {
            output.push(inline_code(&line, theme));
        }
    }
    output
}

fn inline_code(line: &str, theme: Theme) -> Line<'static> {
    let mut spans = Vec::new();
    let mut rest = line;
    while let Some(start) = rest.find('`') {
        let (before, after) = rest.split_at(start);
        if !before.is_empty() {
            spans.push(Span::styled(
                before.to_string(),
                Style::default().fg(theme.text),
            ));
        }
        let after = &after[1..];
        if let Some(end) = after.find('`') {
            spans.push(Span::styled(
                after[..end].to_string(),
                Style::default().fg(theme.info).bg(theme.raised),
            ));
            rest = &after[end + 1..];
        } else {
            spans.push(Span::styled(
                format!("`{after}"),
                Style::default().fg(theme.text),
            ));
            rest = "";
            break;
        }
    }
    if !rest.is_empty() {
        spans.push(Span::styled(
            rest.to_string(),
            Style::default().fg(theme.text),
        ));
    }
    Line::from(spans)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::ColorDepth;

    #[test]
    fn renders_headings_lists_and_fences() {
        let theme = crate::theme::theme(ColorDepth::Ansi16, None);
        let rendered = lines("# Title\n- one\n```rs\nlet x = 1;\n```", 40, theme);
        assert!(
            rendered
                .iter()
                .any(|line| format!("{line:?}").contains("Title"))
        );
        assert!(
            rendered
                .iter()
                .any(|line| format!("{line:?}").contains("one"))
        );
        assert!(
            rendered
                .iter()
                .any(|line| format!("{line:?}").contains("let x"))
        );
    }
}
