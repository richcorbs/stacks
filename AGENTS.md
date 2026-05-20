# AGENTS.md

Guidance for future coding agents working in this repository.

## Project overview

This is a Tauri v2 + React + Vite terminal workspace app named **Stacks**.

User-facing naming convention:

```text
Project → Workspace → Terminal
```

Internally, much of the legacy code still uses `TerminalEntry`/`terminalId` for user-facing workspaces and `Pane`/`paneId` for user-facing terminals. Prefer the user-facing terms in UI copy and product discussions unless doing a dedicated internal refactor.

- Frontend: React/TypeScript/xterm.js
- Backend: Rust/Tauri/portable-pty
- Current primary platform: macOS
- Project root: `stacks-tauri`

The app is inspired by `~/Code/stacks` but uses xterm.js for terminal emulation and Rust only for PTY/process/native integration.

## Common commands

Always validate meaningful changes with:

```bash
npm run test
npm run build
source "$HOME/.cargo/env" 2>/dev/null || true; cd src-tauri && cargo check
```

Build and install dogfood app:

```bash
source "$HOME/.cargo/env" 2>/dev/null || true
npm run tauri build -- --bundles app
./install.sh
```

Installed dogfood app path:

```text
~/Applications/Stacks.app
```

Open it with:

```bash
open ~/Applications/Stacks.app
```

The installer intentionally installs to `~/Applications` and handles replacing a running app.

## Important architecture

### Rust backend

Important file:

```text
src-tauri/src/lib.rs
```

Backend owns:

- PTY lifecycle via `portable-pty`
- Tauri commands:
  - `spawn_pty`
  - `write_pty`
  - `resize_pty`
  - `kill_pty`
  - `pty_cwd`
  - `git_info`
  - `app_stats`
  - `load_store`
  - `save_store`
  - `load_settings`
  - `save_window_state`
  - `save_current_window_state`
  - `save_sidebar_width`
  - `reset_settings`
  - `quit_app`
- Native menu bar
- Window title and size/position restoration

Notes:

- Release title is `Stacks`.
- Debug/dev title is `Stacks - DEV BUILD`.
- App display name/product name is `Stacks`.
- Backend is currently macOS/Unix-biased (`lsof`, `ps`, shell behavior, native macOS menus).
- Startup commands run in an interactive login shell for zsh/bash (`-lic`) so launched `.app` environments can find tools from shell setup, nvm, Homebrew, etc.

### Frontend structure

Key files/directories:

```text
src/main.tsx
src/types.ts
src/utils.ts
src/utils.test.ts
src/terminalSessionManager.ts
src/components/
src/hooks/
```

Important components:

- `src/components/Sidebar.tsx`
- `src/components/MainWorkspace.tsx`
- `src/components/TerminalWorkspace.tsx`
- `src/components/Dialogs.tsx`

Important hooks:

- `useWorkspaceState`
- `useWorkspaceCommands`
- `useKeyboardShortcuts`
- `usePaneActivity`
- `usePaneCwd`
- `useGitInfo`
- `useAppStats`
- `useImageDropToTerminal`
- `useWindowStatePersistence`
- `useSettingsPersistence`
- `useSidebarInteractions`
- `useFocusDebug`
- `useToast`

## Terminal/session lifecycle rules

Terminal sessions are intentionally not owned by React component mount lifecycle.

Use:

```text
src/terminalSessionManager.ts
```

for session operations:

- `getPaneSession`
- `setPaneSession`
- `focusPaneSession`
- `scrollPaneSessionToBottom`
- `disposePaneSession`
- `disposePaneSessions`

Do **not** add ad hoc `term.focus()` calls. Route terminal focus through `focusPaneSession()`.

Do **not** recreate xterm sessions on split-tree layout changes. Pane sessions are cached by pane id so panes can move/remount without losing PTY/xterm state.

PTY event generation ids are important. Do not remove them; they prevent stale PTY output/exit events from old processes from corrupting a new session.

Use streaming `TextDecoder` for PTY output. Decoding PTY chunks independently caused replacement/question-mark glyphs when UTF-8 characters were split across chunks.

## Focus debugging

Focus bugs are the most delicate area.

Enable debug logs in dev builds:

```js
localStorage.setItem('stacks.debugFocus', '1')
```

Disable:

```js
localStorage.removeItem('stacks.debugFocus')
```

Focus-related state includes:

- `activeTerminalId` (currently the selected user-facing workspace)
- `activePaneId` (currently the focused user-facing terminal)
- `focusedPaneByTerminalId` (focused terminal by workspace)
- `maximizedTerminalId` (the user-facing workspace that is maximized)
- `sidebarFocusedTerminalId`
- actual DOM/xterm focus

Be careful when changing maximize/split/close behavior.

## Split/pane behavior requirements

Current expected behavior:

- `Cmd+D`: split terminal right/side-by-side (`row`).
- `Shift+Cmd+D`: split terminal down/stacked (`column`).
- Splitting uses visual split-tree order and evenly distributes siblings in the split direction when auto-sized.
- Manual resize marks split nodes with `manual: true`; manually resized splits should not be auto-rebalanced.
- Closing a terminal selects the previous terminal in visual order, equivalent to `Cmd+[`.
- Closing the last terminal in a workspace must **not** remove the terminal. It should kill the process/session and remove the running green dot until the workspace is activated again.
- Maximization is workspace-level: `maximizedTerminalId` stores the maximized workspace id, not an individual terminal/pane id.
- If a workspace is maximized, the focused terminal inside it is displayed maximized; `Cmd+[` / `Cmd+]` changes the focused terminal and the maximized display follows.
- If splitting while maximized, split the underlying tree as if unmaximized, select the new terminal, and keep the workspace maximized.
- Maximizing/restoring a workspace scrolls the displayed terminal to the bottom.

Pure split tree logic lives in `src/utils.ts`; update/add tests in `src/utils.test.ts` for changes.

## Keyboard/menu shortcuts

Keyboard shortcut handling is in:

```text
src/hooks/useKeyboardShortcuts.ts
```

Native Shortcuts menu is built in Rust in:

```text
src-tauri/src/lib.rs
```

Menu items emit `menu-shortcut` events that run frontend `runShortcutAction()`.

Keep Rust menu entries and frontend actions in sync.

Current menu bar should be minimal:

```text
Stacks | Shortcuts | Window
```

Do not re-add generic `Edit`, `View`, or `Help` menus unless requested.

## Dialog/product UX preferences

- Dark, subdued blue-ish UI.
- Project titles toggle collapse and are not selectable workspaces.
- Right-click project menu includes `New Workspace`, `Edit`, `Delete`.
- Deleting a project requires confirmation.
- Closing a pane requires confirmation, with “Yes” focused by default.
- New project flow:
  1. User picks directory.
  2. Show Add Project dialog with name prefilled from basename and path prefilled.
  3. On submit, create project.
  4. After a short 200ms delay, open New Workspace dialog for that project.
  5. Created workspace should be selected/focused in the sidebar/workspace.
- Workspace/new/edit dialog input spacing is intentionally larger than generic dialogs.

## Clipboard and drag/drop behavior

- Selecting terminal text with mouse should copy clean text to system clipboard on mouse up, clear the selection, and show centered toast: `Copied to clipboard`.
- Uses `@tauri-apps/plugin-clipboard-manager` and Rust plugin/permission.
- Dragging image files onto terminal inserts shell-escaped file paths at the current cursor.
- Supported image extensions include png, jpg/jpeg, gif, webp, bmp, tif/tiff, heic/heif, svg, avif.

## Persistence

User data lives under OS data dir in `stacks-tauri/`.

On macOS usually:

```text
~/Library/Application Support/stacks-tauri/
```

Files:

- `projects.json`: projects, workspaces (legacy key: `terminals`), cwd, split trees.
- `settings.json`: window size/position and sidebar width.

There is no need to preserve backward compatibility for old local data unless the user specifically asks. The user is currently the only user.

`settings.json` can be removed to reset local UI settings. There is also a native menu item:

```text
Stacks > Reset Window Settings
```

## UI details to preserve

- Sidebar workspace shortcut hints align vertically while Cmd is held.
- Running green dot is hidden/replaced while shortcut hints are visible.
- Header/topbar:
  - Shows `Select a workspace` when no active terminal.
  - Only shows path/git/split buttons when there is an active terminal.
  - Shows split buttons to right of git status.
- Split buttons are CSS-drawn icons, not Unicode glyphs.
- Terminal frame uses custom padding and xterm scrollbar hiding. Be careful changing terminal dimensions; xterm/PTY width mismatch can cause wrapping or right-side gaps.

## Known tradeoffs / caution areas

- Focus/maximize/split lifecycle is the highest-risk area.
- `useWorkspaceCommands.ts` is large but intentionally centralizes orchestration. If it grows further, split into project/terminal/pane command hooks.
- Native macOS menu accelerators render using Apple glyphs; exact display characters are not fully controllable.
- Native menu item labels cannot partially style hint text in gray. For rich styling, build an in-app shortcuts panel instead.
- `npm run tauri build` without `-- --bundles app` may try DMG bundling and can fail; dogfood builds should use `-- --bundles app`.

## Git/commit habits

Before committing, run:

```bash
npm run test
npm run build
source "$HOME/.cargo/env" 2>/dev/null || true; cd src-tauri && cargo check
```

Then commit concise, descriptive messages.

If asked to push, check `git remote -v` first. This repo previously had no remote configured.
