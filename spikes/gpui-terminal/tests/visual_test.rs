//! Deterministic visual golden for the terminal grid.
//!
//! gpui 0.2.2 does not publish Zed's `visual_test` platform API. This test
//! rasterizes the exact Frame handed to the GPUI paint path (colors, glyphs,
//! wide-cell geometry, cursor) into SVG, so changes to the render model are
//! visible in review. It is a model-level visual test, not a Metal readback.

use stacks_gpui_terminal_spike::{
    fixtures::demo_fixture,
    terminal_model::{Frame, TerminalModel},
};
use std::path::PathBuf;

const WIDTH: f32 = 1120.0;
const HEIGHT: f32 = 720.0;
const TAB_BAR: f32 = 38.0;
const PAD: f32 = 10.0;
const CELL_W: f32 = 8.4;
const CELL_H: f32 = 18.0;

fn hex(c: ghostty_vt::style::RgbColor) -> String {
    format!("#{:02x}{:02x}{:02x}", c.r, c.g, c.b)
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn render_svg(frame: &Frame) -> String {
    let mut svg = String::new();
    svg.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{WIDTH}\" height=\"{HEIGHT}\" viewBox=\"0 0 {WIDTH} {HEIGHT}\">\n"
    ));
    svg.push_str("<rect width=\"1120\" height=\"720\" fill=\"#0f141b\"/>\n");
    // Tab bar
    svg.push_str("<rect width=\"1120\" height=\"38\" fill=\"#141a22\"/>\n");
    svg.push_str("<rect y=\"37\" width=\"1120\" height=\"1\" fill=\"#24303d\"/>\n");
    svg.push_str("<rect x=\"8\" y=\"6\" width=\"224\" height=\"26\" rx=\"6\" fill=\"#233447\" stroke=\"#3b5e7d\"/>\n");
    svg.push_str("<text x=\"16\" y=\"24\" font-family=\"Menlo, monospace\" font-size=\"12\" fill=\"#e3edf6\">1  spike · truecolor</text>\n");
    svg.push_str("<rect x=\"238\" y=\"6\" width=\"62\" height=\"26\" rx=\"6\" fill=\"#161d26\" stroke=\"#202a35\"/>\n");
    svg.push_str("<text x=\"246\" y=\"24\" font-family=\"Menlo, monospace\" font-size=\"12\" fill=\"#8699aa\">2  second</text>\n");
    svg.push_str("<text x=\"310\" y=\"24\" font-family=\"Menlo, monospace\" font-size=\"14\" fill=\"#8fb4d4\">+</text>\n");
    svg.push_str("<text x=\"900\" y=\"24\" font-family=\"Menlo, monospace\" font-size=\"10\" fill=\"#62778a\">⌘T hide · ⇧⌘T new · ⌘W close</text>\n");
    svg.push_str("<text x=\"1092\" y=\"24\" font-family=\"Menlo, monospace\" font-size=\"14\" fill=\"#93a7b8\">×</text>\n");

    // Cell backgrounds. Wide cells paint two columns; tail spacers are skipped.
    for y in 0..frame.rows {
        for x in 0..frame.cols {
            let Some(cell) = frame.cell(x, y) else { break };
            if cell.spacer_tail {
                continue;
            }
            if cell.bg != frame.bg {
                let w = if cell.wide { CELL_W * 2.0 } else { CELL_W };
                svg.push_str(&format!(
                    "<rect x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" fill=\"{}\"/>\n",
                    PAD + f32::from(x) * CELL_W,
                    TAB_BAR + PAD + f32::from(y) * CELL_H,
                    w,
                    CELL_H,
                    hex(cell.bg)
                ));
            }
        }
    }

    // Text, one row at a time, with spans grouped by color and weight.
    for y in 0..frame.rows {
        let mut spans = String::new();
        let mut current: Option<(String, bool, bool, bool, bool)> = None;
        let mut run = String::new();
        let flush = |spans: &mut String,
                     run: &mut String,
                     style: &Option<(String, bool, bool, bool, bool)>| {
            if run.is_empty() {
                return;
            }
            if let Some((color, bold, italic, underline, strike)) = style {
                spans.push_str(&format!(
                    "<tspan fill=\"{color}\"{}>{}",
                    if *bold { " font-weight=\"bold\"" } else { "" },
                    escape(run)
                ));
                if *italic {
                    spans.push_str("</tspan><tspan font-style=\"italic\">");
                }
                if *underline || *strike {
                    spans.push_str(&format!(
                        "</tspan><tspan{}>",
                        if *underline {
                            " text-decoration=\"underline\""
                        } else {
                            " text-decoration=\"line-through\""
                        }
                    ));
                }
                spans.push_str("</tspan>");
            }
            run.clear();
        };
        for x in 0..frame.cols {
            let Some(cell) = frame.cell(x, y) else { break };
            if cell.spacer_tail || cell.text.as_str().is_empty() {
                run.push(' ');
                continue;
            }
            let style = (
                hex(cell.fg),
                cell.bold,
                cell.italic,
                cell.underline,
                cell.strikethrough,
            );
            if current.as_ref() != Some(&style) {
                flush(&mut spans, &mut run, &current);
                current = Some(style);
            }
            run.push_str(cell.text.as_str());
        }
        flush(&mut spans, &mut run, &current);
        let trimmed = spans.trim_end();
        if !trimmed.is_empty() {
            svg.push_str(&format!(
                "<text x=\"{:.1}\" y=\"{:.1}\" font-family=\"Menlo, monospace\" font-size=\"14\" xml:space=\"preserve\">{}</text>\n",
                PAD,
                TAB_BAR + PAD + f32::from(y) * CELL_H + 13.0,
                spans
            ));
        }
    }

    if let Some(cursor) = frame.cursor.filter(|cursor| cursor.visible) {
        svg.push_str(&format!(
            "<rect x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" fill=\"#7fb3e899\"/>\n",
            PAD + f32::from(cursor.x) * CELL_W,
            TAB_BAR + PAD + f32::from(cursor.y) * CELL_H,
            CELL_W,
            CELL_H
        ));
    }
    svg.push_str("</svg>\n");
    svg
}

#[test]
fn golden_visual_test() {
    let mut model = TerminalModel::new(120, 36, 1_000_000).unwrap();
    model.feed(demo_fixture().as_bytes());
    let frame = model.frame().unwrap();
    assert!(frame.row_text(0).contains("stacks-card-318"));
    assert!(
        frame
            .text()
            .iter()
            .any(|line| line.contains("GPUI + libghostty-vt"))
    );
    assert!(frame.text().iter().any(|line| line.contains("世界")));

    let svg = render_svg(frame);
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let generated = dir.join("visual-tests/generated.svg");
    let golden = dir.join("visual-tests/golden.svg");
    std::fs::write(&generated, &svg).unwrap();
    if std::env::var_os("UPDATE_VISUAL").is_some() {
        std::fs::write(&golden, &svg).unwrap();
    }
    let expected = std::fs::read_to_string(&golden).expect(
        "visual-tests/golden.svg missing; run UPDATE_VISUAL=1 cargo test --test visual_test",
    );
    assert_eq!(svg, expected, "visual golden changed: review {generated:?}");
}
