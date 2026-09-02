# Pi GUI architecture

Pi GUI panes use one persistent `pi --mode rpc` process per pane ID.

## Ownership

- Rust (`src-tauri/src/pi_rpc.rs`) owns child processes, stdin serialization, process generations, cleanup, and session directories.
- `usePiSession.ts` owns the typed RPC request broker and translates events into UI state.
- `PiGuiView.tsx` owns presentation only.
- The persisted split leaf is authoritative for pane kind; `PaneEntry` is its runtime projection and must be rebuilt from the split tree during workspace initialization.
- Pi session files live under the app data directory in `pi-sessions/<pane-id>/`.

React mount/unmount does not own process lifetime. Split-tree remounts must not terminate a conversation. Explicit stop, pane deletion, workspace deletion, project deletion, and app shutdown control the backend process.

## Lifecycle rules

- Every process has a generation ID. Frontend listeners reject events from stale generations.
- Restart marks the old generation invalid before stopping it.
- A stopped final pane remains persisted and restarts when its workspace becomes visible again.
- Removing a Pi pane permanently calls `delete_pi_session`; stopping it retains its session.
- Pi process start and exit events feed the shared `terminal-running-changed` projection so Pi-only workspaces receive the sidebar's running status dot. Assistant deltas and tool starts also emit `terminal-output`, giving background Pi workspaces the same fresh/unseen activity dots as terminals.
- Child processes are reaped by a dedicated process thread. Pi and setup shells run in dedicated process groups so stop, timeout, and app shutdown also terminate tool descendants.
- Concurrent starts for one pane are idempotent; remounts wait for the in-flight owner.

## Workspace setup

New Workspace can run an optional setup command before creating any pane. Rust runs it in the project directory through the user's interactive login shell and captures the shell's final physical working directory. Workspace state is committed only after a successful exit, so a Pi process always starts in the resulting worktree. Setup shells receive `STACKS_WORKSPACE_SETUP=1` so shared shell functions can skip launching their own interactive agent.

Shell-local exported variables do not survive into the later Pi process. Setup commands should prefer filesystem-based environment setup, or the process manager must gain an explicit environment handoff protocol.

## Trust

Pi starts with `--no-approve`. Project-local Pi settings, packages, skills, and extensions are ignored until the user explicitly trusts that canonical working directory. The Rust backend owns trust decisions in `pi-trusted-projects.json`; trusting or revoking restarts the process with the corresponding flag.

Project trust is not a sandbox. Pi tools still run with the user's permissions.

## Transcript synchronization

`get_messages` is used only for initial hydration, restart recovery, compaction, and session changes. Normal turns append typed `message_end` events incrementally. When a durable tool-result message arrives, its matching live tool card is removed by tool-call ID so the command is not displayed simultaneously as both live and historical. Durable context remains in Pi's session file; React keeps a bounded recent projection, removes hydrated historical base64 image payloads, and renders at most 300 messages to keep memory and Markdown work bounded. Newly submitted image prompts retain up to 10 recent preview payloads so dragged images remain visible in user chat bubbles; older previews degrade to placeholders. Pi expands `/skill:name` into the full `SKILL.md` contents for model context; the GUI collapses that expanded user message back to the original skill invocation so documentation does not flood the visible transcript.

RPC requests use unique IDs and resolve only when their matching response arrives. Fire-and-forget extension UI events are not added to the request broker.

While Pi is working, Enter sends the composer through RPC `steer`, and Option+Enter sends it through RPC `follow_up`, matching Pi's CLI behavior. Pending steering messages and follow-ups are projected from `queue_update` events and displayed as subdued, labeled user bubbles in the conversation rather than inside the composer. When Pi delivers one, its user `message_end` removes the queued projection and the durable message renders with normal user styling.

RPC extensions and skills can return text to the composer through the fire-and-forget `extension_ui_request` method `set_editor_text`; the session projects that request into `PiGuiView`, which replaces and focuses the composer text.

App-level focus restoration emits `pane-focus-request` when the active pane has no xterm session. Active Pi panes listen for their pane ID and restore composer focus after dialogs, settings, palettes, and context menus close. Pane activation, app-window focus, and non-interactive clicks within a Pi pane also restore composer focus.

While a run is active but has not produced assistant text or a live tool card, the conversation shows an animated ellipsis (with an accessible `Pi is thinking` label) so activity is not communicated only by the composer stop button.

The context footer refreshes RPC `get_session_stats` after startup, restart, and each settled run. It renders `contextUsage` as a percentage donut with exact token counts in its tooltip. App-level Cmd+V routing checks both the event target and active element before attempting a PTY write. The Pi composer handles Cmd+V directly through the clipboard plugin so paste remains reliable in the Tauri webview.

## Skills and slash commands

Pi performs its standard global resource discovery at process startup and adds loaded skills to the model context. Trusted projects additionally load their project-local skills, prompt templates, packages, and extensions. Trust is recorded for the user-facing project path and inherited by workspace directories such as Git worktrees. After startup the GUI calls RPC `get_commands` and offers completion for `/skill:name`, prompt-template commands, and extension commands; the selected text is sent through RPC `prompt`, where Pi performs the actual expansion or execution.

RPC does not return built-in TUI commands from `get_commands`. The GUI supplements completion with built-ins it can implement through dedicated RPC commands: `/new` maps to `new_session`, and `/compact [instructions]` maps to `compact`. Other TUI-only commands remain unavailable until the GUI provides their corresponding interaction.
