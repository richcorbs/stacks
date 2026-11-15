//! Deterministic screen dump + key-script replay for agents and golden tests.

use std::io::Write;

use ratatui::{Terminal, backend::TestBackend};

use crate::{app::App, keys::Key, render};

pub fn dump(app: &mut App, cols: u16, rows: u16) -> String {
    let backend = TestBackend::new(cols.max(2), rows.max(2));
    let mut terminal = Terminal::new(backend).expect("test backend");
    terminal
        .draw(|frame| render::draw(frame, app))
        .expect("draw frame");
    let buffer = terminal.backend().buffer();
    let area = buffer.area;
    let mut output = String::new();
    for y in 0..area.height {
        let mut line = String::new();
        for x in 0..area.width {
            line.push_str(buffer[(x, y)].symbol());
        }
        output.push_str(line.trim_end());
        output.push('\n');
    }
    output
}

pub fn assert_screen(
    app: &mut App,
    cols: u16,
    rows: u16,
    needle: &str,
    present: bool,
) -> Result<(), String> {
    let screen = dump(app, cols, rows);
    if screen.contains(needle) == present {
        Ok(())
    } else if present {
        Err(format!("expected screen to contain {needle:?}\n{screen}"))
    } else {
        Err(format!(
            "expected screen not to contain {needle:?}\n{screen}"
        ))
    }
}

/// Replay a key script:
///
/// ```text
/// key ctrl-p
/// type Arcasa
/// key enter
/// wait 200
/// assert contains #325
/// ```
pub fn run_script(
    app: &mut App,
    lines: &[String],
    cols: &mut u16,
    rows: &mut u16,
) -> Result<Vec<String>, String> {
    let mut dumps = Vec::new();
    for (index, raw) in lines.iter().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (command, rest) = line
            .split_once(char::is_whitespace)
            .map(|(command, rest)| (command, rest.trim()))
            .unwrap_or((line, ""));
        let context = |error: String| format!("script line {}: {error}", index + 1);
        match command {
            "key" => {
                let key = Key::parse(rest)
                    .ok_or_else(|| context(format!("unknown key token {rest:?}")))?;
                app.handle_key(key);
                app.tick();
                app.pump(250);
            }
            "type" => {
                app.type_text(rest);
                app.tick();
            }
            "paste" => {
                app.handle_paste(rest.replace("\\n", "\n"));
                app.tick();
                app.pump(250);
            }
            "sleep" | "wait" => {
                let millis: u64 = rest
                    .parse()
                    .map_err(|_| context(format!("invalid wait duration {rest:?}")))?;
                app.wait(millis);
            }
            "resize" => {
                let mut parts = rest.split_whitespace();
                *cols = parts
                    .next()
                    .and_then(|value| value.parse().ok())
                    .ok_or_else(|| context("resize needs cols rows".into()))?;
                *rows = parts
                    .next()
                    .and_then(|value| value.parse().ok())
                    .ok_or_else(|| context("resize needs cols rows".into()))?;
            }
            "dump" => {
                let screen = dump(app, *cols, *rows);
                print!("{screen}");
                let _ = std::io::stdout().flush();
                dumps.push(screen);
            }
            "assert" => {
                let (mode, needle) = rest
                    .split_once(char::is_whitespace)
                    .map(|(mode, needle)| (mode, needle.trim()))
                    .unwrap_or((rest, ""));
                let present = match mode {
                    "contains" => true,
                    "not-contains" => false,
                    "empty" => {
                        let screen = dump(app, *cols, *rows);
                        if screen.trim().is_empty() {
                            continue;
                        }
                        return Err(context(format!("expected an empty screen\n{screen}")));
                    }
                    other => return Err(context(format!("unknown assertion {other:?}"))),
                };
                assert_screen(app, *cols, *rows, needle, present).map_err(context)?;
            }
            other => return Err(context(format!("unknown script command {other:?}"))),
        }
    }
    app.tick();
    app.pump(1_000);
    Ok(dumps)
}
