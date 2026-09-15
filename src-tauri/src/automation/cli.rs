use super::{
    protocol::{AutomationResponse, ClientRequest},
    socket_path,
};
use std::time::Duration;
#[cfg(unix)]
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
};

// Legacy workspace CLI commands were removed with the workspace UI. Card automation
// is served directly over the local socket by the scoped card tools.
pub fn handle_cli_invocation() -> Option<i32> {
    None
}

pub fn activate_existing_instance() -> bool {
    send_request(
        ClientRequest {
            action: "activate".into(),
            card_id: None,
            project_id: None,
            title: None,
            content: None,
            description: None,
            parent_id: None,
            parent_specified: None,
            children: None,
        },
        Duration::from_secs(2),
    )
    .map(|response| response.ok)
    .unwrap_or(false)
}

#[cfg(unix)]
fn send_request(request: ClientRequest, timeout: Duration) -> Result<AutomationResponse, String> {
    let path = socket_path()?;
    let mut stream = UnixStream::connect(&path).map_err(|error| {
        format!(
            "no running Stacks instance found (could not connect to {}: {error})",
            path.display()
        )
    })?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    writeln!(
        stream,
        "{}",
        serde_json::to_string(&request).map_err(|error| error.to_string())?
    )
    .map_err(|error| error.to_string())?;
    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    serde_json::from_str(&line).map_err(|error| format!("invalid response from Stacks: {error}"))
}
#[cfg(not(unix))]
fn send_request(_request: ClientRequest, _timeout: Duration) -> Result<AutomationResponse, String> {
    Err("Stacks automation is currently supported only on Unix platforms".into())
}
