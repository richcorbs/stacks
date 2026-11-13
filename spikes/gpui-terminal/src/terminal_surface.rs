//! Reusable GPUI terminal surface: cell metrics, text-run shaping, cursor and
//! marked-text painting. The host app owns lifecycle/input; this module owns
//! the pixels derived from `TerminalModel::frame`.

use gpui::{
    App, Bounds, Font, FontStyle, FontWeight, Hsla, Pixels, Point, ShapedLine, StrikethroughStyle,
    TextRun, UnderlineStyle, Window, fill, font, point, px, rgb, rgba, size,
};

use crate::terminal_model::{CursorStyle, DEFAULT_BG, DEFAULT_FG, FONT_SIZE, Frame, TerminalModel};

pub const PADDING: f32 = 10.0;
pub const FONT_FAMILY: &str = "Menlo";
pub const CELL_LINE_HEIGHT: f32 = 18.0;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TerminalMetrics {
    pub bounds: Option<Bounds<Pixels>>,
    pub cell_width: f32,
    pub cell_height: f32,
    pub cols: u16,
    pub rows: u16,
}

impl TerminalMetrics {
    pub fn cell_at(&self, position: Point<Pixels>) -> Option<(u16, u16)> {
        let bounds = self.bounds?;
        if self.cell_width <= 0.0 || self.cell_height <= 0.0 {
            return None;
        }
        let local_x = f32::from(position.x - bounds.left()) - PADDING;
        let local_y = f32::from(position.y - bounds.top()) - PADDING;
        if local_x < 0.0 || local_y < 0.0 {
            return None;
        }
        let x = (local_x / self.cell_width).floor() as u16;
        let y = (local_y / self.cell_height).floor() as u16;
        if x >= self.cols || y >= self.rows {
            return None;
        }
        Some((x, y))
    }
}

struct RowBuild {
    text: String,
    runs: Vec<TextRun>,
}

/// Resize the emulator to the cell grid that fits `bounds`, then materialize
/// shaped rows for painting. Callers still own PTY resize and focus policy.
pub fn prepare_frame(
    model: &mut TerminalModel,
    bounds: Bounds<Pixels>,
    marked_text: &str,
    cursor_phase: bool,
    window: &mut Window,
) -> (TerminalMetrics, PreparedFrame) {
    let font = font(FONT_FAMILY);
    let font_size = px(FONT_SIZE);
    let text_system = window.text_system().clone();
    let font_id = text_system.resolve_font(&font);
    let cell_width = text_system
        .ch_advance(font_id, font_size)
        .map(f32::from)
        .unwrap_or(FONT_SIZE * 0.62)
        .max(1.0);
    let cell_height = CELL_LINE_HEIGHT;
    let cols =
        (((f32::from(bounds.size.width) - PADDING * 2.0) / cell_width).floor() as u16).max(2);
    let rows =
        (((f32::from(bounds.size.height) - PADDING * 2.0) / cell_height).floor() as u16).max(1);
    let metrics = TerminalMetrics {
        bounds: Some(bounds),
        cell_width,
        cell_height,
        cols,
        rows,
    };

    if let Err(error) = model.resize(
        cols,
        rows,
        cell_width.round() as u32,
        cell_height.round() as u32,
    ) {
        eprintln!("terminal resize: {error:#}");
    }

    let builds = match model.frame() {
        Ok(frame) => build_rows(frame, &font),
        Err(error) => {
            eprintln!("terminal frame: {error:#}");
            Vec::new()
        }
    };
    let cursor = model.frame().ok().and_then(|frame| frame.cursor);
    let cursor_color = model
        .frame()
        .map(|frame| frame.cursor_color)
        .unwrap_or(DEFAULT_FG);
    let default_bg = model.frame().map(|frame| frame.bg).unwrap_or(DEFAULT_BG);

    let mut lines = Vec::with_capacity(builds.len());
    for build in builds {
        lines.push(text_system.shape_line(build.text.into(), font_size, &build.runs, None));
    }

    let marked = if marked_text.is_empty() {
        None
    } else {
        let run = TextRun {
            len: marked_text.len(),
            font: font.clone(),
            color: rgb(0xf0f4f8).into(),
            background_color: Some(rgb(0x173754).into()),
            underline: Some(underline_style()),
            strikethrough: None,
        };
        Some(text_system.shape_line(marked_text.to_owned().into(), font_size, &[run], None))
    };

    (
        metrics,
        PreparedFrame {
            lines,
            cursor: cursor.filter(|cursor| cursor.visible && (cursor_phase || !cursor.blinking)),
            cursor_color,
            default_bg,
            cell_width,
            cell_height,
            marked,
            marked_pos: cursor.map(|cursor| (cursor.x, cursor.y)),
        },
    )
}

pub struct PreparedFrame {
    lines: Vec<ShapedLine>,
    cursor: Option<crate::terminal_model::Cursor>,
    cursor_color: ghostty_vt::style::RgbColor,
    default_bg: ghostty_vt::style::RgbColor,
    cell_width: f32,
    cell_height: f32,
    marked: Option<ShapedLine>,
    marked_pos: Option<(u16, u16)>,
}

impl Default for PreparedFrame {
    fn default() -> Self {
        Self {
            lines: Vec::new(),
            cursor: None,
            cursor_color: DEFAULT_FG,
            default_bg: DEFAULT_BG,
            cell_width: 8.0,
            cell_height: CELL_LINE_HEIGHT,
            marked: None,
            marked_pos: None,
        }
    }
}

impl PreparedFrame {
    pub fn paint(self, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut App) {
        let bg: Hsla = color(self.default_bg);
        window.paint_quad(fill(bounds, bg));
        let origin = point(bounds.left() + px(PADDING), bounds.top() + px(PADDING));
        let line_height = px(self.cell_height);

        for (index, line) in self.lines.iter().enumerate() {
            let row_origin = point(origin.x, origin.y + px(index as f32 * self.cell_height));
            let _ = line.paint_background(row_origin, line_height, window, cx);
        }

        if let Some(cursor) = self.cursor {
            let x = origin.x + px(f32::from(cursor.x) * self.cell_width);
            let y = origin.y + px(f32::from(cursor.y) * self.cell_height);
            let cursor_color: Hsla = rgba({
                let ghostty_vt::style::RgbColor { r, g, b } = self.cursor_color;
                (u32::from(r) << 24) | (u32::from(g) << 16) | (u32::from(b) << 8) | 0x99
            })
            .into();
            match cursor.style {
                CursorStyle::Block => {
                    window.paint_quad(fill(
                        Bounds {
                            origin: point(x, y),
                            size: size(px(self.cell_width), line_height),
                        },
                        cursor_color,
                    ));
                }
                CursorStyle::Bar => {
                    window.paint_quad(fill(
                        Bounds {
                            origin: point(x, y),
                            size: size(px(2.0), line_height),
                        },
                        cursor_color,
                    ));
                }
                CursorStyle::Underline | CursorStyle::Hollow => {
                    window.paint_quad(fill(
                        Bounds {
                            origin: point(x, y + line_height - px(2.0)),
                            size: size(px(self.cell_width), px(2.0)),
                        },
                        cursor_color,
                    ));
                    if cursor.style == CursorStyle::Hollow {
                        window.paint_quad(fill(
                            Bounds {
                                origin: point(x, y),
                                size: size(px(self.cell_width), px(1.0)),
                            },
                            cursor_color,
                        ));
                    }
                }
            }
        }

        for (index, line) in self.lines.iter().enumerate() {
            let row_origin = point(origin.x, origin.y + px(index as f32 * self.cell_height));
            let _ = line.paint(row_origin, line_height, window, cx);
        }

        if let (Some(marked), Some((x, y))) = (self.marked, self.marked_pos) {
            let marked_origin = point(
                origin.x + px(f32::from(x) * self.cell_width),
                origin.y + px(f32::from(y) * self.cell_height),
            );
            let _ = marked.paint_background(marked_origin, line_height, window, cx);
            let _ = marked.paint(marked_origin, line_height, window, cx);
        }
    }
}

fn build_rows(frame: &Frame, font: &Font) -> Vec<RowBuild> {
    let base = font.clone();
    let mut rows = Vec::with_capacity(usize::from(frame.rows));
    for y in 0..frame.rows {
        let mut text = String::with_capacity(usize::from(frame.cols) * 2);
        let mut runs: Vec<TextRun> = Vec::new();
        let mut run_len = 0usize;
        let mut last: Option<(
            ghostty_vt::style::RgbColor,
            ghostty_vt::style::RgbColor,
            bool,
            bool,
            bool,
            bool,
        )> = None;
        for x in 0..frame.cols {
            let Some(cell) = frame.cell(x, y) else { break };
            if cell.spacer_tail {
                continue;
            }
            let piece = if cell.text.as_str().is_empty() {
                " "
            } else {
                cell.text.as_str()
            };
            let key = (
                cell.fg,
                cell.bg,
                cell.bold,
                cell.italic,
                cell.underline,
                cell.strikethrough,
            );
            if last != Some(key) {
                if run_len > 0
                    && let Some(previous) = last
                {
                    runs.push(text_run(
                        run_len, &base, previous.0, previous.1, previous.2, previous.3, previous.4,
                        previous.5, frame.bg,
                    ));
                }
                run_len = 0;
                last = Some(key);
            }
            text.push_str(piece);
            run_len += piece.len();
        }
        if run_len > 0
            && let Some(previous) = last
        {
            runs.push(text_run(
                run_len, &base, previous.0, previous.1, previous.2, previous.3, previous.4,
                previous.5, frame.bg,
            ));
        }
        rows.push(RowBuild { text, runs });
    }
    rows
}

#[allow(clippy::too_many_arguments)]
fn text_run(
    len: usize,
    base: &Font,
    fg: ghostty_vt::style::RgbColor,
    bg: ghostty_vt::style::RgbColor,
    bold: bool,
    italic: bool,
    underline: bool,
    strikethrough: bool,
    default_bg: ghostty_vt::style::RgbColor,
) -> TextRun {
    let mut font = base.clone();
    if bold {
        font.weight = FontWeight::BOLD;
    }
    if italic {
        font.style = FontStyle::Italic;
    }
    TextRun {
        len,
        font,
        color: color(fg),
        background_color: (bg != default_bg).then(|| color(bg)),
        underline: underline.then(underline_style),
        strikethrough: strikethrough.then(strikethrough_style),
    }
}

fn underline_style() -> UnderlineStyle {
    UnderlineStyle {
        thickness: px(1.0),
        color: None,
        wavy: false,
    }
}

fn strikethrough_style() -> StrikethroughStyle {
    StrikethroughStyle {
        thickness: px(1.0),
        color: None,
    }
}

fn color(rgb_color: ghostty_vt::style::RgbColor) -> Hsla {
    rgb((u32::from(rgb_color.r) << 16) | (u32::from(rgb_color.g) << 8) | u32::from(rgb_color.b))
        .into()
}
