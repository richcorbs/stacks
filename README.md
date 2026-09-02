# Stacks

Stacks is a macOS terminal workspace app for developers who organize their work by project. It is built with Tauri, React, TypeScript, Rust, xterm.js, and portable-pty.

## Features

- Projects containing persistent workspaces and terminals
- PTY-backed xterm.js terminal emulation
- Split and maximized terminal layouts
- Dedicated Pi GUI terminals with tools, skills, images, and conversation history
- Integrated Git diff review, GitHub pull requests/actions, and Superthread views
- Workspace activity indicators and keyboard-driven navigation
- Persistent window, sidebar, workspace, and focused-terminal state
- Signed in-app updates from GitHub Releases

## Development

Prerequisites:

- Node.js 22+
- Rust/Cargo
- macOS

```bash
npm install
npm run tauri dev
```

Validate changes with:

```bash
npm run test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Build and install the local application:

```bash
npm run release:build
./install.sh
```

The default installation location is `~/Applications/Stacks.app`.

## Versioning and releases

Set all application version files together:

```bash
npm run version:set -- 0.4.17
npm run check:version
```

Add release notes at `releases/v0.4.17.md` and commit the version change. Releases are built locally so the process has no CI or Apple Developer Program cost:

```bash
git tag v0.4.17
git push origin main v0.4.17
npm run release:prepare
npm run release:publish
```

`release:prepare` runs all validation, builds the Apple Silicon app, signs its updater archive, and writes artifacts under `release-artifacts/v0.4.17/`. `release:publish` creates a draft GitHub release with the legacy-compatible ZIP uploaded first. Smoke-test the draft before publishing it.

The updater key and password are stored locally at `~/.tauri/stacks-updater.key` and `~/.tauri/stacks-updater.password`. Back them up securely; losing them prevents existing installations from accepting future updates. Apple Developer ID signing and notarization are optional and are not required by this free release process.

## Command-line automation

When Stacks is running, its executable can create a workspace in the selected project:

```bash
~/Applications/Stacks.app/Contents/MacOS/stacks \
  workspace create \
  --name "Run API" \
  --startup-command "npm run dev"
```

Use `--run` instead of `--startup-command` to execute a one-time command and return its exit status.

## Data

Application data remains under:

```text
~/Library/Application Support/stacks-tauri/
```

This location is retained so existing Tauri installations keep their projects and settings after the repository and bundle-identifier migration.
