use portable_pty::CommandBuilder;

pub fn build_shell_command(cwd: String, command: Option<String>) -> CommandBuilder {
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
            // Run startup commands in an interactive login shell so ~/.zshrc,
            // nvm, Homebrew PATH setup, etc. are available before execing the
            // long-lived shell.
            cmd.arg("-lic");
        } else {
            cmd.arg("-lc");
        }
        cmd.arg(format!("{}; exec {} -l", startup, shell));
    } else if shell.ends_with("zsh") || shell.ends_with("bash") {
        cmd.arg("-l");
    }
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd
}
