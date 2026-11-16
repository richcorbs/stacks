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
            output.push(inline(&line, theme));
        }
    }
    output
}

/// Card descriptions from Superthread arrive as HTML; local descriptions are
/// Markdown. Convert provider HTML into a small Markdown subset before using
/// the normal reading renderer.
pub fn card_lines(content: &str, width: usize, theme: Theme) -> Vec<Line<'static>> {
    let source = if looks_like_html(content) {
        html_to_markdown(content)
    } else {
        content.to_string()
    };
    lines(&source, width, theme)
}

fn looks_like_html(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [
        "<p>", "<p ", "<h1", "<h2", "<h3", "<h4", "<h5", "<h6", "<div", "<br", "<ul", "<ol", "<li",
        "<strong", "<em", "<code", "<a ",
    ]
    .iter()
    .any(|tag| lower.contains(tag))
}

fn html_to_markdown(value: &str) -> String {
    let mut output = String::new();
    let mut index = 0;
    while let Some(start) = value[index..].find('<') {
        let start = index + start;
        output.push_str(&decode_entities(&value[index..start]));
        let Some(end) = value[start..].find('>') else {
            output.push_str(&value[start..]);
            return output;
        };
        let end = start + end;
        let tag = value[start + 1..end].trim().to_ascii_lowercase();
        let name = tag
            .trim_start_matches('/')
            .split_whitespace()
            .next()
            .unwrap_or_default();
        let closing = tag.starts_with('/');
        match name {
            "p" | "div" | "br" | "ul" | "ol" | "tr" => output.push('\n'),
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let level = name[1..].parse::<usize>().unwrap_or(1).min(6);
                output.push_str("\n");
                output.push_str(&"#".repeat(level));
                output.push(' ');
            }
            "li" => {
                if !closing {
                    output.push_str("\n- ");
                } else {
                    output.push('\n');
                }
            }
            "strong" | "b" if !closing => output.push_str("**"),
            "strong" | "b" if closing => output.push_str("**"),
            "em" | "i" if !closing => output.push('*'),
            "em" | "i" if closing => output.push('*'),
            "code" if !closing => output.push('`'),
            "code" if closing => output.push('`'),
            _ => {}
        }
        index = end + 1;
    }
    output.push_str(&decode_entities(&value[index..]));
    let mut cleaned = String::new();
    for line in output.lines() {
        let trimmed = line.trim_end();
        if trimmed.trim().is_empty() {
            if !cleaned.ends_with("\n\n") && !cleaned.is_empty() {
                cleaned.push_str("\n\n");
            }
        } else {
            cleaned.push_str(trimmed);
            cleaned.push('\n');
        }
    }
    cleaned.trim().to_string()
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

fn inline(line: &str, theme: Theme) -> Line<'static> {
    let mut spans = Vec::new();
    let mut rest = line;
    let mut bold = false;
    while !rest.is_empty() {
        let code = rest.find('`');
        let emphasis = rest.find("**");
        let next = match (code, emphasis) {
            (Some(code), Some(emphasis)) if emphasis < code => Some((emphasis, SpanKind::Emphasis)),
            (Some(code), _) => Some((code, SpanKind::Code)),
            (None, Some(emphasis)) => Some((emphasis, SpanKind::Emphasis)),
            (None, None) => None,
        };
        let Some((index, kind)) = next else {
            push_text(&mut spans, rest, bold, theme);
            break;
        };
        let (before, after) = rest.split_at(index);
        push_text(&mut spans, before, bold, theme);
        match kind {
            SpanKind::Code => {
                let after = &after[1..];
                if let Some(end) = after.find('`') {
                    spans.push(Span::styled(
                        after[..end].to_string(),
                        Style::default().fg(theme.info).bg(theme.raised),
                    ));
                    rest = &after[end + 1..];
                } else {
                    push_text(&mut spans, &format!("`{after}"), bold, theme);
                    rest = "";
                }
            }
            SpanKind::Emphasis => {
                bold = !bold;
                rest = &after[2..];
            }
        }
    }
    Line::from(spans)
}

#[derive(Clone, Copy)]
enum SpanKind {
    Code,
    Emphasis,
}

fn push_text(spans: &mut Vec<Span<'static>>, text: &str, bold: bool, theme: Theme) {
    if text.is_empty() {
        return;
    }
    let mut style = Style::default().fg(theme.text);
    if bold {
        style = style.add_modifier(Modifier::BOLD);
    }
    spans.push(Span::styled(text.to_string(), style));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::ColorDepth;

    #[test]
    fn converts_provider_html_to_readable_markdown() {
        let converted = html_to_markdown(
            "<h2>Overview</h2><p>Replace <strong>files</strong> with URLs &amp; keep <code>id</code>.</p><ul><li>one</li><li>two</li></ul>",
        );
        assert!(converted.contains("## Overview"), "{converted}");
        assert!(converted.contains("**files**"), "{converted}");
        assert!(converted.contains("URLs & keep"), "{converted}");
        assert!(converted.contains("- one"), "{converted}");
        assert!(!converted.contains("<h2>"), "{converted}");
    }

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
