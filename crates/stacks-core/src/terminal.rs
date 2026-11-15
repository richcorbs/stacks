//! Terminal emulation behind a small trait.
//!
//! `vt100` is the initial backend. The trait is deliberately cell-oriented so
//! `libghostty-vt` (card #318's documented upgrade path) can replace it without
//! touching the TUI renderer.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TermColor {
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalCell {
    pub text: String,
    pub fg: TermColor,
    pub bg: TermColor,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
    pub wide: bool,
    pub wide_continuation: bool,
}

pub trait TerminalScreen {
    fn size(&self) -> (u16, u16);
    fn process(&mut self, bytes: &[u8]);
    fn resize(&mut self, cols: u16, rows: u16);
    fn cell(&self, row: u16, col: u16) -> Option<TerminalCell>;
    fn cursor(&self) -> Option<(u16, u16)>;
    fn contents(&self) -> String;
    fn scrollback_len(&self) -> usize;
    fn scroll(&mut self, offset_from_bottom: usize);
    fn scroll_offset(&self) -> usize;
    fn alternate_screen(&self) -> bool;
    fn application_cursor(&self) -> bool;
}

pub struct Vt100Screen {
    parser: vt100::Parser,
    cols: u16,
    rows: u16,
    offset: usize,
}

impl Vt100Screen {
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Self {
        let cols = cols.max(2);
        let rows = rows.max(1);
        Self {
            parser: vt100::Parser::new(rows, cols, scrollback),
            cols,
            rows,
            offset: 0,
        }
    }

    fn color(value: vt100::Color) -> TermColor {
        match value {
            vt100::Color::Default => TermColor::Default,
            vt100::Color::Idx(index) => TermColor::Indexed(index),
            vt100::Color::Rgb(red, green, blue) => TermColor::Rgb(red, green, blue),
        }
    }
}

impl TerminalScreen for Vt100Screen {
    fn size(&self) -> (u16, u16) {
        (self.cols, self.rows)
    }

    fn process(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
        if self.offset > 0 {
            // Follow live output unless the user deliberately scrolled up.
            self.parser.set_scrollback(self.offset);
        }
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        let cols = cols.max(2);
        let rows = rows.max(1);
        if (cols, rows) == (self.cols, self.rows) {
            return;
        }
        self.cols = cols;
        self.rows = rows;
        self.parser.set_size(rows, cols);
    }

    fn cell(&self, row: u16, col: u16) -> Option<TerminalCell> {
        let cell = self.parser.screen().cell(row, col)?;
        Some(TerminalCell {
            text: cell.contents(),
            fg: Self::color(cell.fgcolor()),
            bg: Self::color(cell.bgcolor()),
            bold: cell.bold(),
            italic: cell.italic(),
            underline: cell.underline(),
            inverse: cell.inverse(),
            wide: cell.is_wide(),
            wide_continuation: cell.is_wide_continuation(),
        })
    }

    fn cursor(&self) -> Option<(u16, u16)> {
        let screen = self.parser.screen();
        if screen.hide_cursor() {
            return None;
        }
        let (row, col) = screen.cursor_position();
        Some((row, col))
    }

    fn contents(&self) -> String {
        self.parser.screen().contents()
    }

    fn scrollback_len(&self) -> usize {
        self.parser.screen().scrollback()
    }

    fn scroll(&mut self, offset_from_bottom: usize) {
        self.offset = offset_from_bottom;
        self.parser.set_scrollback(offset_from_bottom);
    }

    fn scroll_offset(&self) -> usize {
        self.offset
    }

    fn alternate_screen(&self) -> bool {
        self.parser.screen().alternate_screen()
    }

    fn application_cursor(&self) -> bool {
        self.parser.screen().application_cursor()
    }
}

/// Encode the key sequences a shell/readline expects. `application_cursor`
/// switches arrows and Home/End to SS3 (`ESC O x`) like xterm.
pub fn encode_key(key: Key, application_cursor: bool, alt: bool) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    if alt && !matches!(key, Key::Alt(_)) {
        out.push(0x1b);
    }
    match key {
        Key::Char(character) => {
            let mut buffer = [0u8; 4];
            out.extend_from_slice(character.encode_utf8(&mut buffer).as_bytes());
        }
        Key::Enter => out.push(b'\r'),
        Key::Tab => out.push(b'\t'),
        Key::BackTab => out.extend_from_slice(b"\x1b[Z"),
        Key::Backspace => out.push(0x7f),
        Key::Esc => out.push(0x1b),
        Key::Up => out.extend_from_slice(if application_cursor {
            b"\x1bOA"
        } else {
            b"\x1b[A"
        }),
        Key::Down => out.extend_from_slice(if application_cursor {
            b"\x1bOB"
        } else {
            b"\x1b[B"
        }),
        Key::Right => out.extend_from_slice(if application_cursor {
            b"\x1bOC"
        } else {
            b"\x1b[C"
        }),
        Key::Left => out.extend_from_slice(if application_cursor {
            b"\x1bOD"
        } else {
            b"\x1b[D"
        }),
        Key::Home => out.extend_from_slice(if application_cursor {
            b"\x1bOH"
        } else {
            b"\x1b[H"
        }),
        Key::End => out.extend_from_slice(if application_cursor {
            b"\x1bOF"
        } else {
            b"\x1b[F"
        }),
        Key::PageUp => out.extend_from_slice(b"\x1b[5~"),
        Key::PageDown => out.extend_from_slice(b"\x1b[6~"),
        Key::Insert => out.extend_from_slice(b"\x1b[2~"),
        Key::Delete => out.extend_from_slice(b"\x1b[3~"),
        Key::F(number) => {
            let sequence: &[u8] = match number {
                1 => b"\x1bOP",
                2 => b"\x1bOQ",
                3 => b"\x1bOR",
                4 => b"\x1bOS",
                5 => b"\x1b[15~",
                6 => b"\x1b[17~",
                7 => b"\x1b[18~",
                8 => b"\x1b[19~",
                9 => b"\x1b[20~",
                10 => b"\x1b[21~",
                11 => b"\x1b[23~",
                12 => b"\x1b[24~",
                _ => return None,
            };
            out.extend_from_slice(sequence);
        }
        Key::Ctrl(character) => {
            let byte = match character {
                'a'..='z' => character as u8 - b'a' + 1,
                'A'..='Z' => character as u8 - b'A' + 1,
                '[' => 0x1b,
                '\\' => 0x1c,
                ']' => 0x1d,
                '^' => 0x1e,
                '_' => 0x1f,
                '@' => 0x00,
                ' ' => 0x00,
                _ => return None,
            };
            out.push(byte);
        }
        Key::Alt(character) => {
            out.push(0x1b);
            out.push(character as u8);
        }
        Key::Paste => return None,
    }
    Some(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Enter,
    Tab,
    BackTab,
    Backspace,
    Esc,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Insert,
    Delete,
    F(u8),
    Ctrl(char),
    Alt(char),
    Paste,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_ansi_content_and_colors() {
        let mut screen = Vt100Screen::new(20, 4, 100);
        screen.process(b"\x1b[31mred\x1b[0m plain");
        let row: String = (0..5)
            .filter_map(|col| screen.cell(0, col))
            .map(|cell| cell.text)
            .collect();
        assert_eq!(row, "red p");
        assert_eq!(screen.cell(0, 0).unwrap().fg, TermColor::Indexed(1));
        assert_eq!(screen.cell(0, 3).unwrap().fg, TermColor::Default);
        assert!(screen.contents().contains("red plain"));
    }

    #[test]
    fn resize_keeps_the_screen_usable() {
        let mut screen = Vt100Screen::new(10, 3, 10);
        screen.process(b"hello");
        screen.resize(40, 10);
        assert_eq!(screen.size(), (40, 10));
        assert!(screen.contents().contains("hello"));
    }

    #[test]
    fn tracks_application_cursor_and_alternate_screen() {
        let mut screen = Vt100Screen::new(20, 4, 10);
        assert!(!screen.application_cursor());
        screen.process(b"\x1b[?1h\x1b[?1049h");
        assert!(screen.application_cursor());
        assert!(screen.alternate_screen());
        assert_eq!(
            encode_key(Key::Up, screen.application_cursor(), false),
            Some(b"\x1bOA".to_vec())
        );
    }

    #[test]
    fn encodes_common_keys() {
        assert_eq!(encode_key(Key::Enter, false, false), Some(b"\r".to_vec()));
        assert_eq!(encode_key(Key::Ctrl('c'), false, false), Some(vec![3]));
        assert_eq!(encode_key(Key::Up, true, false), Some(b"\x1bOA".to_vec()));
        assert_eq!(
            encode_key(Key::Alt('b'), false, true),
            Some(b"\x1bb".to_vec())
        );
        assert_eq!(encode_key(Key::Paste, false, false), None);
    }
}
