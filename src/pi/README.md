# Pi GUI architecture

Pi GUI panes use one persistent `pi --mode rpc` process per pane ID.

## Ownership

- Rust (`src-tauri/src/pi_rpc.rs`) owns child processes, stdin serialization, process generations, cleanup, and session directories.
- `sessionController.ts` owns one pane-ID-keyed frontend controller for the app lifetime. It owns the typed RPC request broker, sole pane event subscription, generation filtering, transcript/tool/queue projection, completion eligibility, and structured UI requests.
- `usePiSession.ts` is a `useSyncExternalStore` adapter. Mounting or unmounting it only adds or removes a React snapshot subscriber.
- `PiGuiView.tsx` owns presentation and publishes whether its Agent view is currently open.
- The persisted split leaf is authoritative for pane kind; `PaneEntry` is its runtime projection and must be rebuilt from the split tree during workspace initialization.
- Pi session files live under the app data directory in `pi-sessions/<pane-id>/`.

React mount/unmount does not own process or frontend session lifetime. Split-tree remounts, card closure, and project switching must not terminate a conversation or detach its frontend event projection. Explicit stop still controls the process; pane/card/workspace/project deletion removes the persistent controller after backend deletion; app shutdown remains the final process cleanup boundary.

## Lifecycle rules

- Every process has a generation ID. Frontend listeners reject events from stale generations.
- Restart marks the old generation invalid before stopping it.
- A stopped final pane remains persisted and restarts when its workspace becomes visible again.
- Removing a Pi pane permanently calls `delete_pi_session`; stopping it retains its session.
- Pi process start and exit events feed the shared `terminal-running-changed` projection so Pi-only workspaces receive the sidebar's running status dot. Assistant deltas and tool starts also emit `terminal-output`, giving background Pi workspaces the same fresh/unseen activity dots as terminals. A naturally settled agent run emits `app-attention`; the application-level notification hook filters out the active, focused workspace and honors the notification setting. User-aborted runs do not notify.
- Child processes are reaped by a dedicated process thread. Pi and setup shells run in dedicated process groups so stop, timeout, and app shutdown also terminate tool descendants.
- Concurrent starts for one pane are idempotent. React Strict Mode and remounts reuse the same controller and backend subscription rather than issuing another start.
- Initial hydration merges durable history with any `message_end` events received while hydration is in flight. Activity revisions prevent an older `get_state` response from overwriting newer start/settle state.

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

Structured `extension_ui_request` methods (`confirm`, `select`, `input`, and `editor`) are retained by the controller even with no mounted view. Planning and work threads project attention independently. A planning turn moves queued or waiting refinement to `refining`; a structured planning request immediately moves it to `needs_refinement_input` whether or not the Agent tab is visible, and responding restores `refining` before forwarding the response. A naturally settled or errored planning turn moves only a still-`refining` card to `needs_refinement_input`. Finishing refinement atomically saves the brief and moves to `ready`, so stale settle events cannot reverse it.

For work threads, a card Agent tab counts as open when its detail is mounted with Agent selected; OS/window focus is irrelevant. Only a hidden structured work request conditionally moves an `agent_working` card to `needs_human`; responding restores `agent_working` before forwarding the response. Timeout, replacement, or controller deletion reconciles only the exact status revision created by that request, so manual or automation changes win in either thread.

**Stop refinement** first revision-checks an explicit user transition to `needs_refinement`, dismisses pending planning UI without restoring `refining`, and aborts an active turn through the retained controller. It does not delete or restart the persistent planning session, so the transcript can be resumed. The queued status makes the abort's later settle event a no-op.

App-level focus restoration emits `pane-focus-request` when the active pane has no xterm session. Active Pi panes listen for their pane ID and restore composer focus after dialogs, settings, palettes, and context menus close. Pane activation, app-window focus, and non-interactive clicks within a Pi pane also restore composer focus.

While a run is active but has not produced assistant text or a live tool card, the conversation shows an animated ellipsis (with an accessible `Pi is thinking` label) so activity is not communicated only by the composer stop button.

The context footer refreshes RPC `get_session_stats` after startup, restart, and each settled run. It renders `contextUsage` as a percentage donut with exact token counts in its tooltip. App-level Cmd+V routing checks both the event target and active element before attempting a PTY write. The Pi composer handles Cmd+V directly through the clipboard plugin so paste remains reliable in the Tauri webview.

## File references and native drops

Typing an `@path` token at the composer caret opens ignore-aware fuzzy completion rooted at the Pi session working directory. Discovery includes hidden files and directories, honors Git ignore rules, excludes `.git`, does not follow symlinks, and is bounded in both traversal and returned results. Choosing a directory continues completion inside it; choosing a file adds trailing space. Only the active token is replaced, and references that contain spaces or shell-significant characters use Pi's quoted form, such as `@"docs/my file.md"`.

The app owns one Tauri native drag/drop listener. Physical native coordinates are converted with the current window scale factor and hit-tested against pane identities, so a drop is delivered to the Pi pane beneath the pointer rather than whichever shell pane is active. Pi panes highlight on enter/over and insert every dropped file or directory at the composer's last saved selection. Paths inside the session working directory become relative references; external paths remain absolute. Images follow this same textual-reference path and are not converted into model attachments. Shell panes retain their existing image-path insertion behavior.

## Skills and slash commands

Pi performs its standard global resource discovery at process startup and adds loaded skills to the model context. Trusted projects additionally load their project-local skills, prompt templates, packages, and extensions. Trust is recorded for the user-facing project path and inherited by workspace directories such as Git worktrees. After startup the GUI calls RPC `get_commands` and offers completion for `/skill:name`, prompt-template commands, and extension commands; the selected text is sent through RPC `prompt`, where Pi performs the actual expansion or execution.

RPC does not return built-in TUI commands from `get_commands`. The GUI supplements completion with built-ins it can implement through dedicated RPC commands: `/new` maps to `new_session`, and `/compact [instructions]` maps to `compact`. Other TUI-only commands remain unavailable until the GUI provides their corresponding interaction.
