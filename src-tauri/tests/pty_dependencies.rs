//! Exercise the real portable-pty backend without Tauri or a user's shell profile.
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn pty_spawn_input_utf8_resize_exit_and_kill() {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new("/bin/sh");
    command.args([
        "-c",
        "stty -echo; printf 'READY\\n'; read line; stty size; printf 'received:%s\\n' \"$line\"",
    ]);
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = [0; 4096];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            if sender.send(buffer[..count].to_vec()).is_err() {
                break;
            }
        }
    });
    let mut output = Vec::new();
    while !String::from_utf8_lossy(&output).contains("READY") {
        output.extend(receiver.recv_timeout(Duration::from_secs(10)).unwrap());
    }
    pair.master
        .resize(PtySize {
            rows: 37,
            cols: 101,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    pair.master
        .take_writer()
        .unwrap()
        .write_all("héllo 世界\n".as_bytes())
        .unwrap();
    while !String::from_utf8_lossy(&output).contains("received:héllo 世界") {
        output.extend(receiver.recv_timeout(Duration::from_secs(10)).unwrap());
    }
    assert!(String::from_utf8(output).unwrap().contains("37 101"));
    assert!(child.wait().unwrap().success());

    let mut command = CommandBuilder::new("/bin/sh");
    command.args(["-c", "exec sleep 30"]);
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let mut child = pair.slave.spawn_command(command).unwrap();
    child.kill().unwrap();
    assert!(!child.wait().unwrap().success());
}
