# Stacks

A Tauri + React terminal workspace app inspired by `~/Code/stacks`, using xterm.js in the webview and a Rust PTY backend (`portable-pty`) instead of AppKit/libvterm.

## What works in this first cut

- Project sidebar with persisted `projects.json`
- Multiple terminals per project with optional startup commands
- Real PTY-backed shell sessions
- xterm.js terminal emulation, 24-bit color, scrollback, copy/paste browser behavior
- Simple split panes in the active terminal
- Resize propagation from xterm.js to the PTY

## Data

User data is saved under the OS data directory in `stacks-tauri/`.

On macOS this is usually:

```text
~/Library/Application Support/stacks-tauri/
```

Persisted files:

- `projects.json` — projects, terminals, terminal cwd, and split-tree layout.
- `settings.json` — window size/position and sidebar width.

To reset local UI preferences without deleting projects, quit the app and remove `settings.json`.

## Development

Prerequisites:

- Node 20+
- Rust/Cargo (required by Tauri)

```bash
npm install
npm run tauri dev
```

Frontend-only build check:

```bash
npm run build
```

## Command-line automation

When Stacks is running, its app executable can create a one-terminal workspace in the currently selected project:

```bash
~/Applications/Stacks.app/Contents/MacOS/stacks-tauri \
  workspace create \
  --name "Run API" \
  --startup-command "npm run dev"
```

For a shorter command, add an alias:

```bash
alias stacks="$HOME/Applications/Stacks.app/Contents/MacOS/stacks-tauri"
stacks workspace create --name "Run API" --startup-command "npm run dev"
```

Use `--startup-command` for a persisted command that runs now and whenever the terminal restarts. The older `--command` spelling remains an alias. Use `--run` to execute a command once in the newly created shell and return its exit status:

```bash
stacks workspace create --name "One-off tests" --run "npm test"
```

Startup and run-once commands are mutually exclusive. The command selects the new workspace, focuses its terminal, and brings Stacks to the foreground. It reports success only after the workspace is persisted, its PTY has started, and any run-once command has completed successfully. Infrastructure failures roll back an automation-created workspace; a run-once command that completes with a nonzero status leaves the workspace in place and returns that status. A second GUI launch activates the existing Stacks instance instead of opening another instance.

## Notes

This intentionally delegates terminal emulation to xterm.js. The Tauri backend only owns PTY process lifecycle and byte transport, which should make the terminal side much simpler than the Swift/AppKit/Zig version.
