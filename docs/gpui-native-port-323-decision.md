# Native GPUI port — cost/benefit decision (card #323)

## What was built

The #323 branch took the #321/#322 GPUI shell from a LIST/terminal spike to a
usable native card workspace:

- Native LIST with live SQLite projection, project filters, keyboard navigation
  and backlog reorder.
- Tabbed card detail: Description, Agent, Diff placeholder, Terminal, Server and
  Console.
- Native Pi RPC agent with transcript hydration, streaming, tool cards,
  steering/follow-up, model/effort selectors, usage and lifecycle projection.
- Shared terminal panes for card and project workspaces: splits, maximize,
  search, copy/paste, services and released output.
- Shared workflow engine (`crates/stacks-workflow`) extracted from Tauri, used by
  both apps.
- Workflow footer with confirmations, `Cmd+Enter`, local lifecycle actions,
  start work, approval, local/target/PR merge, PR creation, cleanup and scripted
  delivery, including supervised deploy/cancel.
- Native Release tab and project workspace.
- Contract checks moved to the shared workflow source.

## Honest verdict

**Valuable as a feasibility spike and architecture exercise; not yet proven as
the product’s primary UI.**

The native shell is real, not a mock. It proves GPUI can host the terminal,
agent, card detail and workflow surfaces. The shared workflow extraction is a
durable win independent of the UI decision.

But the branch also duplicates a large product surface. Until the Tauri/React UI
is retired, every parity fix must be maintained twice. There is no measured
evidence yet that the native shell is faster, less buggy or faster to develop
than the shipped app.

## Where native is plausibly better

- Terminal-first feel and direct PTY/xterm-equivalent control without a webview
  boundary.
- Tighter keyboard/focus ownership and a path to native accessibility.
- One Rust workflow engine rather than a Rust + TypeScript parity layer.
- Potential startup/memory/latency wins (not yet measured against a fresh Tauri
  launch).
- Better long-term ceiling for native macOS integration.

## Where it is currently worse

- Two frontends and two interaction models.
- Very large parity surface: focus, IME, terminal sizing, confirmations,
  drag/drop, errors, shortcuts, provider sync, cleanup and delivery.
- GPUI is pre-1.0; API churn is a recurring migration tax.
- Native UI automation/accessibility testing is weaker than the web stack.
- The workflow engine is shared, but the product behavior can still diverge in
  ways tests do not catch.
- No measured win yet.

## Decision gate

Do not decide from sunk cost. Commit and dogfood the native shell for one to two
weeks, then compare:

1. How often do you fall back to Tauri?
2. Terminal/focus/IME/agent regressions per day.
3. Time to implement a normal card/detail/workflow change in each stack.
4. Startup, memory and interaction latency on the same database.
5. Crash/error rate and recoverability.
6. Whether VoiceOver/AccessKit is usable enough for daily work.

Continue the migration only if native clearly wins on at least one core product
axis **and** matches Tauri everywhere else. Otherwise stop the UI migration, keep
`crates/stacks-workflow` and the reports, and treat the GPUI work as a successful
feasibility spike.

## Remaining gaps if the migration continues

- Native DIFF review and card editing/creation.
- Superthread/provider sync parity and complete settings UI.
- Native UI automation, VoiceOver/AccessKit pass and terminal helper smoke.
- Longer dogfood/measurement run against the shipped app.
- A deliberate cutover/removal plan for the Tauri UI and its duplicated
  workflow presentation.
