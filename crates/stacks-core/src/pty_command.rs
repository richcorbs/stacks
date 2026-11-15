use portable_pty::CommandBuilder;

pub fn build_shell_command(
    cwd: String,
    command: Option<String>,
    managed_service: bool,
) -> CommandBuilder {
    let startup_command = command
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    if let Some(startup) = startup_command {
        if shell.ends_with("zsh") || shell.ends_with("bash") {
            // macOS .app launches do not inherit a user's Terminal environment.
            // Run commands in an interactive login shell so ~/.zshrc, nvm,
            // Homebrew PATH setup, etc. are available.
            cmd.arg("-lic");
        } else {
            cmd.arg("-lc");
        }
        cmd.arg(shell_command_script(&startup, &shell, managed_service));
    } else if shell.ends_with("zsh") || shell.ends_with("bash") {
        cmd.arg("-l");
    }
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd
}

fn shell_command_script(startup: &str, shell: &str, managed_service: bool) -> String {
    if managed_service {
        startup.to_string()
    } else {
        format!("{}; exec {} -l", startup, shell)
    }
}

#[cfg(test)]
mod tests {
    use super::shell_command_script;

    #[test]
    fn managed_service_exits_with_its_configured_command() {
        assert_eq!(shell_command_script("bin/dev", "/bin/zsh", true), "bin/dev");
    }

    #[test]
    fn ordinary_startup_command_returns_to_login_shell() {
        assert_eq!(
            shell_command_script("echo ready", "/bin/zsh", false),
            "echo ready; exec /bin/zsh -l"
        );
    }
}
