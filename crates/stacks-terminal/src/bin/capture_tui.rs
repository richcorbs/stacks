//! Capture real TUI/PTY transcripts as a parity corpus.
//!
//! Usage: cargo run --quiet --bin capture_tui > parity/corpus-tui.json

use std::{
    io::{Read, Write},
    sync::mpsc,
    time::{Duration, Instant},
};

use anyhow::{Context as _, Result};
use base64::Engine as _;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde_json::json;

struct Capture {
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    rx: mpsc::Receiver<Vec<u8>>,
}

impl Capture {
    fn spawn(argv: &[&str], envs: &[(&str, &str)]) -> Result<Self> {
        let pair = native_pty_system().openpty(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut command = CommandBuilder::new(argv[0]);
        command.args(&argv[1..]);
        command.cwd(std::env::temp_dir());
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("LANG", "en_US.UTF-8");
        for (key, value) in envs {
            command.env(key, value);
        }
        let child = pair.slave.spawn_command(command)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Ok(Self { writer, child, rx })
    }

    fn send(&mut self, bytes: &[u8]) {
        let _ = self.writer.write_all(bytes);
        let _ = self.writer.flush();
    }

    fn drain(&mut self, duration: Duration) -> Vec<Vec<u8>> {
        let deadline = Instant::now() + duration;
        let mut chunks = Vec::new();
        while Instant::now() < deadline {
            match self.rx.recv_timeout(Duration::from_millis(30)) {
                Ok(data) => chunks.push(data),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        chunks
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn b64(chunks: Vec<Vec<u8>>) -> Vec<serde_json::Value> {
    chunks
        .into_iter()
        .enumerate()
        .map(|(index, chunk)| {
            json!({
                "name": format!("chunk-{index:03}"),
                "op": "write_base64",
                "data": base64::engine::general_purpose::STANDARD.encode(chunk),
            })
        })
        .collect()
}

fn main() -> Result<()> {
    let mut cases = Vec::new();

    let vim_path =
        std::env::temp_dir().join(format!("stacks-parity-vim-{}.txt", std::process::id()));
    let vim_path_string = vim_path.to_string_lossy().to_string();
    let mut vim = Capture::spawn(
        &["vim", "-Nu", "NONE", "-n", "-i", "NONE", &vim_path_string],
        &[],
    )
    .context("spawn vim")?;
    let mut vim_steps = vim.drain(Duration::from_millis(1200));
    vim.send("iEDITOR 世界🙂 e\u{301}\x1b".as_bytes());
    vim_steps.extend(vim.drain(Duration::from_millis(800)));
    vim.send(b":q!\r");
    vim_steps.extend(vim.drain(Duration::from_millis(600)));
    drop(vim);
    let _ = std::fs::remove_file(vim_path);
    cases.push(json!({
        "name": "tui-vim-transcript",
        "cols": 120,
        "rows": 40,
        "steps": b64(vim_steps),
    }));

    let mut less = Capture::spawn(&["/bin/sh", "-c", "seq 1 500 | less"], &[("LESS", "FR")])
        .context("spawn less")?;
    let mut less_steps = less.drain(Duration::from_millis(800));
    less.send(b"q");
    less_steps.extend(less.drain(Duration::from_millis(500)));
    drop(less);
    cases.push(json!({
        "name": "tui-less-transcript",
        "cols": 120,
        "rows": 40,
        "steps": b64(less_steps),
    }));

    let repo = env!("CARGO_MANIFEST_DIR");
    let command = format!(
        "cd {repo}/../.. && git --no-pager log -5 --oneline --decorate && printf '\\n--- status ---\\n' && git status --short | head -20"
    );
    let mut git = Capture::spawn(&["/bin/sh", "-c", &command], &[]).context("spawn git")?;
    let git_steps = git.drain(Duration::from_millis(1200));
    drop(git);
    cases.push(json!({
        "name": "tui-git-log-transcript",
        "cols": 120,
        "rows": 40,
        "steps": b64(git_steps),
    }));

    let mut top = Capture::spawn(&["/usr/bin/top"], &[]).context("spawn top")?;
    let mut top_steps = top.drain(Duration::from_millis(1200));
    top.send(b"q");
    top_steps.extend(top.drain(Duration::from_millis(400)));
    drop(top);
    cases.push(json!({
        "name": "tui-top-transcript",
        "cols": 120,
        "rows": 40,
        "steps": b64(top_steps),
    }));

    println!(
        "{}",
        serde_json::to_string_pretty(&json!({ "cases": cases }))?
    );
    Ok(())
}
