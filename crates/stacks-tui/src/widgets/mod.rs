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
    use unicode_width::UnicodeWidthChar;
    let width = width.max(1);
    let mut lines = Vec::new();
    for raw in text.split('\n') {
        let mut line = String::new();
        let mut used = 0;
        for character in raw.chars() {
            if character == '\t' {
                let spaces = 4 - (used % 4);
                for _ in 0..spaces {
                    line.push(' ');
                }
                used += spaces;
                continue;
            }
            let character_width = UnicodeWidthChar::width(character).unwrap_or(0);
            if used + character_width > width && used > 0 {
                while line.ends_with(' ') {
                    line.pop();
                }
                lines.push(std::mem::take(&mut line));
                used = 0;
            }
            line.push(character);
            used += character_width;
        }
        lines.push(line);
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
        assert_eq!(wrap("a\nb", 10), vec!["a", "b"]);
    }
}
