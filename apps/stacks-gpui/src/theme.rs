//! Stacks-specific visual tokens layered over GPUI Kit.
//!
//! The kit supplies behavior and themes; Stacks wants a darker, low-contrast
//! blue-slate workspace. Keep product colors here so list/detail polish does
//! not spread new hex literals through the views.

use gpui::{App, Hsla, px, rgb};
use gpui_kit::component::{Theme, ThemeMode};

pub const CANVAS: u32 = 0x0f141b;
pub const SURFACE: u32 = 0x131b24;
pub const SURFACE_RAISED: u32 = 0x18222d;
pub const BORDER: u32 = 0x24303d;
pub const BORDER_SUBTLE: u32 = 0x1b2430;
pub const TEXT: u32 = 0xd7e1eb;
pub const TEXT_STRONG: u32 = 0xeaf2f9;
pub const TEXT_MUTED: u32 = 0x8ea3b8;
pub const TEXT_FAINT: u32 = 0x62778a;
pub const ACCENT: u32 = 0x4f8cbd;
pub const ACCENT_SOFT: u32 = 0x24384b;
pub const FOCUS: u32 = 0x365d7d;
pub const SUCCESS: u32 = 0x8acb8a;
pub const WARNING: u32 = 0xe8c07a;
pub const DANGER: u32 = 0xe59a86;

fn hsla(hex: u32) -> Hsla {
    rgb(hex).into()
}

/// Install the Stacks palette once at app startup (and in tests before render).
pub fn install(cx: &mut App) {
    Theme::change(ThemeMode::Dark, None, cx);
    Theme::update(cx, |theme| {
        theme.colors.background = hsla(CANVAS);
        theme.colors.foreground = hsla(TEXT);
        theme.colors.muted = hsla(SURFACE_RAISED);
        theme.colors.muted_foreground = hsla(TEXT_MUTED);
        theme.colors.border = hsla(BORDER);
        theme.colors.primary = hsla(ACCENT);
        theme.colors.primary_foreground = hsla(0xf4f9fd);
        theme.colors.primary_hover = hsla(0x5c9bcb);
        theme.colors.primary_active = hsla(0x3f769f);
        theme.colors.secondary = hsla(0x1a2633);
        theme.colors.secondary_foreground = hsla(TEXT);
        theme.colors.accent = hsla(ACCENT_SOFT);
        theme.colors.accent_foreground = hsla(TEXT_STRONG);
        theme.colors.button = hsla(0x1a2633);
        theme.colors.button_hover = hsla(0x223246);
        theme.colors.button_active = hsla(0x2a3d51);
        theme.colors.button_foreground = hsla(TEXT);
        theme.colors.ring = hsla(FOCUS);
        theme.colors.danger = hsla(0x8c4a55);
        theme.colors.danger_foreground = hsla(0xf3d6db);
        theme.colors.warning = hsla(0x8a6a34);
        theme.colors.warning_foreground = hsla(0xffe7b4);
        theme.colors.success = hsla(0x3f7450);
        theme.colors.success_foreground = hsla(0xd7f2df);
        theme.radius = px(6.0);
        theme.radius_lg = px(10.0);
        theme.font_size = px(13.0);
        theme.mono_font_family = "Menlo".into();
        theme.mono_font_size = px(12.0);
    });
}
