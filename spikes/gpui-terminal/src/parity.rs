//! Shared parity corpus runner.
//!
//! The same JSON corpus is replayed here and in xterm.js by
//! `parity/run.mjs`; both sides emit the snapshot shape defined below.

use std::path::Path;

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};

use crate::terminal_model::{CellText, ColorSource, Frame, TerminalModel};

#[derive(Clone, Debug, Deserialize)]
pub struct Corpus {
    pub cases: Vec<Case>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Case {
    pub name: String,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub steps: Vec<Step>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Step {
    pub name: String,
    #[serde(flatten)]
    pub action: Action,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Action {
    Write {
        text: String,
    },
    /// Raw PTY bytes, base64-encoded so TUI transcripts survive invalid UTF-8.
    WriteBase64 {
        data: String,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    Scroll {
        delta: isize,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct Run {
    pub palette: Vec<[u8; 3]>,
    pub cases: Vec<CaseRun>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CaseRun {
    pub name: String,
    pub cols: u16,
    pub rows: u16,
    pub steps: Vec<StepRun>,
}

#[derive(Clone, Debug, Serialize)]
pub struct StepRun {
    pub name: String,
    pub snapshot: Snapshot,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Snapshot {
    pub cols: u16,
    pub rows: u16,
    pub screen: String,
    pub cursor: CursorSnap,
    pub scrollbar_total: u64,
    pub scrollbar_offset: u64,
    pub title: String,
    pub bells: usize,
    pub clipboard: Option<String>,
    pub rows_data: Vec<RowSnap>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct CursorSnap {
    pub x: u16,
    pub y: u16,
    pub visible: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct RowSnap {
    pub text: String,
    pub cells: Vec<CellSnap>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct CellSnap {
    pub text: String,
    /// xterm.js width: 2 wide, 1 narrow, 0 wide-tail spacer.
    pub width: u8,
    pub fg: ColorSnap,
    pub bg: ColorSnap,
    pub bold: bool,
    pub italic: bool,
    pub faint: bool,
    pub underline: bool,
    pub strikethrough: bool,
    pub inverse: bool,
    pub invisible: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ColorSnap {
    Default,
    Palette { index: u8 },
    Rgb { r: u8, g: u8, b: u8 },
}

impl From<ColorSource> for ColorSnap {
    fn from(color: ColorSource) -> Self {
        match color {
            ColorSource::Default => Self::Default,
            ColorSource::Palette(index) => Self::Palette { index },
            ColorSource::Rgb(color) => Self::Rgb {
                r: color.r,
                g: color.g,
                b: color.b,
            },
        }
    }
}

fn cell_text(text: CellText) -> String {
    text.as_str().to_string()
}

pub fn snapshot(frame: &Frame, title: &str, bells: usize, clipboard: &Option<String>) -> Snapshot {
    let rows_data = (0..frame.rows)
        .map(|y| {
            let cells = (0..frame.cols)
                .map(|x| {
                    let cell = frame.cell(x, y).expect("cell inside frame");
                    CellSnap {
                        text: cell_text(cell.text),
                        width: if cell.spacer_tail {
                            0
                        } else if cell.wide {
                            2
                        } else {
                            1
                        },
                        fg: cell.fg_source.into(),
                        bg: cell.bg_source.into(),
                        bold: cell.bold,
                        italic: cell.italic,
                        faint: cell.faint,
                        underline: cell.underline,
                        strikethrough: cell.strikethrough,
                        inverse: cell.inverse,
                        invisible: cell.invisible,
                    }
                })
                .collect();
            RowSnap {
                text: frame.row_text(y),
                cells,
            }
        })
        .collect();

    Snapshot {
        cols: frame.cols,
        rows: frame.rows,
        screen: match frame.screen {
            ghostty_vt::screen::Screen::Primary => "normal".into(),
            ghostty_vt::screen::Screen::Alternate => "alternate".into(),
        },
        cursor: CursorSnap {
            x: frame.cursor.map_or(0, |cursor| cursor.x),
            y: frame.cursor.map_or(0, |cursor| cursor.y),
            visible: frame.cursor.is_some_and(|cursor| cursor.visible),
        },
        scrollbar_total: frame.scrollbar_total,
        scrollbar_offset: frame.scrollbar_offset,
        title: title.to_string(),
        bells,
        clipboard: clipboard.clone(),
        rows_data,
    }
}

pub fn run_corpus(corpus: &Corpus) -> Result<Run> {
    let mut cases = Vec::with_capacity(corpus.cases.len());
    for case in &corpus.cases {
        let mut model = TerminalModel::new(case.cols, case.rows, 10_000_000)
            .with_context(|| format!("create model for {}", case.name))?;
        let mut title = String::new();
        let mut bells = 0usize;
        let mut clipboard = None;
        let mut steps = Vec::with_capacity(case.steps.len());
        for step in &case.steps {
            match &step.action {
                Action::Write { text } => {
                    let effects = model.feed(text.as_bytes());
                    bells += effects.bells;
                    if let Some(next_title) = effects.titles.last() {
                        title = next_title.clone();
                    }
                    if let Some(next_clipboard) = effects.clipboard.last() {
                        clipboard = Some(next_clipboard.clone());
                    }
                }
                Action::WriteBase64 { data } => {
                    use base64::Engine as _;
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .with_context(|| format!("decode base64 step {}", step.name))?;
                    let effects = model.feed(&bytes);
                    bells += effects.bells;
                    if let Some(next_title) = effects.titles.last() {
                        title = next_title.clone();
                    }
                    if let Some(next_clipboard) = effects.clipboard.last() {
                        clipboard = Some(next_clipboard.clone());
                    }
                }
                Action::Resize { cols, rows } => {
                    model.resize(*cols, *rows, 8, 18)?;
                }
                Action::Scroll { delta } => model.scroll(*delta),
            }
            let frame = model.frame()?;
            steps.push(StepRun {
                name: step.name.clone(),
                snapshot: snapshot(frame, &title, bells, &clipboard),
            });
        }
        cases.push(CaseRun {
            name: case.name.clone(),
            cols: case.cols,
            rows: case.rows,
            steps,
        });
    }
    let palette = crate::terminal_model::stacks_default_palette()
        .0
        .iter()
        .map(|color| [color.r, color.g, color.b])
        .collect();
    Ok(Run { palette, cases })
}

pub fn load(path: &Path) -> Result<Corpus> {
    let data =
        std::fs::read_to_string(path).with_context(|| format!("read corpus {}", path.display()))?;
    serde_json::from_str(&data).with_context(|| format!("parse corpus {}", path.display()))
}

pub fn write_run(run: &Run, path: &Path) -> Result<()> {
    let data = serde_json::to_string(run)?;
    std::fs::write(path, data).with_context(|| format!("write run {}", path.display()))
}
