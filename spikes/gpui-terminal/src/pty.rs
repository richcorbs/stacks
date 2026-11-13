//! PTY lifecycle for the spike. This deliberately mirrors Stacks'
//! `src-tauri/src/pty.rs` rules: interactive login shell, generation ids,
//! explicit resize, and exit events tied to the generation that produced them.

use std::{
    io::{Read, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

use anyhow::{Context as _, Result};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub enum PtyEvent {
    Data {
        generation: String,
        data: Vec<u8>,
    },
    Exit {
        generation: String,
        status: Option<i32>,
    },
}

pub struct Pty {
    pub generation: String,
    pub cols: u16,
    pub rows: u16,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    closed: Arc<AtomicBool>,
}

impl Pty {
    pub fn spawn(
        cwd: &str,
        cols: u16,
        rows: u16,
        events: async_channel::Sender<PtyEvent>,
    ) -> Result<Self> {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut command = CommandBuilder::new(&shell);
        // Stacks starts an ordinary global terminal with `-l` (no startup
        // command); a PTY makes it interactive. Keep that exact contract so
        // PATH/nvm/Homebrew resolve the same way in a launched .app.
        command.arg("-l");
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("STACKS_GPUI_SPIKE", "1");

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: rows.max(1),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("open PTY")?;
        let child = pair
            .slave
            .spawn_command(command)
            .with_context(|| format!("spawn {shell} -lic"))?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().context("clone PTY reader")?;
        let writer = pair.master.take_writer().context("take PTY writer")?;
        let generation = format!("gpui-spike:{}", Uuid::new_v4());
        let generation_for_thread = generation.clone();
        let closed = Arc::new(AtomicBool::new(false));
        let closed_for_thread = closed.clone();

        thread::Builder::new()
            .name("stacks-spike-pty-reader".into())
            .spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            // Bounded: a stalled UI drops output rather than
                            // growing without bound. The UI reports the drop.
                            if events
                                .send_blocking(PtyEvent::Data {
                                    generation: generation_for_thread.clone(),
                                    data: buf[..n].to_vec(),
                                })
                                .is_err()
                            {
                                break;
                            }
                        }
                    }
                }
                let _ = events.send_blocking(PtyEvent::Exit {
                    generation: generation_for_thread,
                    status: None,
                });
                closed_for_thread.store(true, Ordering::Release);
            })
            .context("spawn PTY reader thread")?;

        Ok(Self {
            generation,
            cols,
            rows,
            master: pair.master,
            writer,
            child,
            closed,
        })
    }

    pub fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.writer.write_all(bytes).context("write PTY")?;
        self.writer.flush().context("flush PTY")?;
        Ok(())
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
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
            .context("resize PTY")?;
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
}

impl Drop for Pty {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The same shell command shape as Stacks' production PTY, without starting a
/// process. Kept public so the integration test can assert the login-shell
/// contract independently of a running shell.
pub fn shell_argv(shell: &str) -> Vec<String> {
    vec![shell.to_string(), "-l".to_string()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_shell_contract_matches_stacks() {
        assert_eq!(shell_argv("/bin/zsh"), ["/bin/zsh", "-l"]);
        assert_eq!(
            shell_argv("/usr/local/bin/bash"),
            ["/usr/local/bin/bash", "-l"]
        );
        assert_eq!(shell_argv("/bin/fish"), ["/bin/fish", "-l"]);
    }

    #[test]
    fn pty_streams_output_and_reports_exit() {
        let (tx, rx) = async_channel::bounded(64);
        let mut pty = Pty::spawn(&std::env::temp_dir().to_string_lossy(), 80, 24, tx).unwrap();
        pty.write(b"printf 'SPIKE_PTY_OK\\n'; exit 7\n").unwrap();
        let mut output = Vec::new();
        let mut exited = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            match rx.try_recv() {
                Ok(PtyEvent::Data { data, .. }) => output.extend_from_slice(&data),
                Ok(PtyEvent::Exit { .. }) => {
                    exited = true;
                    break;
                }
                Err(async_channel::TryRecvError::Empty) => {
                    thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(async_channel::TryRecvError::Closed) => break,
            }
        }
        let output = String::from_utf8_lossy(&output);
        assert!(output.contains("SPIKE_PTY_OK"), "output: {output:?}");
        assert!(exited);
    }
}
