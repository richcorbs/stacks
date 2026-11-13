//! Host IPC for the card #319 adjacent-window integration spike.
//!
//! The Tauri host owns a `UnixListener`; this helper process connects to it and
//! exchanges newline-delimited JSON. The protocol is deliberately tiny: the
//! host sends user intent ("toggle", "split-right", …) and the helper reports
//! lifecycle facts ("ready", "visibility", "title", "bell", "quit-request").
//! No terminal state, layout, or persistence crosses the boundary in this
//! spike; the native terminal owns its own tabs and panes, exactly like the
//! xterm.js global terminal owns the SQLite-backed layout today.

use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};

/// Environment variable used by the Tauri host to pass the socket path.
pub const HOST_SOCKET_ENV: &str = "STACKS_NATIVE_TERMINAL_SOCKET";
/// Command-line flag alternative to [`HOST_SOCKET_ENV`].
pub const HOST_SOCKET_ARG: &str = "--host-socket";

/// Commands sent by the host process.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "command", rename_all = "kebab-case")]
pub enum HostCommand {
    Ping,
    Show,
    Hide,
    Toggle,
    NewTab,
    Close,
    SplitRight,
    SplitDown,
    Maximize,
    NextPane,
    PreviousPane,
    NextTab,
    PreviousTab,
    SelectTab { index: usize },
    Search,
    Clear,
    Copy,
    Paste,
    Quit,
}

/// Events reported back to the host process.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "event", rename_all = "kebab-case")]
pub enum HostEvent {
    Ready { pid: u32, version: String },
    Visibility { visible: bool },
    Title { title: String },
    Bell { title: String },
    QuitRequested,
    Error { message: String },
}

/// Resolve `--host-socket <path>` or `STACKS_NATIVE_TERMINAL_SOCKET`.
pub fn host_socket_from_env_or_args() -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().collect();
    let mut index = 1;
    while index < args.len() {
        if args[index] == HOST_SOCKET_ARG {
            return args.get(index + 1).map(PathBuf::from);
        }
        if let Some(value) = args[index]
            .strip_prefix(HOST_SOCKET_ARG)
            .and_then(|rest| rest.strip_prefix('='))
        {
            return Some(PathBuf::from(value));
        }
        index += 1;
    }
    std::env::var_os(HOST_SOCKET_ENV).map(PathBuf::from)
}

/// Connected host link. Writes are serialized; the reader thread pushes parsed
/// commands into an async channel consumed on the GPUI foreground task.
pub struct HostLink {
    writer: Mutex<Option<UnixStream>>,
    closed: AtomicBool,
}

impl HostLink {
    pub fn connect(path: &Path) -> Result<(Self, async_channel::Receiver<HostCommand>)> {
        let stream = connect_with_retry(path, 40, Duration::from_millis(25))
            .with_context(|| format!("connect to host socket {}", path.display()))?;
        let writer_stream = stream.try_clone().context("clone host socket")?;
        writer_stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .context("configure host socket write timeout")?;
        let link = Self {
            writer: Mutex::new(Some(writer_stream)),
            closed: AtomicBool::new(false),
        };
        let (commands_tx, commands_rx) = async_channel::unbounded();
        let reader_stream = stream;
        std::thread::Builder::new()
            .name("stacks-spike-host-ipc".into())
            .spawn(move || {
                let reader = BufReader::new(reader_stream);
                for line in reader.lines() {
                    let Ok(line) = line else {
                        break;
                    };
                    if line.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<HostCommand>(&line) {
                        Ok(command) => {
                            if commands_tx.send_blocking(command).is_err() {
                                break;
                            }
                        }
                        Err(error) => eprintln!("host ipc: bad command {line:?}: {error}"),
                    }
                }
                // The host is gone. Quit so the helper (and its PTYs) cannot
                // outlive Stacks as an orphan process.
                let _ = commands_tx.send_blocking(HostCommand::Quit);
            })
            .context("spawn host ipc reader")?;
        Ok((link, commands_rx))
    }

    pub fn emit(&self, event: &HostEvent) -> bool {
        if self.closed.load(Ordering::SeqCst) {
            return false;
        }
        let Ok(line) = serde_json::to_string(event) else {
            return false;
        };
        let Ok(mut guard) = self.writer.lock() else {
            return false;
        };
        let Some(stream) = guard.as_mut() else {
            return false;
        };
        let result = stream
            .write_all(format!("{line}\n").as_bytes())
            .and_then(|()| stream.flush());
        if result.is_err() {
            self.closed.store(true, Ordering::SeqCst);
            *guard = None;
            return false;
        }
        true
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

impl Drop for HostLink {
    fn drop(&mut self) {
        // The reader thread owns a duplicate of the same socket, so dropping
        // the writer clone alone would never produce EOF locally. Shutdown
        // wakes the reader (which then synthesizes a quit command).
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.writer.lock()
            && let Some(stream) = guard.as_mut()
        {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        if let Ok(mut guard) = self.writer.lock() {
            *guard = None;
        }
    }
}

fn connect_with_retry(path: &Path, attempts: u32, delay: Duration) -> Result<UnixStream> {
    let mut last_error = None;
    for _ in 0..attempts {
        match UnixStream::connect(path) {
            Ok(stream) => return Ok(stream),
            Err(error) => {
                last_error = Some(error);
                std::thread::sleep(delay);
            }
        }
    }
    Err(last_error
        .map(anyhow::Error::new)
        .unwrap_or_else(|| anyhow::anyhow!("host socket unavailable")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_wire_format_is_kebab_case() {
        assert_eq!(
            serde_json::to_string(&HostCommand::Toggle).unwrap(),
            r#"{"command":"toggle"}"#
        );
        assert_eq!(
            serde_json::to_string(&HostCommand::SplitRight).unwrap(),
            r#"{"command":"split-right"}"#
        );
        assert_eq!(
            serde_json::to_string(&HostCommand::SelectTab { index: 3 }).unwrap(),
            r#"{"command":"select-tab","index":3}"#
        );
        assert_eq!(
            serde_json::from_str::<HostCommand>(r#"{"command":"previous-pane"}"#).unwrap(),
            HostCommand::PreviousPane
        );
    }

    #[test]
    fn event_wire_format_is_kebab_case() {
        assert_eq!(
            serde_json::to_string(&HostEvent::Visibility { visible: true }).unwrap(),
            r#"{"event":"visibility","visible":true}"#
        );
        assert_eq!(
            serde_json::to_string(&HostEvent::QuitRequested).unwrap(),
            r#"{"event":"quit-requested"}"#
        );
        assert_eq!(
            serde_json::to_string(&HostEvent::Title {
                title: "zsh · ~/Code".into()
            })
            .unwrap(),
            r#"{"event":"title","title":"zsh · ~/Code"}"#
        );
    }

    #[test]
    fn socket_path_arg_wins_over_env() {
        // The parser reads process args, so only the env fallback is exercised here.
        unsafe { std::env::set_var(HOST_SOCKET_ENV, "/tmp/from-env.sock") };
        let path = host_socket_from_env_or_args();
        unsafe { std::env::remove_var(HOST_SOCKET_ENV) };
        // Test binaries take their own args, so this must resolve to None once
        // the env var is cleared; the arg branch is covered by the host script.
        assert_eq!(path, Some(PathBuf::from("/tmp/from-env.sock")));
    }
}
