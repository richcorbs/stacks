use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    env,
    io::Read,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::State;

#[cfg(test)]
use crate::fs_paths::app_data_dir;
use crate::process_group;

const SETUP_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_SETUP_OUTPUT_BYTES: usize = 256 * 1024;
/// A descendant that escaped the setup process group (or a daemon that keeps the
/// inherited pipes open) can hold the output readers forever. Cancellation and
/// completion must never wait on that indefinitely.
const SETUP_READER_JOIN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct WorkspaceSetupState {
    operations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Serialize)]
pub struct WorkspaceSetupResult {
    pub(crate) cwd: String,
    pub(crate) output: String,
}

impl WorkspaceSetupState {
    pub(crate) fn busy(&self) -> usize {
        self.operations.lock().map(|operations| operations.len()).unwrap_or(1)
    }

    pub(crate) fn begin(&self, operation_id: &str) -> Result<Arc<AtomicBool>, String> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut operations = self
            .operations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if operations.contains_key(operation_id) {
            return Err("Workspace setup is already running for this card".to_string());
        }
        operations.insert(operation_id.to_string(), Arc::clone(&cancelled));
        Ok(cancelled)
    }

    pub(crate) fn finish(&self, operation_id: &str, cancelled: &Arc<AtomicBool>) {
        let mut operations = self
            .operations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if operations
            .get(operation_id)
            .is_some_and(|current| Arc::ptr_eq(current, cancelled))
        {
            operations.remove(operation_id);
        }
    }

    pub(crate) fn cancel_and_wait(&self, operation_id: &str) -> Result<(), String> {
        self.cancel(operation_id);
        let start = Instant::now();
        loop {
            let active = self.operations.lock().map_err(|_| "Setup registry lock failed")?.contains_key(operation_id);
            if !active { return Ok(()); }
            if start.elapsed() > Duration::from_secs(15) {
                return Err("Setup shutdown did not finish within 15 seconds; resources preserved for retry".into());
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    fn cancel(&self, operation_id: &str) {
        if let Some(cancelled) = self
            .operations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(operation_id)
        {
            cancelled.store(true, Ordering::Release);
        }
    }
}

#[tauri::command]
pub fn cancel_workspace_setup(state: State<'_, WorkspaceSetupState>, card_id: String) {
    state.cancel(&format!("environment:{card_id}"));
}

#[cfg(test)]
fn run_workspace_setup_inner(
    command: String,
    cwd: String,
    cancelled: &AtomicBool,
) -> Result<WorkspaceSetupResult, String> {
    let mut result_path = app_data_dir()?;
    result_path.push("setup-results");
    std::fs::create_dir_all(&result_path).map_err(|error| error.to_string())?;
    result_path.push(format!("{}.cwd", uuid::Uuid::new_v4()));
    let result = run_workspace_setup_durable(command, cwd, cancelled, &result_path);
    let _ = std::fs::remove_file(&result_path);
    result
}

pub(crate) fn run_workspace_setup_durable(
    command: String,
    cwd: String,
    cancelled: &AtomicBool,
    result_path: &std::path::Path,
) -> Result<WorkspaceSetupResult, String> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    run_workspace_setup_with_shell(command, cwd, cancelled, result_path, &shell)
}

fn run_workspace_setup_with_shell(
    command: String,
    cwd: String,
    cancelled: &AtomicBool,
    result_path: &std::path::Path,
    shell: &str,
) -> Result<WorkspaceSetupResult, String> {
    if command.trim().is_empty() {
        return Err("Setup command cannot be empty".to_string());
    }
    if let Some(parent) = result_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let _ = std::fs::remove_file(result_path);

    let script = r#"
# An interactive shell with job control gives every command its own process
# group, so killing this shell's group would miss a running setup command and
# let it outlive cancellation while it holds our output pipes open. Keep the
# whole command tree in one group; `set +m` covers sh/bash/zsh and the
# `unsetopt` line covers zsh explicitly (it is a no-op elsewhere).
set +m 2>/dev/null
(unsetopt monitor) 2>/dev/null || true
eval "$STACKS_SETUP_COMMAND"
__stacks_status=$?
if [ "$__stacks_status" -eq 0 ]; then
  pwd -P > "$STACKS_SETUP_RESULT"
fi
exit "$__stacks_status"
"#;
    let mut setup_command = Command::new(shell);
    setup_command
        .args(["-lic", script])
        .current_dir(&cwd)
        .env("STACKS_SETUP_COMMAND", command)
        .env("STACKS_SETUP_RESULT", &result_path)
        .env("STACKS_WORKSPACE_SETUP", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    process_group::configure_detached(&mut setup_command);
    let mut child = setup_command
        .spawn()
        .map_err(|error| format!("Could not start workspace setup: {error}"))?;
    let pid_path = result_path.with_extension("pid");
    if let Err(error) = std::fs::write(&pid_path, child.id().to_string()) {
        process_group::terminate(&mut child, Duration::from_millis(500));
        return Err(format!(
            "Could not persist workspace setup process identity: {error}"
        ));
    }
    struct PidFile(std::path::PathBuf);
    impl Drop for PidFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _pid_file = PidFile(pid_path);

    let streams = (child.stdout.take(), child.stderr.take());
    let (stdout, stderr) = match streams {
        (Some(stdout), Some(stderr)) => (stdout, stderr),
        _ => {
            process_group::terminate(&mut child, Duration::from_millis(500));
            let _ = std::fs::remove_file(&result_path);
            return Err("Could not read workspace setup output".to_string());
        }
    };
    let mut stdout_reader = Some(thread::spawn(move || read_stream(stdout)));
    let mut stderr_reader = Some(thread::spawn(move || read_stream(stderr)));

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if cancelled.load(Ordering::Acquire) => {
                abort_setup(&mut child, stdout_reader.take(), stderr_reader.take());
                return Err("Workspace setup cancelled".to_string());
            }
            Ok(None) if started.elapsed() < SETUP_TIMEOUT => {
                thread::sleep(Duration::from_millis(50))
            }
            Ok(None) => {
                abort_setup(&mut child, stdout_reader.take(), stderr_reader.take());
                return Err("Workspace setup timed out after 10 minutes".to_string());
            }
            Err(error) => {
                abort_setup(&mut child, stdout_reader.take(), stderr_reader.take());
                return Err(format!("Could not wait for workspace setup: {error}"));
            }
        }
    };

    let stdout = join_reader(stdout_reader.take()).unwrap_or_default();
    let stderr = join_reader(stderr_reader.take()).unwrap_or_default();
    let output = [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if !status.success() {
        return Err(if output.is_empty() {
            format!(
                "Workspace setup exited with status {}",
                status.code().unwrap_or(-1)
            )
        } else {
            format!(
                "Workspace setup exited with status {}:\n{output}",
                status.code().unwrap_or(-1)
            )
        });
    }

    let final_cwd = std::fs::read_to_string(&result_path)
        .map_err(|error| format!("Workspace setup did not report its final directory: {error}"))?;
    let final_cwd = final_cwd.trim();
    let metadata = std::fs::metadata(final_cwd)
        .map_err(|error| format!("Workspace setup returned an invalid directory: {error}"))?;
    if !metadata.is_dir() {
        return Err("Workspace setup final path is not a directory".to_string());
    }

    Ok(WorkspaceSetupResult {
        cwd: final_cwd.to_string(),
        output,
    })
}

/// Terminate the setup process group, then wait briefly for the output readers.
/// A setup command that escaped the group keeps the pipe write ends open, so the
/// join is bounded: cancellation returns even when a descendant is still alive.
fn abort_setup(
    child: &mut std::process::Child,
    stdout_reader: Option<thread::JoinHandle<String>>,
    stderr_reader: Option<thread::JoinHandle<String>>,
) {
    process_group::terminate(child, Duration::from_millis(500));
    let _ = join_reader(stdout_reader);
    let _ = join_reader(stderr_reader);
}

fn join_reader(reader: Option<thread::JoinHandle<String>>) -> Option<String> {
    let reader = reader?;
    let deadline = Instant::now() + SETUP_READER_JOIN_TIMEOUT;
    while !reader.is_finished() {
        if Instant::now() >= deadline {
            // Detach: the thread exits when the last writer closes the pipe. The
            // caller gets no partial output instead of waiting without a bound.
            return None;
        }
        thread::sleep(Duration::from_millis(10));
    }
    reader.join().ok()
}

fn read_stream(mut stream: impl Read) -> String {
    let mut tail = VecDeque::with_capacity(MAX_SETUP_OUTPUT_BYTES);
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let count = match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        for byte in &buffer[..count] {
            if tail.len() == MAX_SETUP_OUTPUT_BYTES {
                tail.pop_front();
                truncated = true;
            }
            tail.push_back(*byte);
        }
    }
    let bytes: Vec<u8> = tail.into_iter().collect();
    let output = String::from_utf8_lossy(&bytes);
    if truncated {
        format!("[earlier setup output truncated]\n{output}")
    } else {
        output.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        read_stream, run_workspace_setup_inner, WorkspaceSetupState, MAX_SETUP_OUTPUT_BYTES,
    };
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn bounds_setup_output_to_a_tail_buffer() {
        let output = read_stream(vec![b'x'; MAX_SETUP_OUTPUT_BYTES + 100].as_slice());
        assert!(output.starts_with("[earlier setup output truncated]"));
        assert!(output.len() <= MAX_SETUP_OUTPUT_BYTES + 40);
    }

    #[test]
    fn cancellation_is_scoped_to_one_operation() {
        let state = WorkspaceSetupState::default();
        let first = state.begin("environment:first").unwrap();
        let second = state.begin("environment:second").unwrap();
        state.cancel("environment:first");
        assert!(first.load(Ordering::Acquire));
        assert!(!second.load(Ordering::Acquire));
        state.finish("environment:first", &first);
        state.finish("environment:second", &second);
    }

    #[test]
    fn retirement_waits_for_setup_process_group_shutdown() {
        let state = std::sync::Arc::new(WorkspaceSetupState::default());
        let flag = state.begin("environment:retiring").unwrap();
        let unrelated = state.begin("environment:other").unwrap();
        let root = tempfile::tempdir().unwrap();
        let result_path = root.path().join("result");
        let pid_path = result_path.with_extension("pid");
        let cwd = root.path().to_string_lossy().into_owned();
        let worker_state = std::sync::Arc::clone(&state);
        let worker = std::thread::spawn(move || {
            let result = super::run_workspace_setup_durable("sleep 30".into(), cwd, &flag, &result_path);
            worker_state.finish("environment:retiring", &flag);
            result
        });
        let started = std::time::Instant::now();
        while !pid_path.exists() {
            assert!(started.elapsed() < std::time::Duration::from_secs(5));
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        state.cancel_and_wait("environment:retiring").unwrap();
        assert!(worker.join().unwrap().err().unwrap().contains("cancelled"));
        assert!(!pid_path.exists());
        assert!(!unrelated.load(Ordering::Acquire));
        state.finish("environment:other", &unrelated);
    }

    fn process_exists(pid: i32) -> bool {
        // Signal 0 probes for existence without delivering anything.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// A job-control shell gives each command its own process group, so killing
    /// the setup shell's group used to miss the running command: it survived
    /// cancellation, kept the output pipes open, and the cancel path blocked
    /// until it finished (15s+ in CI, where `SHELL` is bash). Run the cancel path
    /// under every shell Stacks may find and require the grandchild to die.
    #[test]
    fn cancellation_kills_grandchildren_under_every_available_shell() {
        for shell in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            if !std::path::Path::new(shell).exists() {
                continue;
            }
            let state = std::sync::Arc::new(WorkspaceSetupState::default());
            let flag = state.begin("environment:retiring").unwrap();
            let root = tempfile::tempdir().unwrap();
            let result_path = root.path().join("result");
            let pid_path = result_path.with_extension("pid");
            let cwd = root.path().to_string_lossy().into_owned();
            let worker_state = std::sync::Arc::clone(&state);
            let shell = shell.to_string();
            let worker_shell = shell.clone();
            let worker = std::thread::spawn(move || {
                let result = super::run_workspace_setup_with_shell(
                    "sleep 30".into(),
                    cwd,
                    &flag,
                    &result_path,
                    &worker_shell,
                );
                worker_state.finish("environment:retiring", &flag);
                result
            });
            let started = std::time::Instant::now();
            while !pid_path.exists() {
                assert!(started.elapsed() < std::time::Duration::from_secs(5));
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            // The pid file holds the setup shell's pid; its child is what escaped.
            let setup_pid: i32 = std::fs::read_to_string(&pid_path)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            let cancelled_at = std::time::Instant::now();
            state.cancel_and_wait("environment:retiring").unwrap();
            assert!(
                cancelled_at.elapsed() < std::time::Duration::from_secs(10),
                "{shell}: cancellation took {:?}",
                cancelled_at.elapsed()
            );
            assert!(worker.join().unwrap().err().unwrap().contains("cancelled"));
            assert!(!process_exists(setup_pid), "{shell}: setup shell {setup_pid} survived cancellation");
            // The command itself must be gone too, not orphaned to launchd.
            std::thread::sleep(std::time::Duration::from_millis(200));
            let survivors = running_sleep_pids();
            assert!(survivors.is_empty(), "{shell}: setup command survived cancellation: {survivors:?}");
        }
    }

    /// Any `sleep 30` still running is a leaked setup command from this test.
    fn running_sleep_pids() -> Vec<i32> {
        let output = std::process::Command::new("ps")
            .args(["-axo", "pid=,args="])
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let mut parts = line.trim().splitn(2, char::is_whitespace);
                let pid = parts.next()?.trim().parse::<i32>().ok()?;
                let args = parts.next()?.trim();
                (args == "sleep 30").then_some(pid)
            })
            .collect()
    }

    #[test]
    fn captures_the_setup_shells_final_directory() {
        let root = std::env::temp_dir().join(format!("stacks-setup-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let result = run_workspace_setup_inner(
            "mkdir worktree && cd worktree && printf setup-complete".to_string(),
            root.to_string_lossy().into_owned(),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(
            result.cwd,
            std::fs::canonicalize(root.join("worktree"))
                .unwrap()
                .to_string_lossy()
        );
        assert!(result.output.contains("setup-complete"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
