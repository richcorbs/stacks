<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Stacks logo" width="128" height="128">
</p>

<h1 align="center">Stacks</h1>

Stacks is a macOS terminal workspace app for developers who organize work by project. It combines persistent terminal layouts with lightweight Git, GitHub, task-tracking, and [Pi](https://github.com/badlogic/pi-mono) coding-agent workflows.

Stacks uses this user-facing hierarchy:

```text
Project → Workspace → Pane (Terminal OR Pi GUI)
```

A project points at a directory. A workspace stores a working directory and split layout. Each terminal pane is either a PTY-backed shell or a Pi GUI conversation.

> Stacks is currently a personal, macOS-first application. Releases are built for Apple Silicon, and several native integrations assume macOS or Unix tools.

## What it does

### Terminal workspaces

- Organizes persistent workspaces under collapsible, reorderable projects.
- Creates up to a 5 × 5 initial terminal grid, then supports split-right and split-down operations with draggable resize handles.
- Runs an optional one-time setup command before workspace creation and uses that command's final directory as the workspace directory. This is useful for creating Git worktrees or task-specific environments.
- Supports per-workspace and per-terminal startup commands, one-time commands in temporary terminals, process stop/restart, terminal search, clickable links, and image-path drag and drop.
- Keeps PTY/xterm sessions alive across React layout changes and workspace switches.
- Maximizes the focused terminal, broadcasts input across shell terminals in a workspace, and tracks running, recently active, and unseen background output.
- Optionally sends native notifications when background Pi work finishes or a terminal exits.

### Pi GUI terminals

- Runs a persistent `pi --mode rpc` process per Pi terminal and renders conversation history, Markdown, reasoning, and tool calls natively.
- Supports model and thinking-level selection, prompt history, steering and follow-up messages, slash commands, skills, image attachments, and extension UI requests.
- Stores Pi sessions separately from workspace layout and restores them after restart.
- Requires explicit trust before loading project-local Pi settings, packages, skills, or extensions. Trust is a loading policy, not a security sandbox; Pi tools execute with the user's permissions.

See [`src/pi/README.md`](src/pi/README.md) for implementation and lifecycle details.

### Developer services

- Shows the current branch, diff source, and Git status in the DIFF tab.
- Browses working-tree or current-pull-request diffs, supports inline/file/overall review comments, and sends assembled review feedback to a Pi GUI pane.
- Lists GitHub pull requests and Actions status, opens PRs in the browser, and merges with a configurable strategy.
- Optionally browses Superthread boards and creates a workspace from a selected card.

### Workflow and customization

- Provides a keyboard-first command palette with custom saved commands.
- Persists projects, workspace layouts, active/focused panes, window geometry, sidebar width, and app settings.
- Configures terminal typography and scrollback, copy-on-select, confirmation and notification behavior, editor integration, status colors, GitHub polling, and Superthread behavior.
- Checks signed updater artifacts published through GitHub Releases.

## Runtime requirements

- macOS on Apple Silicon for the published builds.
- A user shell (zsh or bash is the best-supported path) and standard developer tools such as Git.
- Optional integrations:
  - [`pi`](https://github.com/badlogic/pi-mono), configured with a model provider, for Pi GUI panes. Stacks checks `PI_PATH`, common install locations, and the login-shell `PATH`.
  - [`gh`](https://cli.github.com/), authenticated with GitHub, for pull requests, Actions, and merge operations.
  - The Superthread `st` CLI, authenticated separately, for the optional Superthread tab.

## Install

Download the latest Apple Silicon artifact from [GitHub Releases](https://github.com/richcorbs/stacks/releases). Stacks can check for later signed updates from **Stacks → Check for Updates…**.

To build and install a local dogfood copy instead, follow the development instructions below. The project installer defaults to `~/Applications/Stacks.app`; pass `--system` to install in `/Applications`.

## Keyboard workflow

The complete list is available in the native **Shortcuts** menu and most actions are searchable with **⌘P**. Common shortcuts include:

| Action | Shortcut |
| --- | --- |
| Command palette | ⌘P |
| Add project / new workspace | ⌘O / ⌘N |
| Split right / down | ⌘D / ⇧⌘D |
| Previous / next pane | ⌘[ / ⌘] |
| Previous / next workspace | ⇧⌘[ / ⇧⌘] |
| Maximize or restore workspace | ⇧⌘↩ |
| Search current terminal | ⌘F |
| Focus or toggle diff panel | ⌘G |
| Focus or toggle pull requests | ⇧⌘G |
| Focus next workspace with unseen output | ⇧⌘N |
| Toggle developer services / sidebar | ⌘R / ⌘B |

## Command-line automation

When Stacks is already running, its executable can create a workspace in the currently selected project:

```bash
~/Applications/Stacks.app/Contents/MacOS/stacks \
  workspace create \
  --name "Run API" \
  --startup-command "npm run dev"
```

`--command` is an alias for `--startup-command`. Use `--run` instead to execute a command once in a temporary pane and return its exit status:

```bash
~/Applications/Stacks.app/Contents/MacOS/stacks \
  workspace create \
  --name "Test" \
  --run "npm test"
```

The persisted and one-time command options are mutually exclusive. Run the executable with `--help` for the complete syntax.

## Development

Prerequisites:

- Node.js 22+
- Rust stable and Cargo
- macOS

```bash
npm install
npm run tauri dev
```

The frontend is React 19 + TypeScript + Vite + xterm.js. The Tauri/Rust backend owns PTYs, Pi RPC processes, persistence, native menus, automation, and external CLI integrations.

Validate changes with the same checks used by CI:

```bash
npm run check:version
npm run test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Build and install the local application:

```bash
npm run release:build
./install.sh
open ~/Applications/Stacks.app
```

## Data and reset behavior

Application data remains under:

```text
~/Library/Application Support/stacks-tauri/
```

Important files and directories include:

- `projects.json` — projects, workspaces, working directories, and split trees.
- `settings.json` — UI preferences, window state, and the last active/focused workspace state.
- `pi-sessions/` — durable Pi session files by terminal ID.
- `pi-trusted-projects.json` — canonical project paths approved for project-local Pi resources.

The legacy `stacks-tauri` directory name is retained so upgrades keep existing data. **Stacks → Reset Window Settings** resets saved window geometry and sidebar width. Deleting `settings.json` while Stacks is closed resets all preferences and remembered UI state.

## Versioning and releases

Set all application version files together and add matching release notes:

```bash
npm run version:set -- 0.4.30
npm run check:version
# Write releases/v0.4.30.md and commit the version change.
```

Releases are built locally:

```bash
git tag v0.4.30
git push origin main v0.4.30
npm run release:prepare
npm run release:publish
# Smoke-test the draft release.
npm run release:finalize
```

`release:prepare` validates the code, builds the Apple Silicon app, signs its updater archive, and writes files under `release-artifacts/v0.4.30/`. `release:publish` creates and verifies a draft GitHub release. `release:finalize` publishes it and verifies that GitHub marks it as the latest release.

Updater credentials live at `~/.tauri/stacks-updater.key` and `~/.tauri/stacks-updater.password`. Back them up securely: losing the private key prevents existing installations from accepting future updates. Apple Developer ID signing and notarization are optional and are not part of the current release process.
