use std::{env, path::PathBuf};

use anyhow::{Context as _, Result};
use base64::Engine as _;
use serde::Deserialize;
use stacks_terminal::terminal_model::TerminalModel;

#[derive(Deserialize)]
struct Case {
    name: String,
    text: String,
    bracketed: bool,
}

fn main() -> Result<()> {
    let path = PathBuf::from(
        env::args()
            .nth(1)
            .context("usage: paste_parity <cases.json>")?,
    );
    let cases: Vec<Case> = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    let mut out = Vec::new();
    for case in cases {
        let mut model = TerminalModel::new(20, 4, 1_000_000)?;
        if case.bracketed {
            model.feed(b"\x1b[?2004h");
        }
        let bytes = model.encode_paste(&case.text)?;
        out.push(serde_json::json!({
            "name": case.name,
            "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
        }));
    }
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}
