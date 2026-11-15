//! Small, dependency-free widgets shared by the screens.

pub mod card_list;
pub mod diff_view;
pub mod hints;
pub mod markdown;
pub mod tabs;
pub mod text_input;

pub use text_input::{TextArea, TextInput, render_input, render_text_area};

use ratatui::{
    Frame,
    layout::{Alignment, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};

use crate::theme::Theme;

/// Escape a string for OSC 52. Long selections are truncated by most terminals;
/// 100 KiB is a safe ceiling.
pub fn osc52(text: &str) -> String {
    let limit = 100 * 1024;
    let text: String = text.chars().take(limit).collect();
    let encoded = base64(text.as_bytes());
    format!("\x1b]52;c;{encoded}\x07")
}

pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(ALPHABET[(first >> 2) as usize] as char);
        output.push(ALPHABET[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(ALPHABET[(((second & 0b0000_1111) << 2) | (third >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(ALPHABET[(third & 0b0011_1111) as usize] as char);
        } else {
            output.push('=');
        }
    }
    output
}

/// Horizontal rule with an optional inline label, lazygit-style section divider.
pub fn section_rule(frame: &mut Frame, area: Rect, label: &str, theme: Theme) {
    if area.height == 0 || area.width == 0 {
        return;
    }
    let width = area.width as usize;
    let text = if label.is_empty() {
        "─".repeat(width)
    } else {
        let label = format!("─ {label} ");
        let used = unicode_width::UnicodeWidthStr::width(label.as_str());
        format!("{label}{}", "─".repeat(width.saturating_sub(used)))
    };
    frame.render_widget(
        Paragraph::new(Span::styled(text, Style::default().fg(theme.muted)))
            .style(Style::default().bg(theme.canvas)),
        area,
    );
}

pub fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width.saturating_sub(2)).max(10);
    let height = height.min(area.height.saturating_sub(2)).max(3);
    Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + (area.height.saturating_sub(height)) / 2,
        width,
        height,
    }
}

pub fn modal(frame: &mut Frame, area: Rect, title: &str, theme: Theme) {
    frame.render_widget(Clear, area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme.muted))
        .style(Style::default().bg(theme.panel))
        .title(Span::styled(
            format!(" {title} "),
            Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
        ));
    frame.render_widget(block, area);
}

pub fn message(frame: &mut Frame, area: Rect, title: &str, body: &str, theme: Theme) {
    let area = centered(area, area.width.saturating_sub(8).max(30), 9);
    modal(frame, area, title, theme);
    let inner = area.inner(ratatui::layout::Margin::new(1, 1));
    frame.render_widget(
        Paragraph::new(body)
            .style(Style::default().fg(theme.text))
            .wrap(Wrap { trim: false }),
        inner,
    );
}

pub fn centered_message(frame: &mut Frame, area: Rect, title: &str, body: &str, theme: Theme) {
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(
                title,
                Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
            )),
            Line::from(""),
            Line::from(Span::styled(body, Style::default().fg(theme.muted))),
        ])
        .alignment(Alignment::Center)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(theme.muted))
                .style(Style::default().bg(theme.panel)),
        ),
        area,
    );
}

pub fn truncate(text: &str, width: usize) -> String {
    use unicode_width::UnicodeWidthStr;
    if width == 0 {
        return String::new();
    }
    if UnicodeWidthStr::width(text) <= width {
        return text.to_string();
    }
    let mut result = String::new();
    let mut used = 0;
    for character in text.chars() {
        let character_width = unicode_width::UnicodeWidthChar::width(character).unwrap_or(0);
        if used + character_width > width.saturating_sub(1) {
            break;
        }
        used += character_width;
        result.push(character);
    }
    result.push('…');
    result
}

pub fn wrap(text: &str, width: usize) -> Vec<String> {
    use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};
    let width = width.max(1);
    let mut lines = Vec::new();
    for raw in text.split('\n') {
        if raw.is_empty() {
            lines.push(String::new());
            continue;
        }
        let leading = raw.len() - raw.trim_start_matches(' ').len();
        let indent = &raw[..leading];
        let content = &raw[leading..];
        let mut current = indent.to_string();
        let mut used = UnicodeWidthStr::width(indent);
        for word in content.split(' ').filter(|word| !word.is_empty()) {
            let word_width = UnicodeWidthStr::width(word);
            let needs_space = !current.trim().is_empty();
            if used + usize::from(needs_space) + word_width <= width {
                if needs_space {
                    current.push(' ');
                    used += 1;
                }
                current.push_str(word);
                used += word_width;
                continue;
            }
            if !current.trim().is_empty() {
                lines.push(current.trim_end().to_string());
            }
            current.clear();
            if word_width <= width {
                current.push_str(word);
                used = word_width;
                continue;
            }
            // A single word longer than the viewport: hard-break it.
            let mut chunk = String::new();
            let mut chunk_width = 0;
            for character in word.chars() {
                let character_width = UnicodeWidthChar::width(character).unwrap_or(0);
                if chunk_width + character_width > width && !chunk.is_empty() {
                    lines.push(std::mem::take(&mut chunk));
                    chunk_width = 0;
                }
                chunk.push(character);
                chunk_width += character_width;
            }
            current = chunk;
            used = chunk_width;
        }
        if !current.is_empty() || lines.is_empty() {
            lines.push(current);
        }
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"hello"), "aGVsbG8=");
    }

    #[test]
    fn truncation_respects_cell_width() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello", 3), "he…");
        assert_eq!(truncate("日本語", 4), "日…");
    }

    #[test]
    fn wrapping_splits_on_display_width() {
        assert_eq!(wrap("abc def", 4), vec!["abc", "def"]);
        assert_eq!(wrap("abc   def", 5), vec!["abc", "def"]);
        assert_eq!(wrap("  indented line", 8), vec!["indented", "line"]);
        assert_eq!(wrap("a\nb", 10), vec!["a", "b"]);
    }
}
