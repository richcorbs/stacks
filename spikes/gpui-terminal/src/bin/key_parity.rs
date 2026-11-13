use std::{env, path::PathBuf};

use anyhow::{Context as _, Result};
use base64::Engine as _;
use ghostty_vt::key::{Action, Key, Mods};
use serde::Deserialize;
use stacks_gpui_terminal_spike::terminal_model::TerminalModel;

#[derive(Deserialize)]
struct KeyCase {
    name: String,
    key: String,
    mods: Vec<String>,
    text: Option<String>,
    #[serde(default)]
    setup: Option<String>,
}

fn ghostty_key(name: &str) -> Option<Key> {
    Some(match name {
        "A" => Key::A,
        "B" => Key::B,
        "C" => Key::C,
        "D" => Key::D,
        "E" => Key::E,
        "F" => Key::F,
        "L" => Key::L,
        "Z" => Key::Z,
        "Space" => Key::Space,
        "Backslash" => Key::Backslash,
        "Backspace" => Key::Backspace,
        "Enter" => Key::Enter,
        "Tab" => Key::Tab,
        "Escape" => Key::Escape,
        "Delete" => Key::Delete,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "ArrowUp" => Key::ArrowUp,
        "ArrowDown" => Key::ArrowDown,
        "ArrowLeft" => Key::ArrowLeft,
        "ArrowRight" => Key::ArrowRight,
        "F1" => Key::F1,
        "F5" => Key::F5,
        "F12" => Key::F12,
        _ => return None,
    })
}

fn main() -> Result<()> {
    let path = PathBuf::from(
        env::args()
            .nth(1)
            .context("usage: key_parity <key-cases.json>")?,
    );
    let cases: Vec<KeyCase> = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    let mut out = Vec::new();
    for case in cases {
        let mut model = TerminalModel::new(80, 24, 1_000_000)?;
        if let Some(setup) = &case.setup {
            model.feed(setup.as_bytes());
        }
        let mut mods = Mods::empty();
        for modifier in &case.mods {
            match modifier.as_str() {
                "ctrl" => mods |= Mods::CTRL,
                "alt" => mods |= Mods::ALT,
                "shift" => mods |= Mods::SHIFT,
                other => anyhow::bail!("unknown modifier {other}"),
            }
        }
        let key = ghostty_key(&case.key).with_context(|| format!("unknown key {}", case.key))?;
        let unshifted = case.text.as_deref().and_then(|text| text.chars().next());
        let bytes = model.encode_key(
            key,
            mods,
            Action::Press,
            case.text.as_deref(),
            unshifted,
            false,
        )?;
        out.push(serde_json::json!({
            "name": case.name,
            "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
        }));
    }
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}
