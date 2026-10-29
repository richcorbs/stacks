# Effect subscription callbacks — card #296

Implemented on `stacks/card-296-evaluate-useeffectevent-for-react-subscription-c`
in the dedicated `stacks-card-296` worktree. The persisted local card was read
without mutation; its description matches the requested acceptance criteria.
This is a simplification follow-up to #292, not an API unlocked by that upgrade:
`useEffectEvent` was already available in React 19.2.

## Targeted change

`src/hooks/useKeyboardShortcuts.ts` now uses three Effect Events in place of
render-written handler/blocker refs. The window subscriptions are effect-owned;
they have no reactive subscription key. Handler and blocker identity changes
should affect the next event, not tear down and recreate the subscriptions.
The Effect Events read the latest **committed** render, avoiding exposure of
callbacks from an uncommitted render through ref writes.

Effect Events are called only by the effect-installed listeners, not exported
as general callbacks or included in dependency arrays. Capture flags, blocking
order, confirmation checks, routing, Meta keyup/blur resets, and exact listener
cleanup are unchanged. No terminal session or focus implementation was changed.

## Evaluated patterns intentionally retained

- `useAppRootModel`'s native `menu-shortcut` callback is another appropriate
  effect-owned candidate. Its `shortcutRef` is retained for this targeted pass:
  replacing it should come with focused native subscription tests, including
  the asynchronous listen/unlisten lifecycle. This is not an assertion that
  Effect Events would be inappropriate there. The existing `[loading]`
  dependency is unchanged.
- `useActivityNotifications`' attention subscription is also a candidate, but
  delivery reads `projectsRef.current` **after** permission/card-fetch awaits.
  Moving the entire async function into one Effect Event would capture projects
  at invocation rather than preserve that later fresh read. A safe conversion
  needs a separately tested post-await read boundary; it is not a simple ref swap.
  Its deduplicator ref is mutable instance state, not callback plumbing.
- `useTerminalSearch` returns its stable results callback for another hook to
  register with a session. It is not a locally effect-owned callback; do not
  replace this public callback with an Effect Event passed between hooks.
- `useDirectProjectShell`'s project-path ref is used by a persistent controller's
  commands, including UI-triggered commands, not exclusively an effect-owned
  subscription. Its coordinator ref owns mutable lifecycle state.
- `useTerminalSession`'s active ref participates in deferred session attachment
  and appearance/focus lifecycle. It is outside this keyboard-only change;
  changing it deserves terminal lifecycle tests, not blanket ref replacement.
- Previous-value, DOM/session, timeout, persistence-chain and operation-state
  refs are stateful bookkeeping, not latest-callback shims.

No reactive dependencies were removed or hidden behind Effect Events.

## Regression coverage and validation

`src/hooks/useKeyboardShortcuts.test.tsx` uses real React Effect Events and the
real shortcut router. Only confirmation visibility is mocked. Tests verify:

- Updated handlers and terminal routing state without listener re-registration.
- Updated blocking callbacks; prevented default and immediate propagation stop;
  unblocking without re-registration; Meta keyup/blur reset even while blocked.
- Confirmation suppression without consuming the key.
- Original capture flags, matching callback cleanup, no dispatch after unmount,
  and balanced StrictMode setup/cleanup with no duplicate shortcut execution.

The Node EventTarget fixture normalizes boolean capture removal to an options
object to match browser behavior; production registration flags are unchanged.

Passed:

- `npm run test`: 161 files, 1,284 tests, plus Kanban contract/boundary checks.
- `npm run build`: TypeScript and production Vite build.
- `cargo check` in `src-tauri`.

No installed app was replaced or restarted. Native GUI/focus smoke testing was
not performed; no native integration or focus behavior was intentionally changed.
