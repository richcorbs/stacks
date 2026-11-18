# Latest-callback refs and Effect Events — card #334

Continuation of `docs/use-effect-event-296.md` in the dedicated
`stacks-card-334` worktree. The React 19.2 `useEffectEvent` API did not change;
this pass removes the remaining render-written refs that existed only to feed
an effect-owned callback or subscription.

## Converted sites

Every conversion keeps its public/returned callbacks as normal functions. Effect
Events are only invoked by listeners installed by the hook itself.

- **Native menu shortcuts** (`useMenuShortcutListener`, used by
  `useAppRootModel`): the `menu-shortcut` listener is installed once. Handler,
  interaction-blocker and confirmation state are read through one Effect Event.
  The old `shortcutRef` render write and the `[loading]` re-subscription are
  gone. Asynchronous `listen` cleanup is disposed-aware for StrictMode and
  unmount races.
- **Activity notifications** (`useActivityNotifications`): the enabled setting
  is read at attention time through an Effect Event; projects are read through
  a separate Effect Event *after* the card/permission awaits. The post-await
  freshness documented in #296 is preserved, and the two render-written refs
  are gone. The deduplicator remains mutable instance state.
- **Terminal restart requests** (`useTerminalRestartRequest`): the restart
  callback is an Effect Event. The nonce ref remains previous-value
  bookkeeping, but callback identity changes no longer re-run the nonce effect.
- **Terminal search** (`useTerminalSearch`): `searchOpen`/`searchTerm` are
  mirrored into one committed snapshot ref from an effect. The results callback
  stays a stable public callback (it is registered with the xterm session, so it
  cannot be an Effect Event).
- **Pi GUI file drops** (`PiGuiView`): the drop subscription is effect-owned, so
  the latest committed draft is read through an Effect Event instead of a
  render-written `promptRef`.
- **Pointer card ordering** (`usePointerCardOrdering`): cards and the reorder
  callback reach the once-installed window pointer listeners through refs that
  are committed from an effect, not written during render. Drag/frame/overlay
  state remains mutable controller state.
- **Board keyboard navigation** (`useBoardKeyboardNavigation`): the keydown
  listener is installed once and runs one Effect Event. Focused-card selection
  remains mutable state (the handler must advance it eagerly for repeated keys)
  and is mirrored after commit.
- **Project notes clipboard validation** and **confirmation ownership**:
  `activeRef`/`modelRef` and `owner.current` are now mirrored from effects
  rather than render, so post-await validation never reads an uncommitted render.

## Retained patterns and why

The remaining `Ref.current = …` sites are mutable state. The ambiguous ones
carry inline comments; the categories are:

- **Previous-value tracking**: terminal activation visibility/focus, Pi
  previous visibility/session id, restart and search nonces, handled reveal
  requests. These compare a previous committed value; they are not callbacks.
- **DOM/session/controller handles**: xterm hosts/terminals/fit addons, chat
  scroll controller, controller instances, blob/overlay elements.
- **Timeouts, animation frames, request generations**: pointer frames, toast
  and copy timers, path discovery tokens, event-page generations.
- **Persistence chains**: debounced save chains, window-state snapshots, settings
  field batching. Serializing writes is their purpose.
- **Operation/busy flags**: updater, settings save, release preparation, PR
  merge, card creation, workflow action, done-cleanup, dialog submission.
- **Mutable controller state read across awaits or by persistent objects**:
  - `useCardDetailModel` (`latest`, `navigation`) validates discard/navigation
    after an awaited confirmation.
  - `KanbanCardDetail` (`currentCard`, `onCardUpdated`, workflow action refs)
    shares state with the async workflow executor, the shell coordinator, and
    the parent-registered workflow controller.
  - `KanbanBoardView` (`selectedCardId`, `selectedDetail`, `boardCards`,
    `cardServices`, `directWorkProjectId`, `openCard`) assigns eagerly in event
    handlers before React commits, then reads those transitional values from
    async continuations, subscriptions and the detail coordinator. `openCard`
    feeds a public palette callback, which cannot be an Effect Event.
  - `useCardTerminalWorkspace` (`cardPath`) and `useDirectProjectShell`
    (`projectPath`) are read by persistent shell-controller commands that are
    also UI-triggered, not only effect-owned subscriptions.
  - `useKanbanRefreshCoordinator` (`snapshot`, `patchCard`, `statusCache`) is a
    persistent coordinator created once.
  - `PiGuiView` (`quickResponseSessionEligible`, `composerFocusAllowed`) is read
    across an await from a UI handler and inside a deferred animation frame.
  - `useTerminalSession.active` participates in deferred session attach/focus.
  - `useKanbanBoard` lazily creates its controller handle during render.
- **Caches and drag/selection bookkeeping**: detail caches, event cursors,
  revision trackers, pending notification routes, pointer drag state, and
  composer history/selection state.

`eventCursorRef` is written by `updateCursor` (an event/async helper), not by
render; it is committed request-state bookkeeping for the detail cache.

## Regression coverage

New or extended tests:

- `src/hooks/useMenuShortcutListener.test.tsx`: latest committed handlers,
  blocker/confirmation reads, one native registration, StrictMode balance,
  async unlisten, and no dispatch after unmount.
- `src/hooks/useActivityNotifications.test.tsx`: enabled-flag changes without
  re-subscription, post-await project freshness, lifecycle deduplication and
  unsubscribe.
- `src/hooks/useTerminalRestartRequest.test.tsx`: new-nonce-only restarts,
  latest callback without identity-triggered restarts, StrictMode.
- `src/hooks/useTerminalSearch.test.tsx`: stable public callback, closed/empty
  suppression, committed text, cleanup.
- `src/components/PiGuiView.test.tsx`: repeated file drops use the latest
  committed draft through the single subscription.
- `src/kanban/usePointerCardOrdering.test.tsx`: a committed reorder callback
  change is observed without re-registering pointer listeners.
- `src/kanban/useBoardKeyboardNavigation.test.tsx`: one keydown registration
  across navigation input changes.

Existing focus/card-selection suites (`PiGuiView` composer-focus/MCP dismissal,
`KanbanBoardView`-adjacent selection tests, `useCanonicalCardSelection`,
`useCardDetailModel`, `ConfirmDialogs`, `ProjectNotesView`) remain green.

## Validation

- `npm run test`: 173 files, 1,367 passed, 2 skipped, plus Kanban contract and
  boundary checks.
- `npm run build`: TypeScript and production Vite build.
- `cargo check` in `src-tauri`.

No dogfood install or native GUI smoke was performed in this pass, so Cmd
shortcuts, splits/maximize/focus, card switching and composer focus after
dialogs were validated by tests and code inspection only.
