//! Small, UI-independent wrapper around libghostty-vt.
//!
//! The GPUI layer only sees plain data (`Frame`, `Cell`) and never borrows C
//! handles. That keeps the emulator testable without a running app.

use anyhow::{Context as _, Result};
use ghostty_vt::{
    Terminal, TerminalOptions, focus,
    key::{self, Encoder as KeyEncoder, Mods, OptionAsAlt},
    mouse::{self, Encoder as MouseEncoder},
    paste,
    render::{CellIterator, CursorVisualStyle, Dirty, RenderState, RowId, RowIterator},
    screen::{CellWide, Screen},
    search::{Scroll as SearchScroll, Search},
    selection::{FormatOptions, Selection},
    style::{RgbColor, Style, StyleColor},
    terminal::{ClipboardContent, Event as TerminalEvent, Mode, ModeKind, Point, PointCoordinate},
};

pub const DEFAULT_BG: RgbColor = RgbColor {
    r: 0x0f,
    g: 0x14,
    b: 0x1b,
};
pub const DEFAULT_FG: RgbColor = RgbColor {
    r: 0xf0,
    g: 0xf4,
    b: 0xfc,
};
pub const DEFAULT_CURSOR: RgbColor = RgbColor {
    r: 0x80,
    g: 0xcb,
    b: 0xc4,
};
/// Matches Stacks' active xterm theme: warm selection with dark text.
pub const SELECTION_BG: RgbColor = RgbColor {
    r: 0xff,
    g: 0xf7,
    b: 0xed,
};
pub const SELECTION_FG: RgbColor = RgbColor {
    r: 0x11,
    g: 0x18,
    b: 0x27,
};
pub const FONT_SIZE: f32 = 14.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColorSource {
    Default,
    Palette(u8),
    Rgb(RgbColor),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cell {
    pub text: CellText,
    pub fg: RgbColor,
    pub bg: RgbColor,
    /// Raw style source before inverse/default resolution. Used by the parity
    /// harness to compare attribute identity with xterm.js.
    pub fg_source: ColorSource,
    pub bg_source: ColorSource,
    pub bold: bool,
    pub italic: bool,
    pub faint: bool,
    pub underline: bool,
    pub strikethrough: bool,
    pub inverse: bool,
    pub invisible: bool,
    pub wide: bool,
    pub spacer_tail: bool,
    pub selected: bool,
    /// True for a cell that only carries a background color.
    pub blank: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct CellText {
    buf: [u8; 32],
    len: u8,
}

impl CellText {
    pub fn as_str(&self) -> &str {
        std::str::from_utf8(&self.buf[..self.len as usize]).unwrap_or("")
    }

    fn set(&mut self, text: &str) {
        let len = text.len().min(self.buf.len());
        // Never leave a truncated UTF-8 sequence behind.
        let mut len = len;
        while !text.is_char_boundary(len) {
            len -= 1;
        }
        self.buf[..len].copy_from_slice(&text.as_bytes()[..len]);
        self.len = len as u8;
    }
}

impl Cell {
    fn blank(bg: RgbColor) -> Self {
        Self {
            text: CellText::default(),
            fg: DEFAULT_FG,
            bg,
            fg_source: ColorSource::Default,
            bg_source: ColorSource::Default,
            bold: false,
            italic: false,
            faint: false,
            underline: false,
            strikethrough: false,
            inverse: false,
            invisible: false,
            wide: false,
            spacer_tail: false,
            selected: false,
            blank: true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cursor {
    pub x: u16,
    pub y: u16,
    pub visible: bool,
    pub blinking: bool,
    pub style: CursorStyle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorStyle {
    Block,
    Bar,
    Underline,
    Hollow,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    pub cols: u16,
    pub rows: u16,
    pub cells: Vec<Cell>,
    pub cursor: Option<Cursor>,
    pub bg: RgbColor,
    pub fg: RgbColor,
    pub cursor_color: RgbColor,
    pub screen: Screen,
    pub dirty: Dirty,
    pub row_ids: Vec<RowId>,
    /// Number of scrollback rows available above the viewport.
    pub scrollback_rows: usize,
    /// Total scrollable rows reported by libghostty's scrollbar state.
    pub scrollbar_total: u64,
    /// Viewport offset from the top of the scrollable area.
    pub scrollbar_offset: u64,
}

impl Frame {
    pub fn cell(&self, x: u16, y: u16) -> Option<&Cell> {
        if x >= self.cols || y >= self.rows {
            return None;
        }
        self.cells.get(y as usize * self.cols as usize + x as usize)
    }

    /// Plain text for a row. Wide tails are skipped so the tab/spacer geometry
    /// stays aligned with the renderer.
    pub fn row_text(&self, y: u16) -> String {
        let mut text = String::new();
        for x in 0..self.cols {
            let Some(cell) = self.cell(x, y) else { break };
            if cell.spacer_tail {
                continue;
            }
            if cell.text.as_str().is_empty() {
                text.push(' ');
            } else {
                text.push_str(cell.text.as_str());
            }
        }
        text.trim_end().to_string()
    }

    pub fn text(&self) -> Vec<String> {
        (0..self.rows).map(|y| self.row_text(y)).collect()
    }
}

#[derive(Clone, Debug, Default)]
pub struct Effects {
    pub pty_writes: Vec<Vec<u8>>,
    pub titles: Vec<String>,
    pub clipboard: Vec<String>,
    pub bells: usize,
    pub notifications: Vec<(String, String)>,
    pub pwd_changes: Vec<String>,
}

impl Effects {
    pub fn is_empty(&self) -> bool {
        self.pty_writes.is_empty()
            && self.titles.is_empty()
            && self.clipboard.is_empty()
            && self.bells == 0
            && self.notifications.is_empty()
            && self.pwd_changes.is_empty()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseAction {
    Press,
    Release,
    Motion,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
    WheelUp,
    WheelDown,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SearchInfo {
    pub total: usize,
    pub selected: Option<usize>,
}

pub struct TerminalModel {
    terminal: Terminal,
    search: Option<Search>,
    render_state: RenderState,
    row_iterator: RowIterator,
    cell_iterator: CellIterator,
    key_encoder: KeyEncoder,
    mouse_encoder: MouseEncoder,
    frame: Option<Frame>,
    dirty: bool,
    cell_width_px: u32,
    cell_height_px: u32,
    pub title: String,
}

impl TerminalModel {
    pub fn new(cols: u16, rows: u16, scrollback_bytes: usize) -> Result<Self> {
        let mut terminal = Terminal::new(TerminalOptions {
            cols,
            rows,
            max_scrollback: scrollback_bytes,
        })?;
        terminal
            .set_default_bg_color(Some(DEFAULT_BG))?
            .set_default_fg_color(Some(DEFAULT_FG))?
            .set_default_cursor_color(Some(DEFAULT_CURSOR))?
            .set_default_color_palette(Some(stacks_default_palette()))?
            .set_title_report(false)?;
        let render_state = RenderState::new()?;
        let row_iterator = RowIterator::new()?;
        let cell_iterator = CellIterator::new()?;
        let mut key_encoder = KeyEncoder::new()?;
        key_encoder.set_macos_option_as_alt(OptionAsAlt::True);
        let mouse_encoder = MouseEncoder::new()?;
        Ok(Self {
            terminal,
            search: None,
            render_state,
            row_iterator,
            cell_iterator,
            key_encoder,
            mouse_encoder,
            frame: None,
            dirty: true,
            cell_width_px: 8,
            cell_height_px: 17,
            title: String::new(),
        })
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Effects {
        self.terminal.vt_write(bytes);
        self.dirty = true;
        let mut effects = Effects::default();
        for event in self.terminal.events() {
            match event {
                TerminalEvent::PtyWrite(bytes) => effects.pty_writes.push(bytes),
                TerminalEvent::Bell => effects.bells += 1,
                TerminalEvent::TitleChanged(title) => {
                    self.title = title.clone();
                    effects.titles.push(title);
                }
                TerminalEvent::PwdChanged(pwd) => effects.pwd_changes.push(pwd),
                TerminalEvent::ClipboardWrite(write) => {
                    if let Some(text) = clipboard_text(&write.contents) {
                        effects.clipboard.push(text);
                    }
                }
                TerminalEvent::DesktopNotification { title, body } => {
                    effects.notifications.push((title, body));
                }
                TerminalEvent::ProgressReport { .. } | TerminalEvent::RenderHold(_) => {}
            }
        }
        if self.search.is_some() {
            let Self {
                terminal, search, ..
            } = self;
            if let Some(search) = search.as_mut() {
                let _ = search.feed(terminal);
            }
        }
        effects
    }

    pub fn resize(
        &mut self,
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
    ) -> Result<()> {
        let cols = cols.max(2);
        let rows = rows.max(1);
        if self.cell_width_px == cell_width_px
            && self.cell_height_px == cell_height_px
            && self
                .frame
                .as_ref()
                .is_some_and(|f| f.cols == cols && f.rows == rows)
        {
            return Ok(());
        }
        self.cell_width_px = cell_width_px.max(1);
        self.cell_height_px = cell_height_px.max(1);
        self.terminal
            .resize(cols, rows, self.cell_width_px, self.cell_height_px)?;
        self.dirty = true;
        Ok(())
    }

    pub fn size(&self) -> (u16, u16) {
        self.frame
            .as_ref()
            .map(|frame| (frame.cols, frame.rows))
            .unwrap_or((80, 24))
    }

    pub fn scroll(&mut self, delta: isize) {
        self.terminal
            .scroll_viewport(ghostty_vt::terminal::ScrollViewport::Delta(delta));
        self.dirty = true;
    }

    pub fn scroll_to_bottom(&mut self) {
        self.terminal
            .scroll_viewport(ghostty_vt::terminal::ScrollViewport::Bottom);
        self.dirty = true;
    }

    pub fn bracketed_paste(&self) -> bool {
        self.terminal.mode(Mode::BRACKETED_PASTE).unwrap_or(false)
    }

    pub fn focus_reporting(&self) -> bool {
        self.terminal
            .mode(Mode::new(1004, ModeKind::Dec))
            .unwrap_or(false)
    }

    pub fn mouse_tracking(&self) -> bool {
        self.terminal.is_mouse_tracking().unwrap_or(false)
    }

    pub fn encode_paste(&self, text: &str) -> Result<Vec<u8>> {
        // Stacks' xterm path normalizes LF to CR before handing paste to the
        // shell, including inside bracketed paste. Keep that contract.
        let mut data: Vec<u8> = text
            .as_bytes()
            .iter()
            .map(|byte| if *byte == b'\n' { b'\r' } else { *byte })
            .collect();
        let mut out = vec![0u8; data.len() * 2 + 32];
        let len = paste::encode(&mut data, self.bracketed_paste(), &mut out)
            .context("encode bracketed paste")?;
        out.truncate(len);
        Ok(out)
    }

    pub fn encode_focus(&self, gained: bool) -> Vec<u8> {
        if !self.focus_reporting() {
            return Vec::new();
        }
        let event = if gained {
            focus::Event::Gained
        } else {
            focus::Event::Lost
        };
        let mut buf = [0u8; 8];
        event
            .encode(&mut buf)
            .map(|len| buf[..len].to_vec())
            .unwrap_or_default()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn encode_key(
        &mut self,
        key: key::Key,
        mods: Mods,
        action: key::Action,
        utf8: Option<&str>,
        unshifted: Option<char>,
        composing: bool,
    ) -> Result<Vec<u8>> {
        self.key_encoder
            .set_options_from_terminal(&self.terminal)
            .set_macos_option_as_alt(OptionAsAlt::True);
        let mut event = key::Event::new()?;
        event
            .set_action(action)
            .set_key(key)
            .set_mods(mods)
            .set_composing(composing)
            .set_utf8(utf8);
        if let Some(ch) = unshifted {
            event.set_unshifted_codepoint(ch);
        }
        let mut out = Vec::with_capacity(32);
        self.key_encoder.encode_to_vec(&event, &mut out)?;
        Ok(out)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn encode_mouse(
        &mut self,
        action: MouseAction,
        button: Option<MouseButton>,
        mods: Mods,
        x_px: f32,
        y_px: f32,
        screen_width: u32,
        screen_height: u32,
        cell_width: u32,
        cell_height: u32,
    ) -> Result<Vec<u8>> {
        self.mouse_encoder
            .set_options_from_terminal(&self.terminal)
            .set_size(mouse::EncoderSize {
                screen_width,
                screen_height,
                cell_width: cell_width.max(1),
                cell_height: cell_height.max(1),
                padding_top: 0,
                padding_bottom: 0,
                padding_right: 0,
                padding_left: 0,
            });
        let mut event = mouse::Event::new()?;
        event
            .set_action(match action {
                MouseAction::Press => mouse::Action::Press,
                MouseAction::Release => mouse::Action::Release,
                MouseAction::Motion => mouse::Action::Motion,
            })
            .set_button(button.map(|button| match button {
                MouseButton::Left => mouse::Button::Left,
                MouseButton::Right => mouse::Button::Right,
                MouseButton::Middle => mouse::Button::Middle,
                MouseButton::WheelUp => mouse::Button::Four,
                MouseButton::WheelDown => mouse::Button::Five,
            }))
            .set_mods(mods)
            .set_position(mouse::Position { x: x_px, y: y_px });
        let mut out = Vec::with_capacity(32);
        self.mouse_encoder.encode_to_vec(&event, &mut out)?;
        Ok(out)
    }

    pub fn search_set(&mut self, needle: &str) -> Result<SearchInfo> {
        if needle.is_empty() {
            self.search_clear()?;
            return Ok(SearchInfo::default());
        }
        if self.search.is_none() {
            self.search = Some(Search::new(&self.terminal)?);
        }
        let Self {
            terminal, search, ..
        } = self;
        let search = search.as_mut().expect("search was just created");
        search.set_needle(terminal, Some(needle))?;
        search.set_select_scroll(Some(SearchScroll::IfNeeded))?;
        search.run(terminal)?;
        search.select_next(terminal)?;
        if let Some(selected) = search.selected_match(terminal)? {
            terminal.set_selection(Some(&selected))?;
        }
        self.dirty = true;
        Ok(SearchInfo {
            total: search.total_matches()?,
            selected: search.selected_index()?,
        })
    }

    pub fn search_next(&mut self) -> Result<SearchInfo> {
        let Self {
            terminal, search, ..
        } = self;
        let Some(search) = search.as_mut() else {
            return Ok(SearchInfo::default());
        };
        search.select_next(terminal)?;
        if let Some(selected) = search.selected_match(terminal)? {
            terminal.set_selection(Some(&selected))?;
        }
        self.dirty = true;
        Ok(SearchInfo {
            total: search.total_matches()?,
            selected: search.selected_index()?,
        })
    }

    pub fn search_prev(&mut self) -> Result<SearchInfo> {
        let Self {
            terminal, search, ..
        } = self;
        let Some(search) = search.as_mut() else {
            return Ok(SearchInfo::default());
        };
        search.select_prev(terminal)?;
        if let Some(selected) = search.selected_match(terminal)? {
            terminal.set_selection(Some(&selected))?;
        }
        self.dirty = true;
        Ok(SearchInfo {
            total: search.total_matches()?,
            selected: search.selected_index()?,
        })
    }

    pub fn search_clear(&mut self) -> Result<()> {
        if let Some(mut search) = self.search.take() {
            let _ = search.set_needle(&self.terminal, None);
        }
        self.terminal.set_selection(None)?;
        self.dirty = true;
        Ok(())
    }

    pub fn search_info(&self) -> Result<SearchInfo> {
        let Some(search) = self.search.as_ref() else {
            return Ok(SearchInfo::default());
        };
        Ok(SearchInfo {
            total: search.total_matches()?,
            selected: search.selected_index()?,
        })
    }

    pub fn refresh_search(&mut self) -> Result<()> {
        let Self {
            terminal, search, ..
        } = self;
        if let Some(search) = search.as_mut() {
            search.feed(terminal)?;
        }
        Ok(())
    }

    pub fn set_selection(&mut self, start: (u16, u16), end: (u16, u16)) -> Result<()> {
        let (sx, sy) = start;
        let (ex, ey) = end;
        let start = self.terminal.grid_ref(Point::Viewport(PointCoordinate {
            x: sx,
            y: u32::from(sy),
        }))?;
        let end = self.terminal.grid_ref(Point::Viewport(PointCoordinate {
            x: ex,
            y: u32::from(ey),
        }))?;
        let selection = Selection::new(start, end, false);
        self.terminal.set_selection(Some(&selection))?;
        self.dirty = true;
        Ok(())
    }

    pub fn clear_selection(&mut self) -> Result<()> {
        self.terminal.set_selection(None)?;
        self.dirty = true;
        Ok(())
    }

    pub fn has_selection(&self) -> bool {
        self.terminal.selection().ok().flatten().is_some()
    }

    pub fn selection_text(&self) -> Result<Option<String>> {
        let Some(bytes) = self
            .terminal
            .format_selection_alloc(FormatOptions::new().with_trim(true).with_unwrap(true))?
        else {
            return Ok(None);
        };
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// Update the render state and materialize a frame. A clean frame is
    /// returned without touching the emulator again.
    pub fn frame(&mut self) -> Result<&Frame> {
        if self.frame.is_none() || self.dirty {
            self.frame = Some(self.extract_frame()?);
            self.dirty = false;
        }
        Ok(self.frame.as_ref().expect("frame was just populated"))
    }

    fn extract_frame(&mut self) -> Result<Frame> {
        let snapshot = self.render_state.update(&self.terminal)?;
        let cols = snapshot.cols()?;
        let rows = snapshot.rows()?;
        let colors = snapshot.colors()?;
        let cursor = snapshot.cursor()?;
        let dirty = snapshot.dirty()?;
        let scrollback_rows = self.terminal.scrollback_rows().unwrap_or(0);
        let scrollbar = self.terminal.scrollbar().unwrap_or_default();
        let screen = self.terminal.active_screen().unwrap_or(Screen::Primary);

        let mut cells = Vec::with_capacity(usize::from(cols) * usize::from(rows));
        let mut row_ids = Vec::with_capacity(usize::from(rows));
        let mut row_iteration = self.row_iterator.update(&snapshot)?;
        let mut viewport_rows = 0usize;
        while let Some(row) = row_iteration.next() {
            let y = row.viewport_y()?;
            if !(0..i32::from(rows)).contains(&y) {
                continue;
            }
            let row_id = row.id()?;
            let mut iteration = self.cell_iterator.update(row)?;
            let mut row_cells = Vec::with_capacity(usize::from(cols));
            while let Some(cell) = iteration.next() {
                row_cells.push(Self::convert_cell(cell, &colors)?);
            }
            row_cells.resize_with(usize::from(cols), || Cell::blank(colors.background));
            cells.extend(row_cells);
            row_ids.push(row_id);
            viewport_rows += 1;
        }
        // Defensive fill if the render state returned fewer rows than advertised.
        cells.resize(
            usize::from(cols) * usize::from(rows),
            Cell::blank(colors.background),
        );
        row_ids.resize(usize::from(rows), RowId::default());
        debug_assert_eq!(viewport_rows, usize::from(rows));

        snapshot.clean()?;
        Ok(Frame {
            cols,
            rows,
            cells,
            cursor: cursor.viewport.map(|viewport| Cursor {
                x: viewport.x,
                y: viewport.y,
                visible: cursor.visible,
                blinking: cursor.blinking,
                style: match cursor.visual_style {
                    CursorVisualStyle::Block => CursorStyle::Block,
                    CursorVisualStyle::Bar => CursorStyle::Bar,
                    CursorVisualStyle::Underline => CursorStyle::Underline,
                    CursorVisualStyle::BlockHollow => CursorStyle::Hollow,
                    _ => CursorStyle::Block,
                },
            }),
            bg: colors.background,
            fg: colors.foreground,
            cursor_color: colors.cursor.unwrap_or(colors.foreground),
            screen,
            dirty,
            row_ids,
            scrollback_rows,
            scrollbar_total: scrollbar.total,
            scrollbar_offset: scrollbar.offset,
        })
    }

    fn convert_cell(
        cell: &ghostty_vt::render::CellIteration<'_>,
        colors: &ghostty_vt::render::Colors,
    ) -> Result<Cell> {
        let raw = cell.raw_cell()?;
        let wide = raw.wide()?;
        let has_styling = cell.has_styling()?;
        let style = if has_styling {
            cell.style()?
        } else {
            Style::default()
        };
        let fg_source = color_source(style.fg_color);
        let bg_source = match raw.content_tag()? {
            ghostty_vt::screen::CellContentTag::BgColorRgb => ColorSource::Rgb(raw.bg_color_rgb()?),
            ghostty_vt::screen::CellContentTag::BgColorPalette => {
                ColorSource::Palette(raw.bg_color_palette()?.0 as u8)
            }
            _ => color_source(style.bg_color),
        };
        let mut fg = cell
            .fg_color()?
            .map(rgb)
            .or_else(|| resolve(style.fg_color, colors, colors.foreground))
            .unwrap_or(colors.foreground);
        let mut bg = cell
            .bg_color()?
            .map(rgb)
            .or_else(|| resolve(style.bg_color, colors, colors.background))
            .unwrap_or(colors.background);
        if style.inverse {
            std::mem::swap(&mut fg, &mut bg);
        }
        if style.faint {
            fg = blend(fg, bg, 0.55);
        }
        let mut text = CellText::default();
        if !style.invisible && wide != CellWide::SpacerTail && wide != CellWide::SpacerHead {
            let mut graphemes = String::new();
            cell.graphemes_utf8(&mut graphemes)?;
            text.set(&graphemes);
        }
        let selected = cell.is_selected().unwrap_or(false);
        if selected {
            bg = SELECTION_BG;
            fg = SELECTION_FG;
        }
        Ok(Cell {
            text,
            fg,
            bg,
            fg_source,
            bg_source,
            bold: style.bold,
            italic: style.italic,
            faint: style.faint,
            underline: !matches!(style.underline, ghostty_vt::style::Underline::None),
            strikethrough: style.strikethrough,
            inverse: style.inverse,
            invisible: style.invisible,
            wide: wide == CellWide::Wide,
            spacer_tail: wide == CellWide::SpacerTail,
            selected,
            blank: !raw.has_text()?,
        })
    }
}

/// xterm.js' DEFAULT_ANSI_COLORS. Stacks does not override the ANSI palette,
/// so matching these values is required before swapping emulators.
pub fn stacks_default_palette() -> ghostty_vt::style::Palette {
    let mut palette = ghostty_vt::style::Palette::default();
    let base = [
        0x2e3436, 0xcc0000, 0x4e9a06, 0xc4a000, 0x3465a4, 0x75507b, 0x06989a, 0xd3d7cf, 0x555753,
        0xef2929, 0x8ae234, 0xfce94f, 0x729fcf, 0xad7fa8, 0x34e2e2, 0xeeeeec,
    ];
    for (index, value) in base.into_iter().enumerate() {
        palette.set(
            ghostty_vt::style::PaletteIndex(index as u8),
            RgbColor {
                r: (value >> 16) as u8,
                g: (value >> 8) as u8,
                b: value as u8,
            },
        );
    }
    let steps = [0x00u8, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
    for index in 0..216usize {
        let r = steps[(index / 36) % 6];
        let g = steps[(index / 6) % 6];
        let b = steps[index % 6];
        palette.set(
            ghostty_vt::style::PaletteIndex((16 + index) as u8),
            RgbColor { r, g, b },
        );
    }
    for index in 0..24usize {
        let level = 8 + index as u8 * 10;
        palette.set(
            ghostty_vt::style::PaletteIndex((232 + index) as u8),
            RgbColor {
                r: level,
                g: level,
                b: level,
            },
        );
    }
    palette
}

fn color_source(color: StyleColor) -> ColorSource {
    match color {
        StyleColor::None => ColorSource::Default,
        StyleColor::Palette(index) => ColorSource::Palette(index.0 as u8),
        StyleColor::Rgb(color) => ColorSource::Rgb(color),
    }
}

fn resolve(
    color: StyleColor,
    colors: &ghostty_vt::render::Colors,
    fallback: RgbColor,
) -> Option<RgbColor> {
    match color {
        StyleColor::None => Some(fallback),
        StyleColor::Rgb(rgb) => Some(rgb),
        StyleColor::Palette(index) => colors.palette.get(index.0 as usize).copied(),
    }
}

fn clipboard_text(contents: &[ClipboardContent]) -> Option<String> {
    contents
        .iter()
        .find(|content| content.mime == "text/plain" || content.mime == "text/plain;charset=utf-8")
        .and_then(|content| String::from_utf8(content.data.clone()).ok())
}

pub fn rgb(color: RgbColor) -> RgbColor {
    color
}

pub fn blend(a: RgbColor, b: RgbColor, amount: f32) -> RgbColor {
    let mix = |x: u8, y: u8| (f32::from(x) * amount + f32::from(y) * (1.0 - amount)) as u8;
    RgbColor {
        r: mix(a.r, b.r),
        g: mix(a.g, b.g),
        b: mix(a.b, b.b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(cols: u16, rows: u16) -> TerminalModel {
        TerminalModel::new(cols, rows, 1_000_000).unwrap()
    }

    #[test]
    fn feeds_text_and_ansi_colors() {
        let mut term = model(20, 4);
        term.feed(b"plain \x1b[1;31mred\x1b[0m\r\nnext");
        let frame = term.frame().unwrap();
        assert_eq!(frame.row_text(0), "plain red");
        let red = frame.cell(6, 0).unwrap();
        assert!(red.bold);
        assert_eq!(
            red.fg,
            RgbColor {
                r: 0xcc,
                g: 0x00,
                b: 0x00
            }
        );
        assert_eq!(frame.row_text(1), "next");
    }

    #[test]
    fn tracks_title_bell_and_osc52() {
        let mut term = model(20, 4);
        let effects = term.feed(b"\x07\x1b]2;spike title\x1b\\\x1b]52;c;Zm9vIGJhcg==\x07");
        assert_eq!(effects.bells, 1);
        assert_eq!(effects.titles, ["spike title"]);
        assert_eq!(effects.clipboard, ["foo bar"]);
        assert_eq!(term.title, "spike title");
    }

    #[test]
    fn bracketed_paste_uses_2004_mode() {
        let mut term = model(20, 4);
        assert_eq!(term.encode_paste("hi").unwrap(), b"hi");
        term.feed(b"\x1b[?2004h");
        assert_eq!(
            term.encode_paste("hi\nthere").unwrap(),
            b"\x1b[200~hi\rthere\x1b[201~"
        );
    }

    #[test]
    fn resize_reflows_primary_screen() {
        let mut term = model(20, 4);
        term.feed(b"abcdefghijklmnopqrstuvwxyz");
        assert_eq!(term.frame().unwrap().row_text(0), "abcdefghijklmnopqrst");
        term.resize(10, 4, 8, 17).unwrap();
        let text = term.frame().unwrap().text();
        assert_eq!(text[0], "abcdefghij");
        assert_eq!(text[1], "klmnopqrst");
        assert_eq!(text[2], "uvwxyz");
    }

    #[test]
    fn alternate_screen_does_not_reflow() {
        let mut term = model(20, 4);
        term.feed(b"\x1b[?1049h\x1b[2J\x1b[HABCDEFGHIJKLMNOPQRST");
        assert_eq!(term.frame().unwrap().row_text(0), "ABCDEFGHIJKLMNOPQRST");
        term.resize(10, 4, 8, 17).unwrap();
        assert_eq!(term.frame().unwrap().row_text(0), "ABCDEFGHIJ");
    }

    #[test]
    fn grapheme_widths_match_ghostty_tables() {
        let mut term = model(20, 3);
        term.feed("A世界🙂e\u{301}Z".as_bytes());
        let frame = term.frame().unwrap();
        // A narrow, CJK wide, emoji wide, e+combining one cluster, Z narrow.
        assert!(!frame.cell(0, 0).unwrap().wide);
        assert!(frame.cell(1, 0).unwrap().wide);
        assert!(frame.cell(3, 0).unwrap().wide);
        assert!(frame.cell(5, 0).unwrap().wide);
        assert_eq!(frame.cell(5, 0).unwrap().text.as_str(), "🙂");
        assert_eq!(frame.cell(7, 0).unwrap().text.as_str(), "e\u{301}");
        assert_eq!(frame.cell(8, 0).unwrap().text.as_str(), "Z");
    }

    #[test]
    fn selection_formats_and_copies() {
        let mut term = model(20, 3);
        term.feed(b"\x1b[2J\x1b[Hhello world\r\nsecond");
        term.set_selection((0, 0), (10, 0)).unwrap();
        let text = term.selection_text().unwrap().unwrap();
        assert_eq!(text, "hello world");
        assert!(term.has_selection());
        term.clear_selection().unwrap();
        assert!(!term.has_selection());
    }

    #[test]
    fn search_finds_and_selects_matches() {
        let mut term = model(30, 4);
        term.feed(b"one two three two\r\nfour two");
        let info = term.search_set("two").unwrap();
        assert_eq!(info.total, 3);
        assert!(info.selected.is_some());
        let next = term.search_next().unwrap();
        assert_eq!(next.total, 3);
        let prev = term.search_prev().unwrap();
        assert_eq!(prev.total, 3);
        term.search_clear().unwrap();
        assert!(!term.has_selection());
    }

    #[test]
    fn ctrl_and_alt_keys_use_ghostty_encoding() {
        let mut term = model(20, 3);
        assert_eq!(
            term.encode_key(
                key::Key::C,
                Mods::CTRL,
                key::Action::Press,
                None,
                None,
                false
            )
            .unwrap(),
            vec![3]
        );
        assert_eq!(
            term.encode_key(
                key::Key::B,
                Mods::ALT,
                key::Action::Press,
                Some("b"),
                Some('b'),
                false
            )
            .unwrap(),
            b"\x1bb"
        );
    }
}
