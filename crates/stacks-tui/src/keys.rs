//! Key vocabulary, script parsing and the single keymap table.
//!
//! `help.rs` renders [`KEYMAP`] verbatim, so a binding cannot exist in code
//! without appearing in help (and the golden test fails if the table drifts).

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Ctrl(char),
    Alt(char),
    Enter,
    Esc,
    Tab,
    BackTab,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Backspace,
    Delete,
    Insert,
    F(u8),
    Paste(String),
}

impl Key {
    pub fn from_event(event: KeyEvent) -> Option<Self> {
        if !matches!(
            event.kind,
            crossterm::event::KeyEventKind::Press | crossterm::event::KeyEventKind::Repeat
        ) {
            return None;
        }
        let modifiers = event.modifiers;
        let ctrl = modifiers.contains(KeyModifiers::CONTROL);
        let alt = modifiers.contains(KeyModifiers::ALT);
        let shift = modifiers.contains(KeyModifiers::SHIFT);
        Some(match event.code {
            KeyCode::Char(character) => {
                if ctrl {
                    Key::Ctrl(character.to_ascii_lowercase())
                } else if alt {
                    Key::Alt(character)
                } else {
                    Key::Char(character)
                }
            }
            KeyCode::Enter => Key::Enter,
            KeyCode::Esc => Key::Esc,
            KeyCode::Tab if shift => Key::BackTab,
            KeyCode::Tab => Key::Tab,
            KeyCode::BackTab => Key::BackTab,
            KeyCode::Up => Key::Up,
            KeyCode::Down => Key::Down,
            KeyCode::Left => Key::Left,
            KeyCode::Right => Key::Right,
            KeyCode::Home => Key::Home,
            KeyCode::End => Key::End,
            KeyCode::PageUp => Key::PageUp,
            KeyCode::PageDown => Key::PageDown,
            KeyCode::Backspace => Key::Backspace,
            KeyCode::Delete => Key::Delete,
            KeyCode::Insert => Key::Insert,
            KeyCode::F(number) => Key::F(number),
            KeyCode::Null => Key::Char(' '),
            _ => return None,
        })
    }

    /// Parse a `--script` token (`key ctrl-p`, `type Arcasa`).
    pub fn parse(token: &str) -> Option<Self> {
        let token = token.trim();
        if token.is_empty() {
            return None;
        }
        let lower = token.to_ascii_lowercase();
        Some(match lower.as_str() {
            "enter" | "return" => Key::Enter,
            "esc" | "escape" => Key::Esc,
            "tab" => Key::Tab,
            "backtab" | "shift-tab" => Key::BackTab,
            "up" => Key::Up,
            "down" => Key::Down,
            "left" => Key::Left,
            "right" => Key::Right,
            "home" => Key::Home,
            "end" => Key::End,
            "pageup" | "pgup" => Key::PageUp,
            "pagedown" | "pgdn" => Key::PageDown,
            "backspace" => Key::Backspace,
            "delete" | "del" => Key::Delete,
            "insert" => Key::Insert,
            "space" => Key::Char(' '),
            _ if lower.starts_with("ctrl-") => {
                let rest = &token[5..];
                let mut chars = rest.chars();
                let character = chars.next()?;
                if chars.next().is_some() {
                    return None;
                }
                Key::Ctrl(character.to_ascii_lowercase())
            }
            _ if lower.starts_with("alt-") => Key::Alt(token[4..].chars().next()?),
            _ if lower.starts_with('f') && lower[1..].parse::<u8>().is_ok() => {
                Key::F(lower[1..].parse().ok()?)
            }
            _ => {
                let mut chars = token.chars();
                let character = chars.next()?;
                if chars.next().is_some() {
                    return None;
                }
                Key::Char(character)
            }
        })
    }

    pub fn describe(&self) -> String {
        match self {
            Key::Char(' ') => "Space".into(),
            Key::Char(character) => character.to_string(),
            Key::Ctrl(character) => format!("Ctrl-{}", character.to_ascii_uppercase()),
            Key::Alt(character) => format!("Alt-{character}"),
            Key::Enter => "Enter".into(),
            Key::Esc => "Esc".into(),
            Key::Tab => "Tab".into(),
            Key::BackTab => "Shift-Tab".into(),
            Key::Up => "↑".into(),
            Key::Down => "↓".into(),
            Key::Left => "←".into(),
            Key::Right => "→".into(),
            Key::Home => "Home".into(),
            Key::End => "End".into(),
            Key::PageUp => "PgUp".into(),
            Key::PageDown => "PgDn".into(),
            Key::Backspace => "Backspace".into(),
            Key::Delete => "Del".into(),
            Key::Insert => "Ins".into(),
            Key::F(number) => format!("F{number}"),
            Key::Paste(_) => "Paste".into(),
        }
    }
}

pub struct KeyHelp {
    pub group: &'static str,
    pub entries: &'static [(&'static str, &'static str)],
}

/// The single source of truth for `help.rs` and the palette's action list.
pub const KEYMAP: &[KeyHelp] = &[
    KeyHelp {
        group: "Global",
        entries: &[
            ("Ctrl-Q", "Quit (confirms work in flight)"),
            ("?", "Help"),
            ("Ctrl-P / :", "Command palette"),
            ("Ctrl-O", "Project switcher"),
            ("Ctrl-G", "Global terminal"),
            ("Ctrl-R", "Refresh"),
            ("Ctrl-,", "Settings"),
        ],
    },
    KeyHelp {
        group: "Navigation",
        entries: &[
            ("j / k or ↓ / ↑", "Move"),
            ("g / G", "Top / bottom"),
            ("Ctrl-D / Ctrl-U", "Half page"),
            ("h / l", "Pane left / right"),
            ("Tab / Shift-Tab", "Next / previous tab"),
            ("Enter", "Open / expand"),
        ],
    },
    KeyHelp {
        group: "Board",
        entries: &[
            ("n", "New card"),
            ("Enter", "Open card"),
            ("h / Tab", "Focus project list"),
            ("j / k (projects)", "Move project"),
            ("Enter (projects)", "Filter by project"),
            ("/", "Filter"),
            ("Ctrl-F", "Project scope"),
            ("Ctrl-A", "Hide Done"),
            ("J / K", "Reorder backlog"),
            ("Ctrl-B", "Toggle project sidebar"),
        ],
    },
    KeyHelp {
        group: "Card detail",
        entries: &[
            (
                "1..6",
                "Overview / Agent / Diff / Terminal / Server / Console",
            ),
            ("a", "Actions menu"),
            ("e", "Edit description"),
            ("Esc", "Back"),
            ("y / n", "Confirm / cancel"),
        ],
    },
    KeyHelp {
        group: "Agent",
        entries: &[
            ("i", "Focus native Pi pane"),
            ("Ctrl-W Ctrl-W", "Release input / tab bar"),
            ("Esc", "Back (normal mode)"),
            ("Ctrl-W [", "Copy mode"),
            ("r", "Restart an exited Pi session"),
        ],
    },
    KeyHelp {
        group: "Diff",
        entries: &[
            ("Space", "Mark file reviewed"),
            ("c / C", "Comment on file / overall"),
            ("s", "Send review feedback to Agent"),
            ("n / p", "Next / previous file"),
            ("[ / ]", "Next / previous hunk"),
            ("gg / G", "Top / bottom"),
            ("h / l", "Fold / unfold directory"),
            ("Enter", "Toggle directory"),
        ],
    },
    KeyHelp {
        group: "Terminal",
        entries: &[
            ("Ctrl-W then |", "Split right"),
            ("Ctrl-W then -", "Split down"),
            ("Ctrl-W then o", "Cycle pane"),
            ("Ctrl-W then x", "Close pane"),
            ("Ctrl-W then z", "Maximize pane"),
            ("Ctrl-W then [", "Copy mode (vi)"),
            ("Ctrl-W then q", "Close pane"),
            ("Ctrl-W Ctrl-W", "Release input / tab bar"),
        ],
    },
    KeyHelp {
        group: "Confirm",
        entries: &[
            ("1 / y", "Confirm (after the delay)"),
            ("2 / n / Esc", "Cancel (initial focus)"),
            ("Tab / Shift-Tab", "Move"),
        ],
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_script_tokens() {
        assert_eq!(Key::parse("ctrl-p"), Some(Key::Ctrl('p')));
        assert_eq!(Key::parse("Alt-Enter"), Some(Key::Alt('E')));
        assert_eq!(Key::parse("space"), Some(Key::Char(' ')));
        assert_eq!(Key::parse("f5"), Some(Key::F(5)));
        assert_eq!(Key::parse("ab"), None);
        assert_eq!(Key::parse("type"), None);
    }

    #[test]
    fn every_keymap_entry_has_a_key_and_description() {
        for help in KEYMAP {
            assert!(!help.entries.is_empty(), "{}", help.group);
            for (key, description) in help.entries {
                assert!(!key.trim().is_empty() && !description.trim().is_empty());
            }
        }
        let groups: Vec<_> = KEYMAP.iter().map(|help| help.group).collect();
        assert_eq!(groups.len(), 8);
    }

    #[test]
    fn help_covers_every_global_shortcut_used_by_app() {
        let help = KEYMAP
            .iter()
            .flat_map(|group| group.entries.iter().map(|(key, _)| *key))
            .collect::<Vec<_>>()
            .join(" ");
        for key in [
            "Ctrl-Q", "Ctrl-P", "Ctrl-O", "Ctrl-G", "Ctrl-R", "Ctrl-,", "Ctrl-B", "Ctrl-W",
            "Ctrl-D", "Ctrl-U", "Ctrl-W", "i",
        ] {
            assert!(help.contains(key), "{key} missing from help");
        }
    }
}
