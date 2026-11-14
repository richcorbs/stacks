use std::{env, path::PathBuf};

use anyhow::{Context as _, Result};
use serde::Deserialize;
use stacks_terminal::terminal_model::TerminalModel;

#[derive(Deserialize)]
struct Case {
    name: String,
    cols: u16,
    rows: u16,
    text: String,
    start: (u16, u16),
    end: (u16, u16),
}

fn main() -> Result<()> {
    let path = PathBuf::from(
        env::args()
            .nth(1)
            .context("usage: selection_parity <cases.json>")?,
    );
    let cases: Vec<Case> = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    let mut out = Vec::new();
    for case in cases {
        let mut model = TerminalModel::new(case.cols, case.rows, 1_000_000)?;
        model.feed(case.text.as_bytes());
        model.set_selection(case.start, case.end)?;
        let text = model.selection_text()?.unwrap_or_default();
        out.push(serde_json::json!({ "name": case.name, "text": text }));
    }
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}
