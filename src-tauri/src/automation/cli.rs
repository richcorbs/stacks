use std::{env, time::Duration};

#[cfg(unix)]
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
};

use super::{
    protocol::{AutomationResponse, ClientRequest},
    socket_path, RESPONSE_TIMEOUT,
};

pub fn handle_cli_invocation() -> Option<i32> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        return None;
    }
    if args == ["--help"] || args == ["-h"] {
        print_help();
        return Some(0);
    }
    if args.first().map(String::as_str) != Some("workspace") {
        return None;
    }
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_help();
        return Some(0);
    }

    let request = match parse_workspace_args(&args) {
        Ok(request) => request,
        Err(message) => {
            eprintln!("stacks: {message}\n");
            print_help();
            return Some(2);
        }
    };

    match send_request(request, RESPONSE_TIMEOUT + Duration::from_secs(2)) {
        Ok(response) if response.ok => {
            println!("{}", response.message);
            Some(0)
        }
        Ok(response) => {
            eprintln!("stacks: {}", response.message);
            Some(response.exit_code.unwrap_or(1).clamp(1, 255))
        }
        Err(message) => {
            eprintln!("stacks: {message}");
            Some(1)
        }
    }
}

pub fn activate_existing_instance() -> bool {
    let request = ClientRequest {
        action: "activate".into(),
        name: String::new(),
        startup_command: None,
        run_once: None,
    };
    send_request(request, Duration::from_secs(2))
        .map(|response| response.ok)
        .unwrap_or(false)
}

fn parse_workspace_args(args: &[String]) -> Result<ClientRequest, String> {
    if args.get(1).map(String::as_str) != Some("create") {
        return Err("expected `workspace create`".into());
    }

    let mut name = None;
    let mut startup_command = None;
    let mut run_once = None;
    let mut index = 2;
    while index < args.len() {
        let flag = args[index].as_str();
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("missing value for `{flag}`"))?;
        match flag {
            "--name" => name = Some(value.clone()),
            "--command" | "--startup-command" => {
                if startup_command.is_some() {
                    return Err("startup command was provided more than once".into());
                }
                startup_command = Some(value.clone());
            }
            "--run" => {
                if run_once.is_some() {
                    return Err("`--run` was provided more than once".into());
                }
                run_once = Some(value.clone());
            }
            _ => return Err(format!("unknown argument `{flag}`")),
        }
        index += 2;
    }

    let name = name.ok_or_else(|| "`--name` is required".to_string())?;
    if name.trim().is_empty() {
        return Err("`--name` cannot be empty".into());
    }
    if startup_command.is_some() && run_once.is_some() {
        return Err("`--startup-command`/`--command` and `--run` are mutually exclusive".into());
    }
    if startup_command
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err("startup command cannot be empty".into());
    }
    if run_once
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err("`--run` cannot be empty".into());
    }
    Ok(ClientRequest {
        action: "createWorkspace".into(),
        name,
        startup_command,
        run_once,
    })
}

#[cfg(unix)]
fn send_request(
    request: ClientRequest,
    response_timeout: Duration,
) -> Result<AutomationResponse, String> {
    let path = socket_path()?;
    send_request_to_path(&path, request, response_timeout)
}

#[cfg(unix)]
fn send_request_to_path(
    path: &std::path::Path,
    request: ClientRequest,
    response_timeout: Duration,
) -> Result<AutomationResponse, String> {
    let mut stream = UnixStream::connect(path).map_err(|err| {
        format!(
            "no running Stacks instance found (could not connect to {}: {err})",
            path.display()
        )
    })?;
    stream
        .set_read_timeout(Some(response_timeout))
        .map_err(|err| err.to_string())?;
    let json = serde_json::to_string(&request).map_err(|err| err.to_string())?;
    writeln!(stream, "{json}").map_err(|err| format!("failed to send request: {err}"))?;

    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|err| format!("failed to read Stacks response: {err}"))?;
    if line.is_empty() {
        return Err("Stacks closed the automation connection without responding".into());
    }
    serde_json::from_str(&line).map_err(|err| format!("invalid response from Stacks: {err}"))
}

#[cfg(not(unix))]
fn send_request(
    _request: ClientRequest,
    _response_timeout: Duration,
) -> Result<AutomationResponse, String> {
    Err("Stacks automation is currently supported only on Unix platforms".into())
}

fn print_help() {
    println!(
        "Stacks automation\n\nUSAGE:\n    stacks-tauri workspace create --name <NAME> [--startup-command <COMMAND> | --run <COMMAND>]\n\nOPTIONS:\n    --startup-command  Persist the command and run it whenever the terminal starts\n    --command          Alias for --startup-command\n    --run              Run the command once and return its exit status\n\nThe Stacks desktop app must already be running. The workspace is created in\nthe currently selected project."
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::protocol::AutomationRequest;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parses_workspace_creation() {
        let request = parse_workspace_args(&strings(&[
            "workspace",
            "create",
            "--name",
            "API",
            "--startup-command",
            "npm run dev",
        ]))
        .expect("arguments should parse");

        assert_eq!(request.action, "createWorkspace");
        assert_eq!(request.name, "API");
        assert_eq!(request.startup_command.as_deref(), Some("npm run dev"));
        assert_eq!(request.run_once, None);
    }

    #[test]
    fn command_alias_sets_the_startup_command() {
        let request = parse_workspace_args(&strings(&[
            "workspace",
            "create",
            "--name",
            "Dev",
            "--command",
            "npm run dev",
        ]))
        .expect("arguments should parse");

        assert_eq!(request.startup_command.as_deref(), Some("npm run dev"));
    }

    #[test]
    fn serializes_command_fields_for_the_frontend() {
        let request = AutomationRequest {
            request_id: "request-1".into(),
            action: "createWorkspace".into(),
            name: "Tests".into(),
            startup_command: None,
            run_once: Some("npm test".into()),
        };
        let value = serde_json::to_value(request).expect("request should serialize");

        assert_eq!(value["runOnce"], "npm test");
        assert!(value.get("startupCommand").is_some());
    }

    #[test]
    fn parses_a_run_once_command() {
        let request = parse_workspace_args(&strings(&[
            "workspace",
            "create",
            "--name",
            "Tests",
            "--run",
            "npm test",
        ]))
        .expect("arguments should parse");

        assert_eq!(request.startup_command, None);
        assert_eq!(request.run_once.as_deref(), Some("npm test"));
    }

    #[test]
    fn rejects_startup_and_run_once_together() {
        let result = parse_workspace_args(&strings(&[
            "workspace",
            "create",
            "--name",
            "Invalid",
            "--command",
            "npm run dev",
            "--run",
            "npm test",
        ]));
        assert!(result.is_err());
    }

    #[test]
    fn requires_a_workspace_name() {
        let result = parse_workspace_args(&strings(&["workspace", "create"]));
        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn exchanges_a_request_and_response_over_a_unix_socket() {
        use std::os::unix::net::UnixListener;

        let path = std::path::PathBuf::from(format!(
            "/tmp/stacks-test-{}.sock",
            &uuid::Uuid::new_v4().to_string()[..8]
        ));
        let listener = UnixListener::bind(&path).expect("test socket should bind");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("client should connect");
            let mut request = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut request)
                .expect("request should be readable");
            assert!(request.contains("createWorkspace"));
            writeln!(
                stream,
                "{{\"ok\":true,\"message\":\"created\",\"workspaceId\":\"w1\",\"exitCode\":null}}"
            )
            .expect("response should write");
        });

        let response = send_request_to_path(
            &path,
            ClientRequest {
                action: "createWorkspace".into(),
                name: "Test".into(),
                startup_command: None,
                run_once: None,
            },
            Duration::from_secs(1),
        )
        .expect("request should succeed");

        server.join().expect("server should finish");
        let _ = std::fs::remove_file(path);
        assert!(response.ok);
        assert_eq!(response.workspace_id.as_deref(), Some("w1"));
    }
}
