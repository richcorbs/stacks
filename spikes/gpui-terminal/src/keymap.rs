//! GPUI keystroke -> libghostty-vt key event mapping.

use ghostty_vt::key::{Key, Mods};
use gpui::{Keystroke, Modifiers};

pub fn ghostty_mods(modifiers: Modifiers) -> Mods {
    let mut mods = Mods::empty();
    if modifiers.shift {
        mods |= Mods::SHIFT;
    }
    if modifiers.alt {
        mods |= Mods::ALT;
    }
    if modifiers.control {
        mods |= Mods::CTRL;
    }
    if modifiers.platform {
        mods |= Mods::SUPER;
    }
    mods
}

pub fn ghostty_key(key: &str) -> Option<Key> {
    Some(match key {
        "a" => Key::A,
        "b" => Key::B,
        "c" => Key::C,
        "d" => Key::D,
        "e" => Key::E,
        "f" => Key::F,
        "g" => Key::G,
        "h" => Key::H,
        "i" => Key::I,
        "j" => Key::J,
        "k" => Key::K,
        "l" => Key::L,
        "m" => Key::M,
        "n" => Key::N,
        "o" => Key::O,
        "p" => Key::P,
        "q" => Key::Q,
        "r" => Key::R,
        "s" => Key::S,
        "t" => Key::T,
        "u" => Key::U,
        "v" => Key::V,
        "w" => Key::W,
        "x" => Key::X,
        "y" => Key::Y,
        "z" => Key::Z,
        "0" => Key::Digit0,
        "1" => Key::Digit1,
        "2" => Key::Digit2,
        "3" => Key::Digit3,
        "4" => Key::Digit4,
        "5" => Key::Digit5,
        "6" => Key::Digit6,
        "7" => Key::Digit7,
        "8" => Key::Digit8,
        "9" => Key::Digit9,
        "`" => Key::Backquote,
        "\\" => Key::Backslash,
        "[" => Key::BracketLeft,
        "]" => Key::BracketRight,
        "," => Key::Comma,
        "=" => Key::Equal,
        "-" => Key::Minus,
        "." => Key::Period,
        "'" => Key::Quote,
        ";" => Key::Semicolon,
        "/" => Key::Slash,
        "space" => Key::Space,
        "tab" => Key::Tab,
        "enter" => Key::Enter,
        "backspace" => Key::Backspace,
        "escape" => Key::Escape,
        "delete" => Key::Delete,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "up" => Key::ArrowUp,
        "down" => Key::ArrowDown,
        "left" => Key::ArrowLeft,
        "right" => Key::ArrowRight,
        "insert" => Key::Insert,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        "f13" => Key::F13,
        "f14" => Key::F14,
        "f15" => Key::F15,
        "f16" => Key::F16,
        "f17" => Key::F17,
        "f18" => Key::F18,
        "f19" => Key::F19,
        "f20" => Key::F20,
        _ => return None,
    })
}

/// Whether this key should be left to GPUI's text-input (IME) path instead of
/// going through Ghostty's key encoder. Printable text is committed exactly
/// once by `replace_text_in_range`; encoding it here as well duplicates input.
pub fn is_text_input_key(keystroke: &Keystroke) -> bool {
    if keystroke.modifiers.control
        || keystroke.modifiers.alt
        || keystroke.modifiers.platform
        || keystroke.modifiers.function
    {
        return false;
    }
    let Some(text) = keystroke.key_char.as_deref() else {
        return false;
    };
    !text.is_empty()
        && !text.chars().any(|ch| {
            ch.is_control()
                || matches!(
                    ghostty_key(keystroke.key.as_str()),
                    Some(
                        Key::Enter
                            | Key::Tab
                            | Key::Backspace
                            | Key::Escape
                            | Key::Delete
                            | Key::Home
                            | Key::End
                            | Key::PageUp
                            | Key::PageDown
                            | Key::ArrowUp
                            | Key::ArrowDown
                            | Key::ArrowLeft
                            | Key::ArrowRight
                            | Key::Insert
                    )
                )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_letters_and_named_keys() {
        assert_eq!(ghostty_key("a"), Some(Key::A));
        assert_eq!(ghostty_key("["), Some(Key::BracketLeft));
        assert_eq!(ghostty_key("pageup"), Some(Key::PageUp));
        assert_eq!(ghostty_key("nope"), None);
    }

    #[test]
    fn printable_text_uses_ime_only() {
        let plain = Keystroke {
            modifiers: Modifiers::none(),
            key: "a".into(),
            key_char: Some("a".into()),
        };
        assert!(is_text_input_key(&plain));
        let ctrl = Keystroke {
            modifiers: Modifiers {
                control: true,
                ..Modifiers::none()
            },
            key: "c".into(),
            key_char: None,
        };
        assert!(!is_text_input_key(&ctrl));
        let enter = Keystroke {
            modifiers: Modifiers::none(),
            key: "enter".into(),
            key_char: Some("\n".into()),
        };
        assert!(!is_text_input_key(&enter));
    }
}
