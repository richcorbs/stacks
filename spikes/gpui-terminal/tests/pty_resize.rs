use stacks_gpui_terminal_spike::pty::{Pty, PtyEvent};
use std::time::{Duration, Instant};

#[test]
fn real_pty_resize_and_login_shell() {
    let (tx, rx) = async_channel::bounded(128);
    let mut pty = Pty::spawn(&std::env::temp_dir().to_string_lossy(), 80, 24, tx).unwrap();
    pty.resize(100, 41).unwrap();
    pty.write(b"stty size; printf 'SPIKE_RESIZE_DONE\\n'; exit\n")
        .unwrap();
    let mut output = String::new();
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        match rx.try_recv() {
            Ok(PtyEvent::Data { data, .. }) => output.push_str(&String::from_utf8_lossy(&data)),
            Ok(PtyEvent::Exit { .. }) => break,
            Err(async_channel::TryRecvError::Empty) => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(async_channel::TryRecvError::Closed) => break,
        }
    }
    assert!(output.contains("41 100"), "stty output: {output:?}");
    assert!(output.contains("SPIKE_RESIZE_DONE"), "output: {output:?}");
}
