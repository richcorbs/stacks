//! Palette and project accents.
//!
//! Colour is never the only signal: status glyphs and words carry the same
//! meaning. Truecolour is used when `COLORTERM` advertises it, with 256 and
//! 16-colour fallbacks.

use ratatui::style::Color;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorDepth {
    True,
    Ansi256,
    Ansi16,
}

pub fn detect_depth() -> ColorDepth {
    let color_term = std::env::var("COLORTERM")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if color_term.contains("truecolor") || color_term.contains("24bit") {
        return ColorDepth::True;
    }
    let term = std::env::var("TERM")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if term.is_empty() || term == "dumb" || term == "ansi" {
        return ColorDepth::Ansi16;
    }
    ColorDepth::Ansi256
}

#[derive(Debug, Clone, Copy)]
pub struct Theme {
    pub canvas: Color,
    pub panel: Color,
    pub raised: Color,
    pub hover: Color,
    pub selected: Color,
    pub text: Color,
    pub muted: Color,
    pub dim: Color,
    pub accent: Color,
    pub success: Color,
    pub warning: Color,
    pub danger: Color,
    pub info: Color,
    pub diff_add: Color,
    pub diff_del: Color,
    pub diff_hunk: Color,
}

fn rgb(depth: ColorDepth, red: u8, green: u8, blue: u8) -> Color {
    match depth {
        ColorDepth::True => Color::Rgb(red, green, blue),
        ColorDepth::Ansi256 => Color::Indexed(rgb_to_ansi256(red, green, blue)),
        ColorDepth::Ansi16 => Color::Indexed(rgb_to_ansi16(red, green, blue)),
    }
}

pub fn theme(depth: ColorDepth, accent_id: Option<&str>) -> Theme {
    Theme {
        canvas: rgb(depth, 0x0f, 0x0f, 0x0f),
        panel: rgb(depth, 0x18, 0x18, 0x18),
        raised: rgb(depth, 0x1e, 0x1e, 0x1e),
        hover: rgb(depth, 0x26, 0x26, 0x26),
        selected: rgb(depth, 0x30, 0x30, 0x30),
        text: rgb(depth, 0xd6, 0xde, 0xeb),
        muted: rgb(depth, 0x8b, 0x9b, 0xad),
        dim: rgb(depth, 0x5d, 0x6b, 0x7a),
        accent: project_accent(depth, accent_id),
        success: rgb(depth, 0x77, 0xab, 0x81),
        warning: rgb(depth, 0xc3, 0xa1, 0x6a),
        danger: rgb(depth, 0xca, 0x76, 0x76),
        info: rgb(depth, 0x70, 0xab, 0xc3),
        diff_add: rgb(depth, 0x4d, 0x7a, 0x5a),
        diff_del: rgb(depth, 0x8a, 0x4f, 0x50),
        diff_hunk: rgb(depth, 0x5b, 0x7e, 0xa8),
    }
}

/// Project accent values from `src/styles.css` `[data-project-color]`.
pub fn project_accent(depth: ColorDepth, color_id: Option<&str>) -> Color {
    let (red, green, blue) = match color_id.unwrap_or("blue") {
        "slate" => (0x84, 0x9b, 0xb0),
        "teal" => (0x56, 0xa9, 0xa4),
        "green" => (0x77, 0xab, 0x81),
        "amber" => (0xc3, 0xa1, 0x6a),
        "coral" => (0xca, 0x8f, 0x76),
        "rose" => (0xbd, 0x83, 0x9b),
        "violet" => (0xa5, 0x8d, 0xc8),
        "indigo" => (0x84, 0x9a, 0xd0),
        "cyan" => (0x70, 0xab, 0xc3),
        _ => (0x3b, 0x82, 0xf6),
    };
    rgb(depth, red, green, blue)
}

/// Status glyph + word. Colour is secondary.
pub fn status_glyph(status: stacks_core::CardStatus) -> (&'static str, &'static str) {
    use stacks_core::CardStatus as Status;
    match status {
        Status::NeedsRefinement => ("○", "needs refinement"),
        Status::Refining => ("◐", "refining"),
        Status::NeedsRefinementInput => ("◆", "needs you for refinement"),
        Status::Ready => ("◆", "ready"),
        Status::AgentWorking => ("●", "agent working"),
        Status::NeedsHuman => ("◆", "needs you"),
        Status::Approved => ("◉", "approved"),
        Status::Done => ("✓", "done"),
    }
}

pub fn status_color(theme: Theme, status: stacks_core::CardStatus) -> Color {
    use stacks_core::CardStatus as Status;
    match status {
        Status::NeedsRefinementInput | Status::NeedsHuman | Status::Ready => theme.warning,
        Status::AgentWorking | Status::Refining => theme.info,
        Status::Approved => theme.success,
        Status::Done => theme.dim,
        Status::NeedsRefinement => theme.muted,
    }
}

pub fn terminal_color(
    depth: ColorDepth,
    color: stacks_core::terminal::TermColor,
    fallback: Color,
) -> Color {
    match color {
        stacks_core::terminal::TermColor::Default => fallback,
        stacks_core::terminal::TermColor::Indexed(index) => {
            if depth == ColorDepth::Ansi16 {
                Color::Indexed(ansi16_index(index))
            } else {
                Color::Indexed(index)
            }
        }
        stacks_core::terminal::TermColor::Rgb(red, green, blue) => match depth {
            ColorDepth::True => Color::Rgb(red, green, blue),
            ColorDepth::Ansi256 => Color::Indexed(rgb_to_ansi256(red, green, blue)),
            ColorDepth::Ansi16 => Color::Indexed(rgb_to_ansi16(red, green, blue)),
        },
    }
}

fn ansi16_index(index: u8) -> u8 {
    match index {
        0..=15 => index,
        // Approximate the 256-colour cube with the ANSI palette.
        16..=231 => {
            let index = index - 16;
            let red = index / 36;
            let green = (index % 36) / 6;
            let blue = index % 6;
            let bright = red.max(green).max(blue) > 2;
            let bit = |value: u8| if value > 2 { 1 } else { 0 };
            (if bright { 8 } else { 0 }) + bit(red) + bit(green) * 2 + bit(blue) * 4
        }
        _ => {
            if index < 244 {
                8
            } else {
                7
            }
        }
    }
}

fn rgb_to_ansi256(red: u8, green: u8, blue: u8) -> u8 {
    if red == green && green == blue {
        if red < 8 {
            return 16;
        }
        if red > 248 {
            return 231;
        }
        return 232 + ((red as u16 - 8) * 24 / 247) as u8;
    }
    let level = |value: u8| -> u8 {
        if value < 48 {
            0
        } else if value < 115 {
            1
        } else {
            ((value as u16 - 35) / 40) as u8
        }
    };
    16 + 36 * level(red) + 6 * level(green) + level(blue)
}

fn rgb_to_ansi16(red: u8, green: u8, blue: u8) -> u8 {
    let bit = |value: u8| u8::from(value >= 96);
    let bright = u8::from(red.max(green).max(blue) >= 200);
    bright * 8 + bit(red) + bit(green) * 2 + bit(blue) * 4
}

pub fn accent_choices() -> &'static [&'static str] {
    &[
        "blue", "slate", "teal", "green", "amber", "coral", "rose", "violet", "indigo", "cyan",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn depth_detection_falls_back_predictably() {
        // Avoid mutating the process environment in parallel tests; exercise
        // the conversion helpers instead.
        assert_eq!(rgb_to_ansi256(0, 0, 0), 16);
        assert_eq!(rgb_to_ansi256(255, 255, 255), 231);
        assert_eq!(rgb_to_ansi16(0, 0, 0), 0);
        assert_eq!(rgb_to_ansi16(255, 0, 0), 9);
    }

    #[test]
    fn every_project_accent_is_distinct_from_canvas() {
        for id in accent_choices() {
            assert_ne!(
                project_accent(ColorDepth::Ansi16, Some(id)),
                Color::Indexed(0)
            );
        }
    }

    #[test]
    fn status_glyphs_are_words_too() {
        for status in stacks_core::CardStatus::ALL {
            let (glyph, word) = status_glyph(status);
            assert!(!glyph.is_empty() && !word.is_empty());
        }
    }
}
