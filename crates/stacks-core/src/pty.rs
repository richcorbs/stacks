//! PTY lifecycle shared by native hosts.
//!
//! Mirrors the shipped `src-tauri/src/pty.rs` contract: one interactive login
//! shell (or startup command) per pane, explicit `SIGWINCH` via `resize`, and
//! exit data tied to the generation that produced it.

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::{
    io::{Read, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub enum PtyEvent {
    Data {
        terminal_id: String,
        generation: String,
        data: Vec<u8>,
    },
    Exit {
        terminal_id: String,
        generation: String,
        status: Option<i32>,
    },
}

pub type PtySink = Arc<dyn Fn(PtyEvent) + Send + Sync>;

pub struct PtySession {
    pub terminal_id: String,
    pub generation: String,
    pub cols: u16,
    pub rows: u16,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    closed: Arc<AtomicBool>,
}

impl PtySession {
    pub fn spawn(
        terminal_id: impl Into<String>,
        cwd: &str,
        command: Option<&str>,
        managed_service: bool,
        cols: u16,
        rows: u16,
        sink: PtySink,
    ) -> Result<Self, String> {
        Self::spawn_with_env(
            terminal_id,
            cwd,
            command,
            managed_service,
            cols,
            rows,
            &[],
            sink,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn spawn_with_env(
        terminal_id: impl Into<String>,
        cwd: &str,
        command: Option<&str>,
        managed_service: bool,
        cols: u16,
        rows: u16,
        env: &[(&str, &str)],
        sink: PtySink,
    ) -> Result<Self, String> {
        let builder = build_shell_command(cwd, command, managed_service);
        let mut builder = builder;
        for (key, value) in env {
            builder.env(key, value);
        }
        Self::spawn_builder(terminal_id.into(), builder, cols, rows, sink)
    }

    /// Spawn a program directly (no login shell). Used for native Pi sessions.
    pub fn spawn_program(
        terminal_id: impl Into<String>,
        program: &std::path::Path,
        args: &[String],
        cwd: &str,
        cols: u16,
        rows: u16,
        env: &[(String, String)],
        sink: PtySink,
    ) -> Result<Self, String> {
        let mut builder = CommandBuilder::new(program);
        for arg in args {
            builder.arg(arg);
        }
        builder.cwd(cwd);
        builder.env("TERM", "xterm-256color");
        builder.env("COLORTERM", env_color_term());
        builder.env("STACKS_TUI", "1");
        for (key, value) in env {
            builder.env(key, value);
        }
        Self::spawn_builder(terminal_id.into(), builder, cols, rows, sink)
    }

    fn spawn_builder(
        terminal_id: String,
        command: CommandBuilder,
        cols: u16,
        rows: u16,
        sink: PtySink,
    ) -> Result<Self, String> {
        let cols = cols.max(2);
        let rows = rows.max(1);
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Could not open a PTY: {error}"))?;
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("Could not start the shell: {error}"))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("Could not read the PTY: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("Could not write to the PTY: {error}"))?;
        let generation = format!("stacks-tui:{}", Uuid::new_v4());
        let reader_generation = generation.clone();
        let reader_terminal = terminal_id.clone();
        let event_terminal = reader_terminal.clone();
        let closed = Arc::new(AtomicBool::new(false));
        let reader_closed = Arc::clone(&closed);

        thread::Builder::new()
            .name("stacks-tui-pty-reader".into())
            .spawn(move || {
                let mut buffer = [0u8; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => sink(PtyEvent::Data {
                            terminal_id: event_terminal.clone(),
                            generation: reader_generation.clone(),
                            data: buffer[..count].to_vec(),
                        }),
                    }
                }
                reader_closed.store(true, Ordering::Release);
                sink(PtyEvent::Exit {
                    terminal_id: reader_terminal,
                    generation: reader_generation,
                    status: None,
                });
            })
            .map_err(|error| format!("Could not start the PTY reader: {error}"))?;

        Ok(Self {
            terminal_id,
            generation,
            cols,
            rows,
            master: pair.master,
            writer,
            child,
            closed,
        })
    }

    pub fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.writer
            .write_all(bytes)
            .map_err(|error| error.to_string())?;
        self.writer.flush().map_err(|error| error.to_string())
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        let cols = cols.max(2);
        let rows = rows.max(1);
        if self.cols == cols && self.rows == rows {
            return Ok(());
        }
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;
        self.cols = cols;
        self.rows = rows;
        Ok(())
    }

    pub fn has_exited(&mut self) -> bool {
        self.closed.load(Ordering::Acquire)
            || self
                .child
                .try_wait()
                .map(|status| status.is_some())
                .unwrap_or(true)
    }

    pub fn exit_code(&mut self) -> Option<i32> {
        self.child
            .try_wait()
            .ok()
            .flatten()
            .map(|status| status.exit_code() as i32)
    }

    pub fn kill(&mut self) -> Result<(), String> {
        self.child.kill().map_err(|error| error.to_string())?;
        let _ = self.child.wait();
        Ok(())
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn build_shell_command(
    cwd: &str,
    command: Option<&str>,
    managed_service: bool,
) -> CommandBuilder {
    let startup = command.map(str::trim).filter(|value| !value.is_empty());
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut builder = CommandBuilder::new(&shell);
    match startup {
        Some(startup) => {
            if shell.ends_with("zsh") || shell.ends_with("bash") {
                builder.arg("-lic");
            } else {
                builder.arg("-lc");
            }
            builder.arg(shell_command_script(startup, &shell, managed_service));
        }
        None => {
            if shell.ends_with("zsh") || shell.ends_with("bash") {
                builder.arg("-l");
            }
        }
    }
    builder.cwd(cwd);
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", env_color_term());
    builder.env("STACKS_TUI", "1");
    builder
}

fn env_color_term() -> String {
    std::env::var("COLORTERM").unwrap_or_else(|_| "truecolor".into())
}

fn shell_command_script(startup: &str, shell: &str, managed_service: bool) -> String {
    if managed_service {
        startup.to_string()
    } else {
        format!("{startup}; exec {shell} -l")
    }
}

pub fn shell_argv(shell: &str) -> Vec<String> {
    vec![shell.to_string(), "-l".to_string()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn ordinary_startup_command_returns_to_login_shell() {
        assert_eq!(
            shell_command_script("echo ready", "/bin/zsh", false),
            "echo ready; exec /bin/zsh -l"
        );
        assert_eq!(shell_command_script("bin/dev", "/bin/zsh", true), "bin/dev");
    }

    #[test]
    fn login_shell_contract() {
        assert_eq!(shell_argv("/bin/zsh"), ["/bin/zsh", "-l"]);
    }

    #[test]
    fn streams_output_resizes_and_reports_exit() {
        let (tx, rx) = mpsc::channel();
        let sink: PtySink = Arc::new(move |event| {
            let _ = tx.send(event);
        });
        let mut pty = PtySession::spawn(
            "pane-test",
            &std::env::temp_dir().to_string_lossy(),
            None,
            false,
            80,
            24,
            sink,
        )
        .unwrap();
        pty.write(b"printf 'STACKS_PTY_OK\\n'; exit 7\n").unwrap();
        let mut output = String::new();
        let mut exited = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            match rx.try_recv() {
                Ok(PtyEvent::Data { data, .. }) => output.push_str(&String::from_utf8_lossy(&data)),
                Ok(PtyEvent::Exit { .. }) => {
                    exited = true;
                    break;
                }
                Err(mpsc::TryRecvError::Empty) => {
                    thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(mpsc::TryRecvError::Disconnected) => break,
            }
        }
        assert!(output.contains("STACKS_PTY_OK"), "output: {output:?}");
        assert!(exited);
        pty.resize(100, 30).unwrap();
        assert_eq!((pty.cols, pty.rows), (100, 30));
    }
}
