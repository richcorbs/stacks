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
- Saves reusable workspace templates that can be launched from the command palette, reviewed and adjusted in the New Workspace dialog, and edited or deleted later.
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
- Lists GitHub pull requests and Actions status, opens PRs in the browser, and merges with a configurable strategy. Optional post-merge cleanup targets the workspace associated with the PR, runs `/cleanup` in its Pi GUI, stops its processes, safely removes its exact Git worktree, and removes the workspace only after successful completion.
- Optionally browses Superthread boards and creates a workspace from a selected card.

### Workflow and customization

- Provides a per-project notes scratch pad that covers the main workspace, saves automatically, and toggles instantly from the keyboard or top bar.
- Provides a keyboard-first command palette with custom saved commands.
- Persists projects, project notes, workspace layouts, active/focused panes, window geometry, sidebar width, app settings, and resumable post-merge cleanup operations.
- Configures terminal typography and scrollback, copy-on-select, confirmation and notification behavior, editor integration, status colors, GitHub polling, and Superthread behavior.
- Checks signed updater artifacts published through GitHub Releases.

### Repository release commands

Enable **RELEASES** in project settings and select a repository-relative configuration (default `.stacks/release.json`):

```json
{
  "command": "./scripts/release",
  "latestCommand": "./scripts/latest-release"
}
```

Only `command` is required. The tab has a version field, latest-release text, a RELEASE button, and the normal terminal for live output. A shared delayed confirmation precedes each run. Commands run in the project's canonical primary repository root through the interactive login shell; linked worktrees are rejected. `STACKS_RELEASE_VERSION` contains the trimmed selected version, and `STACKS_RELEASE_PROJECT_PATH` the root. Values are shell-quoted environment data, never substituted into command syntax. Scripts must quote their own expansions (e.g. `"$STACKS_RELEASE_VERSION"`) or read the environment directly. The repository script owns version validation, release notes, CI, builds, approvals and publication policy.

The optional `latestCommand` should print a short version identifier to stdout. It is read once when the tab opens and after successful runs, has a 15-second timeout, and reports missing configuration/authentication/lookup failures without blocking release. App-level concurrent starts are blocked per repository; scripts should additionally lock against CLI invocations. Cached terminal output/processes survive tab changes and closing/reopening Project Workspace; they end on app shutdown. Final status comes from the actual child exit, not matching output text. Old app-owned release journals are no longer resumed; inspect any previously unfinished release manually before starting the new script.

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
| Increase / decrease terminal, Pi, and DIFF text | ⌘+ / ⌘− |
| Increase / decrease interface text | ⌥⌘+ / ⌥⌘− |
| Focus or toggle diff panel | ⌘G |
| Focus or toggle pull requests | ⇧⌘G |
| Focus next workspace with unseen output | ⇧⌘N |
| Toggle project notes | ⇧⌘O |
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

- Node.js 22.12+ (22.x), or Node.js 24+; Node 22.19.0 is validated locally.
- Rust 1.99.1 and Cargo, pinned by `rust-toolchain.toml` (CI uses the same version).
- rustup 1.29.2 recommended. rustup itself is machine-local, not managed by Cargo.
- macOS

Install/update the local toolchain manager with `rustup self update`; rustup installs
this repository's pinned toolchain when a Cargo command first runs. Dependency
updates must deliberately update both `rust-toolchain.toml` and the CI toolchain
when changing Rust versions. `Cargo.toml` also declares the supported Rust minimum.

```bash
npm ci
npm run tauri dev
```

The frontend is React 19 + TypeScript + Vite + xterm.js. The Tauri/Rust backend owns PTYs, Pi RPC processes, persistence, native menus, automation, and external CLI integrations.

Debug builds use `stacks-dev` in the OS application-support directory; installed builds use `stacks`. Their databases, settings, sessions, process state, and automation sockets are isolated. To replace dev data with a sanitized, consistent snapshot of installed-build board/project/UI data, quit the dev app and run:

```bash
npm run seed:dev
```

The command requires typing `seed dev`. It reads production SQLite through the online backup API and atomically swaps dev data only after validation. It does not copy Pi transcripts, active operations, runtime/service state, lifecycle generations, or card worktree ownership, and seeded profiles do not automatically resume active-looking cards.

Validate changes with the same checks used by CI:

```bash
npm run check:version
npm run test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
npm audit
# Install once: cargo install cargo-audit --locked
cargo audit --file src-tauri/Cargo.lock
# Browser smoke tests (install browsers once):
npx playwright install chromium webkit
npm run test:chat-scroll
npm run test:terminal-dependencies
```

See [the coordinated dependency upgrade report](docs/dependency-upgrade-292.md)
for version changes, security exceptions, and native/release smoke-test status.
For opt-in debug-build slow board-query profiling, see
[SQLite diagnostics](docs/sqlite-diagnostics.md).

Build and install the local application:

```bash
npm run release:build
./install.sh
open ~/Applications/Stacks.app
```

## Data and reset behavior

Application data remains under:

```text
~/Library/Application Support/stacks/
```

Important files and directories include:

- `workflow.sqlite3` — schema-versioned projects, cards, card environments, pane layouts, and service definitions.
- `projects.json` — compatibility mirror for legacy Stacks builds; migrated data is also preserved once as `projects.json.migrated`.
- `settings.json` — UI preferences, window state, and the last active/focused workspace state.
- `pi-sessions/` — durable Pi session files by terminal ID.
- `pi-trusted-projects.json` — canonical project paths approved for project-local Pi resources.

When upgrading from an installation that used `stacks-tauri`, quit Stacks first and copy the entire `~/Library/Application Support/stacks-tauri/` directory into the new `stacks/` directory (including `workflow.sqlite3`, any WAL files, sessions, card data, and release logs). Do not merge it with older data already in `stacks/`, and keep the old directory as a rollback copy until the new app has been verified. The installer does not migrate data. Old release logs are retained only as historical files. Development data in `stacks-tauri-dev` is not automatically copied into `stacks-dev`; use `npm run seed:dev` to initialize a sanitized development profile. **Stacks → Reset Window Settings** resets saved window geometry and sidebar width. Deleting `settings.json` while Stacks is closed resets all preferences and remembered UI state.

## Versioning and releases

Stacks configures `node scripts/release-run.mjs draft` in `.stacks/release.json`. The RELEASE button **creates a draft; it does not publish**. The repository-owned driver reuses `scripts/release.mjs` and `release-lib.mjs` for version synchronization, clean-main validation, deterministic commit-subject notes, release commit, tests, frontend/Rust checks, signed app/updater artifacts, manifest/checksums, safe pushes and GitHub draft creation/upload verification. It prints clear phase headings, version/mode/checkout, live build output, and success/failure summaries with next steps.

From the primary checkout with `main` checked out:

```bash
# Use the selected stable X.Y.Z, greater than the latest published release.
node scripts/release-run.mjs draft --version 0.6.0
# Equivalent to the app's version contract:
STACKS_RELEASE_VERSION=0.6.0 node scripts/release-run.mjs draft

# Smoke-test the signed draft using the URL printed above, then explicitly publish:
node scripts/release-run.mjs publish --version 0.6.0
```

`npm run release:draft -- --version X.Y.Z` is a convenience alias. The legacy `release:publish` alias still creates a **draft**, preserving its previous policy; `release:finalize` now invokes the explicitly confirmed publishing driver.

Publishing requires an interactive terminal, a two-second confirmation delay, and typing `PUBLISH v<version>` to attest smoke testing. It verifies the exact prepared commit, artifacts and draft, requires the latest `.github/workflows/ci.yml` run for that exact commit to succeed, then publishes and verifies GitHub latest. No automatic draft-to-public transition occurs.

Script-owned context and notes live under the Git common directory's `stacks-releases/v<version>/`; repeat the same draft command to resume, reusing only verified artifacts. Failures stop with a nonzero exit and leave commits/tags/artifacts intact. `stacks-release.lock` prevents concurrent CLI/app runs; after a hard interruption, verify all prior processes are stopped before manually removing that lock. Do not reset/rewrite a prepared commit or overwrite remote assets to make a retry pass. Older app-journal releases have no new script context and require manual inspection. Low-level `release.mjs` helper commands remain available for diagnosis; normal releases should use the driver.

Updater credentials live at `~/.tauri/stacks-updater.key` and `~/.tauri/stacks-updater.password`. Back them up securely: losing the private key prevents existing installations from accepting future updates. Apple Developer ID signing and notarization are optional and are not part of the current release process. No release command automatically deletes or overwrites commits, tags, drafts, assets, or published releases.
