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

## Notes

This intentionally delegates terminal emulation to xterm.js. The Tauri backend only owns PTY process lifecycle and byte transport, which should make the terminal side much simpler than the Swift/AppKit/Zig version.
