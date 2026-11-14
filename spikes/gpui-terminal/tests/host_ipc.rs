//! End-to-end checks for the card #319 host IPC transport. These exercise a
//! real Unix socket, the same wire format the Tauri host writes, and the
//! reader-thread EOF behaviour that prevents orphan helpers.

use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixListener,
};

use stacks_gpui_terminal_spike::host_ipc::{HostCommand, HostEvent, HostLink};

#[test]
fn helper_emits_ready_and_receives_commands() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("host.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let host = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut writer = stream;
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(
            line.trim(),
            r#"{"event":"ready","pid":7,"version":"0.1.0"}"#
        );
        writer.write_all(b"{\"command\":\"visibility\"}\n").ok();
        writer.write_all(b"{\"command\":\"toggle\"}\n").unwrap();
        writer
            .write_all(b"{\"command\":\"split-right\"}\n")
            .unwrap();
    });
    let (link, commands) = HostLink::connect(&path).unwrap();
    // The host above asserts the Ready payload; send a matching one.
    assert!(link.emit(&HostEvent::Ready {
        pid: 7,
        version: "0.1.0".into(),
    }));
    host.join().unwrap();

    let mut received = Vec::new();
    for _ in 0..2 {
        received.push(
            commands
                .recv_blocking()
                .expect("host commands should arrive"),
        );
    }
    assert_eq!(received, vec![HostCommand::Toggle, HostCommand::SplitRight]);
}

#[test]
fn unknown_commands_are_ignored_and_eof_quits() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("host.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let host = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.write_all(b"not-json\n").unwrap();
        stream.write_all(b"{\"command\":\"new-tab\"}\n").unwrap();
        // Closing the stream models Stacks exiting.
        drop(stream);
    });
    let (_link, commands) = HostLink::connect(&path).unwrap();
    host.join().unwrap();
    assert_eq!(
        commands.recv_blocking().unwrap(),
        HostCommand::NewTab,
        "unknown payloads must not terminate the reader"
    );
    let quit = commands
        .recv_blocking()
        .expect("EOF should produce a synthetic quit command");
    assert_eq!(quit, HostCommand::Quit);
}

#[test]
fn events_are_newline_delimited_json() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("host.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let reader = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream);
        let mut lines = Vec::new();
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap() > 0 {
            lines.push(line.trim().to_string());
            line.clear();
        }
        lines
    });
    let (link, _commands) = HostLink::connect(&path).unwrap();
    assert!(link.emit(&HostEvent::Visibility { visible: true }));
    assert!(link.emit(&HostEvent::Title {
        title: "zsh".into()
    }));
    assert!(link.emit(&HostEvent::QuitRequested));
    drop(link);
    let lines = reader.join().unwrap();
    assert_eq!(
        lines,
        vec![
            r#"{"event":"visibility","visible":true}"#.to_string(),
            r#"{"event":"title","title":"zsh"}"#.to_string(),
            r#"{"event":"quit-requested"}"#.to_string(),
        ]
    );
}
