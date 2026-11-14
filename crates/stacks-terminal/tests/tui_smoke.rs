//! Opt-in Unix acceptance smoke test: real TUI programs over a real PTY,
//! rendered through libghostty-vt. Missing programs skip rather than fail.

use std::{
    io::{Read, Write},
    process::Command,
    sync::mpsc,
    time::{Duration, Instant},
};

use ghostty_vt::screen::Screen;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use stacks_terminal::terminal_model::TerminalModel;

struct Harness {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    rx: mpsc::Receiver<Vec<u8>>,
    model: TerminalModel,
}

impl Harness {
    fn spawn(argv: &[&str], envs: &[(&str, &str)]) -> Option<Self> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 40,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .ok()?;
        let mut command = CommandBuilder::new(argv[0]);
        command.args(&argv[1..]);
        command.cwd(std::env::temp_dir());
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("LANG", "en_US.UTF-8");
        for (key, value) in envs {
            command.env(key, value);
        }
        let child = pair.slave.spawn_command(command).ok()?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().ok()?;
        let writer = pair.master.take_writer().ok()?;
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
        Some(Self {
            master: pair.master,
            writer,
            child,
            rx,
            model: TerminalModel::new(120, 40, 2_000_000).unwrap(),
        })
    }

    fn send(&mut self, bytes: &[u8]) {
        self.writer.write_all(bytes).unwrap();
        self.writer.flush().unwrap();
    }

    fn drain(&mut self, duration: Duration) -> String {
        let deadline = Instant::now() + duration;
        let mut output = String::new();
        while Instant::now() < deadline {
            match self.rx.recv_timeout(Duration::from_millis(50)) {
                Ok(data) => {
                    output.push_str(&String::from_utf8_lossy(&data));
                    self.model.feed(&data);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        output
    }

    fn wait_until(
        &mut self,
        timeout: Duration,
        mut predicate: impl FnMut(&mut TerminalModel) -> bool,
    ) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            match self.rx.recv_timeout(Duration::from_millis(50)) {
                Ok(data) => {
                    self.model.feed(&data);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if predicate(&mut self.model) {
                return true;
            }
        }
        false
    }

    fn text(&mut self) -> String {
        self.model
            .frame()
            .map(|frame| frame.text().join("\n"))
            .unwrap_or_default()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = self.master.resize(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
}

fn installed(program: &str) -> bool {
    Command::new("/usr/bin/which")
        .arg(program)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[test]
fn vim_renders_unicode_insert_and_restores_primary_screen() {
    if !installed("vim") {
        eprintln!("SKIP vim not installed");
        return;
    }
    let path = std::env::temp_dir().join(format!("stacks-spike-vim-{}.txt", std::process::id()));
    let path_string = path.to_string_lossy().to_string();
    let mut harness = Harness::spawn(
        &["vim", "-Nu", "NONE", "-n", "-i", "NONE", &path_string],
        &[],
    )
    .expect("spawn vim");
    assert!(
        harness.wait_until(Duration::from_secs(5), |model| {
            model.frame().ok().map(|frame| frame.screen) == Some(Screen::Alternate)
        }),
        "vim did not enter alternate screen"
    );
    harness.send(b"iEDITOR \xe4\xb8\x96\xe7\x95\x8c\xf0\x9f\x99\x82\x1b");
    let saw_text = harness.wait_until(Duration::from_secs(3), |model| {
        model
            .frame()
            .map(|frame| {
                frame
                    .text()
                    .iter()
                    .any(|line| line.contains("EDITOR 世界🙂"))
            })
            .unwrap_or(false)
    });
    assert!(saw_text, "vim did not render inserted Unicode text");
    harness.send(b":q!\r");
    let restored = harness.wait_until(Duration::from_secs(5), |model| {
        model.frame().ok().map(|frame| frame.screen) == Some(Screen::Primary)
    });
    assert!(restored, "vim did not restore primary screen");
    let _ = std::fs::remove_file(path);
    eprintln!("PASS vim unicode alternate-screen round trip");
}

#[test]
fn less_scrolls_long_output_and_restores_primary_screen() {
    if !installed("less") {
        eprintln!("SKIP less not installed");
        return;
    }
    let mut harness = Harness::spawn(&["/bin/sh", "-c", "seq 1 500 | less"], &[("LESS", "FR")])
        .expect("spawn less");
    let rendered = harness.wait_until(Duration::from_secs(5), |model| {
        model
            .frame()
            .map(|frame| {
                frame.screen == Screen::Alternate
                    && frame.text().iter().any(|line| !line.trim().is_empty())
            })
            .unwrap_or(false)
    });
    if !rendered {
        eprintln!("less text after wait:\n{}", harness.text());
    }
    assert!(rendered, "less did not render expected output");
    harness.send(b"q");
    assert!(
        harness.wait_until(Duration::from_secs(5), |model| {
            model.frame().ok().map(|frame| frame.screen) == Some(Screen::Primary)
        }),
        "less did not restore primary screen"
    );
    eprintln!("PASS less long output + quit");
}

#[test]
fn git_log_renders_through_the_same_grid() {
    if !installed("git") {
        eprintln!("SKIP git not installed");
        return;
    }
    let repo = env!("CARGO_MANIFEST_DIR");
    let command =
        format!("cd {repo} && git --no-pager log -1 --oneline && git status --short | head -3");
    let mut harness = Harness::spawn(&["/bin/sh", "-c", &command], &[]).expect("spawn git");
    let output = harness.drain(Duration::from_secs(2));
    let text = harness.text();
    assert!(
        text.lines().any(|line| !line.trim().is_empty()),
        "git produced no rendered rows; raw={output:?}"
    );
    eprintln!("PASS git log grid rows:\n{text}");
}

#[test]
fn htop_enters_and_leaves_the_alternate_screen() {
    if !installed("htop") {
        eprintln!("SKIP htop not installed");
        return;
    }
    let mut harness = Harness::spawn(&["htop"], &[("HTOPRC", "/dev/null")]).expect("spawn htop");
    assert!(
        harness.wait_until(Duration::from_secs(6), |model| {
            model.frame().ok().map(|frame| frame.screen) == Some(Screen::Alternate)
        }),
        "htop did not enter alternate screen"
    );
    harness.send(b"q");
    assert!(
        harness.wait_until(Duration::from_secs(6), |model| {
            model.frame().ok().map(|frame| frame.screen) == Some(Screen::Primary)
        }),
        "htop did not restore primary screen"
    );
    eprintln!("PASS htop alternate-screen round trip");
}
