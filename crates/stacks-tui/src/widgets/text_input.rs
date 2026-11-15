//! Single-line and multi-line editors.
//!
//! Deliberately small: no history, no IME (xterm owns the terminal side). The
//! important behaviour is that typed text is never discarded by `Esc`.

use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
};

use crate::keys::Key;
use crate::theme::Theme;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TextInput {
    pub value: String,
    pub cursor: usize,
}

impl TextInput {
    pub fn new(value: impl Into<String>) -> Self {
        let value = value.into();
        let cursor = value.chars().count();
        Self { value, cursor }
    }

    pub fn with_cursor(mut self, cursor: usize) -> Self {
        self.cursor = cursor.min(self.value.chars().count());
        self
    }

    pub fn clear(&mut self) {
        self.value.clear();
        self.cursor = 0;
    }

    pub fn is_empty(&self) -> bool {
        self.value.trim().is_empty()
    }

    pub fn insert_str(&mut self, text: &str) {
        let byte = byte_index(&self.value, self.cursor);
        self.value.insert_str(byte, text);
        self.cursor += text.chars().count();
    }

    pub fn insert_char(&mut self, character: char) {
        let byte = byte_index(&self.value, self.cursor);
        self.value.insert(byte, character);
        self.cursor += 1;
    }

    pub fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let end = byte_index(&self.value, self.cursor);
        let start = byte_index(&self.value, self.cursor - 1);
        self.value.replace_range(start..end, "");
        self.cursor -= 1;
    }

    pub fn delete(&mut self) {
        if self.cursor >= self.value.chars().count() {
            return;
        }
        let start = byte_index(&self.value, self.cursor);
        let end = byte_index(&self.value, self.cursor + 1);
        self.value.replace_range(start..end, "");
    }

    pub fn left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn right(&mut self) {
        self.cursor = (self.cursor + 1).min(self.value.chars().count());
    }

    pub fn home(&mut self) {
        self.cursor = 0;
    }

    pub fn end(&mut self) {
        self.cursor = self.value.chars().count();
    }

    pub fn handle(&mut self, key: &Key) -> bool {
        match key {
            Key::Char(character) => self.insert_char(*character),
            Key::Ctrl('u') => self.clear(),
            Key::Ctrl('w') => {
                while self.cursor > 0 {
                    let previous = self.value.chars().nth(self.cursor - 1).unwrap_or(' ');
                    self.backspace();
                    if previous.is_whitespace() {
                        break;
                    }
                }
            }
            Key::Backspace => self.backspace(),
            Key::Delete => self.delete(),
            Key::Left => self.left(),
            Key::Right => self.right(),
            Key::Home => self.home(),
            Key::End => self.end(),
            Key::Paste(text) => self.insert_str(text),
            _ => return false,
        }
        true
    }
}

fn byte_index(value: &str, character_index: usize) -> usize {
    value
        .char_indices()
        .nth(character_index)
        .map(|(index, _)| index)
        .unwrap_or(value.len())
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TextArea {
    pub value: String,
    pub cursor: usize,
}

impl TextArea {
    pub fn new(value: impl Into<String>) -> Self {
        let value = value.into();
        let cursor = value.chars().count();
        Self { value, cursor }
    }

    pub fn is_empty(&self) -> bool {
        self.value.trim().is_empty()
    }

    pub fn lines(&self) -> Vec<String> {
        self.value.split('\n').map(str::to_string).collect()
    }

    pub fn cursor_line_column(&self) -> (usize, usize) {
        let mut line = 0;
        let mut column = 0;
        for character in self.value.chars().take(self.cursor) {
            if character == '\n' {
                line += 1;
                column = 0;
            } else {
                column += 1;
            }
        }
        (line, column)
    }

    pub fn handle(&mut self, key: &Key) -> bool {
        match key {
            Key::Alt('m') => self.insert_char('\n'),
            Key::Char(character) => self.insert_char(*character),
            Key::Ctrl('u') => {
                self.value.clear();
                self.cursor = 0;
            }
            Key::Backspace => self.backspace(),
            Key::Delete => self.delete(),
            Key::Left => self.cursor = self.cursor.saturating_sub(1),
            Key::Right => self.cursor = (self.cursor + 1).min(self.value.chars().count()),
            Key::Up => self.vertical(-1),
            Key::Down => self.vertical(1),
            Key::Home => {
                let (line, _) = self.cursor_line_column();
                self.cursor = self.line_start(line);
            }
            Key::End => {
                let (line, _) = self.cursor_line_column();
                self.cursor = self.line_end(line);
            }
            Key::Enter => self.insert_char('\n'),
            Key::Paste(text) => self.insert_str(text),
            _ => return false,
        }
        true
    }

    pub fn insert_str(&mut self, text: &str) {
        let byte = byte_index(&self.value, self.cursor);
        self.value.insert_str(byte, text);
        self.cursor += text.chars().count();
    }

    pub fn insert_char(&mut self, character: char) {
        let byte = byte_index(&self.value, self.cursor);
        self.value.insert(byte, character);
        self.cursor += 1;
    }

    pub fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let end = byte_index(&self.value, self.cursor);
        let start = byte_index(&self.value, self.cursor - 1);
        self.value.replace_range(start..end, "");
        self.cursor -= 1;
    }

    pub fn delete(&mut self) {
        if self.cursor >= self.value.chars().count() {
            return;
        }
        let start = byte_index(&self.value, self.cursor);
        let end = byte_index(&self.value, self.cursor + 1);
        self.value.replace_range(start..end, "");
    }

    /// Pressing Backspace/Delete across lines still behaves like one text field.
    fn vertical(&mut self, direction: i32) {
        let (line, column) = self.cursor_line_column();
        let target = line as i32 + direction;
        let lines = self.lines();
        if target < 0 || target >= lines.len() as i32 {
            return;
        }
        let target = target as usize;
        let new_column = column.min(lines[target].chars().count());
        self.cursor = self.line_start(target) + new_column;
    }

    fn line_start(&self, line: usize) -> usize {
        self.value
            .split('\n')
            .take(line)
            .map(|line| line.chars().count() + 1)
            .sum()
    }

    fn line_end(&self, line: usize) -> usize {
        self.line_start(line)
            + self
                .value
                .split('\n')
                .nth(line)
                .map(|line| line.chars().count())
                .unwrap_or(0)
    }
}

pub fn render_input(
    frame: &mut Frame,
    area: Rect,
    input: &TextInput,
    title: &str,
    focused: bool,
    theme: Theme,
) {
    let style = Style::default().fg(theme.text);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(if focused { theme.accent } else { theme.muted }))
        .style(Style::default().bg(theme.raised))
        .title(Span::styled(
            format!(" {title} "),
            Style::default().fg(theme.muted),
        ));
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut spans = vec![Span::styled(input.value.clone(), style)];
    if focused {
        let (before, after) = split_at(&input.value, input.cursor);
        spans = if let Some(character) = after.chars().next() {
            vec![
                Span::styled(before, style),
                Span::styled(
                    character.to_string(),
                    style.add_modifier(Modifier::REVERSED),
                ),
                Span::styled(after.chars().skip(1).collect::<String>(), style),
            ]
        } else {
            vec![
                Span::styled(before, style),
                Span::styled(" ", style.add_modifier(Modifier::REVERSED)),
            ]
        };
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), inner);
}

pub fn render_text_area(
    frame: &mut Frame,
    area: Rect,
    value: &str,
    cursor: Option<usize>,
    title: &str,
    focused: bool,
    theme: Theme,
) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(if focused { theme.accent } else { theme.muted }))
        .style(Style::default().bg(theme.raised))
        .title(Span::styled(
            format!(" {title} "),
            Style::default().fg(theme.muted),
        ));
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines = Vec::new();
    let mut offset = 0usize;
    for (index, line) in value.split('\n').enumerate() {
        let line_length = line.chars().count();
        let show_cursor =
            cursor.is_some_and(|cursor| cursor >= offset && cursor <= offset + line_length);
        if show_cursor {
            let column = cursor.unwrap_or(0) - offset;
            let (before, after) = split_at(line, column);
            let mut spans = vec![Span::styled(
                before.to_string(),
                Style::default().fg(theme.text),
            )];
            if let Some(character) = after.chars().next() {
                spans.push(Span::styled(
                    character.to_string(),
                    Style::default()
                        .fg(theme.text)
                        .add_modifier(Modifier::REVERSED),
                ));
                spans.push(Span::styled(
                    after.chars().skip(1).collect::<String>(),
                    Style::default().fg(theme.text),
                ));
            } else {
                spans.push(Span::styled(
                    " ",
                    Style::default()
                        .fg(theme.text)
                        .add_modifier(Modifier::REVERSED),
                ));
            }
            lines.push(Line::from(spans));
        } else {
            lines.push(Line::from(Span::styled(
                line.to_string(),
                Style::default().fg(theme.text),
            )));
        }
        offset += line_length + 1;
        let _ = index;
    }
    let scroll = cursor.map(|_| 0).unwrap_or_default();
    frame.render_widget(
        Paragraph::new(lines)
            .scroll((scroll, 0))
            .style(Style::default().bg(theme.raised)),
        inner,
    );
}

fn split_at(value: &str, character_index: usize) -> (&str, &str) {
    let byte = byte_index(value, character_index);
    (&value[..byte], &value[byte..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_editing_handles_unicode_boundaries() {
        let mut input = TextInput::new("aé日");
        input.left();
        input.backspace();
        assert_eq!(input.value, "a日");
        input.home();
        input.insert_char('x');
        assert_eq!(input.value, "xa日");
        input.end();
        input.delete();
        assert_eq!(input.value, "xa日");
    }

    #[test]
    fn text_area_tracks_lines_and_vertical_motion() {
        let mut area = TextArea::new("one\ntwo\nthree");
        assert_eq!(area.cursor_line_column(), (2, 5));
        area.handle(&Key::Up);
        assert_eq!(area.cursor_line_column(), (1, 3));
        area.handle(&Key::Home);
        assert_eq!(area.cursor_line_column(), (1, 0));
        area.handle(&Key::End);
        assert_eq!(area.cursor_line_column(), (1, 3));
        area.handle(&Key::Enter);
        assert_eq!(area.lines().len(), 4);
    }
}
