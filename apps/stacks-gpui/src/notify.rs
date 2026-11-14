//! Notification routing stub.
//!
//! GPUI 0.2.2 has no notification API, so the shell proves the routing seam by
//! shelling out to macOS `osascript`. That is a spike-grade implementation: a
//! production shell should use `UNUserNotificationCenter` (permission prompt,
//! authorization state, action handlers) and surface authorization failures.

use std::process::Command;

#[cfg_attr(test, allow(dead_code))]
pub fn send(title: &str, body: &str) {
    let script = format!(
        "display notification {} with title {}",
        apple_script_string(body),
        apple_script_string(title)
    );
    let spawn = std::thread::Builder::new()
        .name("stacks-gpui-notify".into())
        .spawn(move || {
            let _ = Command::new("osascript").arg("-e").arg(script).status();
        });
    if let Err(error) = spawn {
        eprintln!("notifications: could not spawn notifier: {error}");
    }
}

fn apple_script_string(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

#[cfg(test)]
mod tests {
    use super::apple_script_string;

    #[test]
    fn escapes_applescript_strings() {
        assert_eq!(apple_script_string("a\"b\\c"), "\"a\\\"b\\\\c\"");
    }
}
