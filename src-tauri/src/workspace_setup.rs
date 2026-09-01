use serde::Serialize;
use std::{
    collections::VecDeque,
    env,
    io::Read,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};
use tauri::State;

use crate::{fs_paths::app_data_dir, process_group};

const SETUP_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_SETUP_OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Default)]
pub struct WorkspaceSetupState {
    cancelled: AtomicBool,
}

#[derive(Serialize)]
pub struct WorkspaceSetupResult {
    cwd: String,
    output: String,
}

#[tauri::command]
pub fn run_workspace_setup(state: State<'_, WorkspaceSetupState>, command: String, cwd: String) -> Result<WorkspaceSetupResult, String> {
    state.cancelled.store(false, Ordering::Release);
    run_workspace_setup_inner(command, cwd, &state.cancelled)
}

#[tauri::command]
pub fn cancel_workspace_setup(state: State<'_, WorkspaceSetupState>) {
    state.cancelled.store(true, Ordering::Release);
}

fn run_workspace_setup_inner(command: String, cwd: String, cancelled: &AtomicBool) -> Result<WorkspaceSetupResult, String> {
    if command.trim().is_empty() {
        return Err("Setup command cannot be empty".to_string());
    }
    let mut result_path = app_data_dir()?;
    result_path.push("setup-results");
    std::fs::create_dir_all(&result_path).map_err(|error| error.to_string())?;
    result_path.push(format!("{}.cwd", uuid::Uuid::new_v4()));

    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let script = r#"
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
    process_group::configure(&mut setup_command);
    let mut child = setup_command.spawn()
        .map_err(|error| format!("Could not start workspace setup: {error}"))?;

    let streams = (child.stdout.take(), child.stderr.take());
    let (stdout, stderr) = match streams {
        (Some(stdout), Some(stderr)) => (stdout, stderr),
        _ => {
            process_group::terminate(&mut child, Duration::from_millis(500));
            let _ = std::fs::remove_file(&result_path);
            return Err("Could not read workspace setup output".to_string());
        }
    };
    let stdout_reader = thread::spawn(move || read_stream(stdout));
    let stderr_reader = thread::spawn(move || read_stream(stderr));

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if cancelled.load(Ordering::Acquire) => {
                process_group::terminate(&mut child, Duration::from_millis(500));
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                let _ = std::fs::remove_file(&result_path);
                return Err("Workspace setup cancelled".to_string());
            }
            Ok(None) if started.elapsed() < SETUP_TIMEOUT => {
                thread::sleep(Duration::from_millis(50))
            }
            Ok(None) => {
                process_group::terminate(&mut child, Duration::from_millis(500));
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                let _ = std::fs::remove_file(&result_path);
                return Err("Workspace setup timed out after 10 minutes".to_string());
            }
            Err(error) => {
                process_group::terminate(&mut child, Duration::from_millis(500));
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                let _ = std::fs::remove_file(&result_path);
                return Err(format!("Could not wait for workspace setup: {error}"));
            }
        }
    };

    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    let output = [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if !status.success() {
        let _ = std::fs::remove_file(&result_path);
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
    let _ = std::fs::remove_file(&result_path);
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
    if truncated { format!("[earlier setup output truncated]\n{output}") } else { output.into_owned() }
}

#[cfg(test)]
mod tests {
    use super::{read_stream, run_workspace_setup_inner, MAX_SETUP_OUTPUT_BYTES};
    use std::sync::atomic::AtomicBool;

    #[test]
    fn bounds_setup_output_to_a_tail_buffer() {
        let output = read_stream(vec![b'x'; MAX_SETUP_OUTPUT_BYTES + 100].as_slice());
        assert!(output.starts_with("[earlier setup output truncated]"));
        assert!(output.len() <= MAX_SETUP_OUTPUT_BYTES + 40);
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
