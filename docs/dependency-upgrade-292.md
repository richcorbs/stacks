# Coordinated dependency upgrade — card #292

Registry review and validation: 2026-10-29. Worktree: `stacks-card-292`, branch
`stacks/card-292-update-all-frontend-rust-and-toolchain-dependenc`.
The persisted local card was inspected read-only and matches the requested scope.

## Versions

All direct npm and Rust dependencies were checked against current stable registry
releases, including major versions. Both lockfiles were refreshed. Tauri 3 alpha
is deliberately excluded: latest stable Rust core is 2.12.5. Unchanged packages
below were already latest stable. Manifest version floors now match this review.

### Frontend and build tools (resolved lockfile versions)

| Dependency | Before | After |
| --- | --- | --- |
| React / React DOM / react-test-renderer | 19.2.8 | 19.3.1 |
| @types/react | 19.2.18 | 19.3.0 |
| @types/react-dom | 19.2.5 | 19.3.0 |
| @types/react-test-renderer | 19.1.0 | 19.3.0 |
| @tauri-apps/api | 2.11.1 | 2.12.4 |
| @tauri-apps/cli | 2.11.4 | 2.12.4 |
| clipboard-manager (JS and Rust) | 2.3.3 | 2.5.0 |
| dialog (JS and Rust) | 2.7.3 | 2.8.4 |
| notification (JS and Rust) | 2.4.0 | 2.8.0 |
| process (JS and Rust) | 2.3.1 | 2.4.0 |
| updater (JS and Rust) | 2.11.0 | 2.14.1 |
| @xterm/xterm | 5.5.0 | 6.0.0 |
| @xterm/addon-fit | 0.10.0 | 0.11.0 |
| @xterm/addon-unicode11 | 0.8.0 | 0.9.0 |
| @xterm/addon-search | 0.16.0 | unchanged |
| @xterm/addon-web-links | 0.12.0 | unchanged |
| DOMPurify | 3.4.14 | 3.4.17 |
| Vite | 8.2.2 | 8.3.5 |
| @vitejs/plugin-react | 6.1.1 | 6.1.2 |
| Vitest | 4.1.11 | 5.0.5 |
| TypeScript | 5.9.3 | 7.0.2 |
| esbuild | 0.28.2 | unchanged |
| Playwright | 1.64.1 | unchanged |
| react-markdown | 10.1.0 | unchanged |
| rehype-raw / rehype-sanitize / remark-gfm | 7.0.0 / 6.0.0 / 4.0.1 | unchanged |

### Rust and toolchain

| Dependency | Before | After |
| --- | --- | --- |
| Rust / Cargo | 1.95.0 | 1.99.1 |
| rustup | 1.29.0 | 1.29.2 |
| tauri | 2.11.5 | 2.12.5 |
| tauri-build | 2.6.3 | 2.7.4 |
| rusqlite | 0.32.1 | 0.41.1 |
| bundled libsqlite3-sys | 0.30.1 | 0.39.1 |
| portable-pty | 0.8.1 | 0.9.0 |
| dirs | 6.0.0 | 7.0.0 |
| uuid | 1.26.0 | 1.29.0 |
| ignore | 0.4.33 | 0.4.34 |
| libc | 0.2.189 | 0.2.191 |
| notify-rust | 4.18.0 | 4.18.2 |
| serde_json | 1.0.151 | 1.0.154 |
| serde / wait-timeout | 1.0.229 / 0.2.1 | unchanged |

Rust/rustup were updated locally. `rust-toolchain.toml`, the crate's `rust-version`,
and CI now agree on 1.99.1; installing rustup remains a machine-local prerequisite.
Node 22.19.0 / npm 10.9.3 were used. The declared Node engine floor is 22.12
(or 24+), matching the supported Vite toolchain; no Node major upgrade is needed.

## Migrations

- Notification `onAction` now receives an `ActionPerformed` envelope: route from
  `event.notification?.extra`, not `event.extra`. Regression coverage includes
  a real-shaped envelope and missing notification metadata.
- rusqlite no longer reads `usize` directly. Read SQLite's signed 64-bit count
  and perform a checked conversion, returning an error for invalid counts.
- SQLite query-count instrumentation now uses `trace_v2` statement events instead
  of the removed `trace` API. Existing constant-query-count assertions still pass.
- Tauri regenerated the tracked ACL schemas for its updated plugins. No new
  application capability grant was added manually.
- Existing xterm session lifecycle and TypeScript/Vite configuration remain
  compatible; no focus/session ownership refactor was necessary.
- New real PTY and browser terminal smoke harnesses exercise upgraded library
  boundaries. CI runs both browser suites as well as Rust integration tests.

## Security and constrained transitive dependencies

`npm audit` (including development dependencies): **0 vulnerabilities**. A separate
read-only audit of the original lockfile reproduced all five affected packages:
DOMPurify (critical), source-map-js and Vite (high), Vitest and @vitest/mocker
(moderate). source-map-js is now 1.2.2 through PostCSS.

Exposure assessment of the old versions:

- Card descriptions are untrusted HTML sanitized by DOMPurify before rendering.
  This is a relevant security boundary. However, the reported critical advisories
  involve IN_PLACE/hook removal, special DOM/template modes, or XHTML parsing;
  `CardOverview.tsx` uses string-in/string-out sanitization without those options.
  This distinction does not justify retaining an affected sanitizer: it is updated.
- Vite editor/middleware/file-serving and Vitest mock-registration advisories
  affect developer/test servers, not the shipped static frontend. Several Vite
  advisories are Windows-specific; others are not. Untrusted network access to
  those servers is still a risk; upgrades resolve the reported findings.
- source-map-js indexed-map denial of service concerns build/development input;
  Stacks does not offer a production source-map upload endpoint. It is updated.

`cargo audit --file src-tauri/Cargo.lock`: **0 vulnerabilities**, with five
informational warnings across the all-platform lockfile (not suppressed):

| Package | Advisory | Scope / disposition |
| --- | --- | --- |
| proc-macro-error 1.0.4 | RUSTSEC-2024-0370, unmaintained | Linux GTK/glib-macros build dependency under Tauri |
| glib 0.18.5 | RUSTSEC-2024-0429, unsound VariantStrIter | Linux GTK/WebKit dependency; fixed in glib 0.20+, outside Tauri's supported GTK 0.18 graph |
| zbus_names 4.3.5 | RUSTSEC-2026-0371, unmaintained | Linux notification D-Bus graph |
| zvariant 5.15.1 | RUSTSEC-2026-0370, unmaintained | Linux notification D-Bus graph |
| zvariant_derive 5.15.1 | RUSTSEC-2026-0372, unmaintained | Linux notification D-Bus graph |

The D-Bus crates were merged into zbus 6 upstream; latest stable notification
plugins still use zbus 5. These warnings do not apply to the compiled macOS
notification/GUI graph, but remain relevant to future Linux support. Fixing them
requires upstream Tauri/plugin migration, not incompatible lockfile overrides.
Audit database commit: `ee1a49a2769a24a596afc1c20cb33748d2769586`.

`cargo update --verbose` leaves four packages below their latest same-series
patches because of upstream constraints:

- generic-array 0.14.7 (0.14.9 available): crypto-common 0.1.7 pins `=0.14.7`,
  through digest/sha2/Tauri codegen.
- toml 0.8.2, toml_datetime 0.6.3, toml_edit 0.20.2: Linux glib-macros uses
  proc-macro-crate 2.0.2, which pins toml_datetime `=0.6.3` and toml_edit `=0.20.2`.
  This also prevents toml 0.8.23, which needs toml_datetime 0.6.11.

Explicit upgrade attempts confirmed the resolver conflicts; no vendored patches,
audit ignores, dependency downgrades, or prerelease overrides were introduced.
`npm outdated --include=dev` reports no outdated direct dependencies.

## Validation and remaining acceptance gate

Passed locally on Apple Silicon macOS:

- `npm run check:version`, `npm run test` (160 files, 1,281 tests), `npm run build`.
- `cargo check --manifest-path src-tauri/Cargo.toml`.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 271 unit tests pass; the
  existing opt-in `profile_card_first_read` performance test remains ignored.
  SQLite persistence/migration/backup and workflow tests pass against the new
  bundled SQLite. The additional real PTY integration test passes too.
- `npm run test:chat-scroll`: Chromium and WebKit, 360 rendered Pi GUI bottom/
  timestamp checks plus reader pause/history anchoring. Pi RPC transport is mocked.
- `npm run test:terminal-dependencies`: real xterm and all four addons in Chromium
  and WebKit; Unicode rendering/search, focus, split resizing, retained buffers
  across DOM moves, independent panes, and disposal. No native PTY transport here.
- Real portable-pty spawn, UTF-8 input/output, `stty` resize observation, natural
  exit and explicit process kill in `src-tauri/tests/pty_dependencies.rs`.
- `npm run release:build`: ad-hoc-signed `Stacks.app`, `Stacks.app.tar.gz`, and
  `Stacks.app.tar.gz.sig` generated under `src-tauri/target/release/bundle/macos/`.
  `codesign --verify --deep --strict` and archive listing pass.
- `create-update-manifest.mjs` successfully generates the current-version manifest
  from those artifacts. Using minisign-verify 0.3.0 (the updater's own verifier),
  the archive signature verifies with the configured public key and a tampered
  archive is rejected. Authenticated trusted comment includes `version:0.5.92`.
  No artifact was uploaded and no release version was changed.

Expected warning: notarization skipped because Apple notarization credentials are
not configured; this matches the existing local/ad-hoc release process. Vitest
prints an optional worker-isolation performance suggestion, not a failure.

**Human/native smoke testing is still required before final acceptance.** The
running installed dogfood app and production profile have deliberately not been
replaced/restarted. Automated library/browser coverage is not equivalent to these
end-to-end checks:

- [ ] Install/launch the built app with approval; verify real shell startup,
  input/output, Unicode rendering, resize, focus, split/close/maximize, restart.
- [ ] Exercise a real Pi GUI RPC conversation and session resume.
- [ ] Create/edit/reopen disposable data to confirm native persistence/relaunch.
- [ ] Copy terminal text; paste it elsewhere; exercise native file dialogs and
  confirmation cancellation/countdowns.
- [ ] Grant notification permission; send a test; click a background completion
  notification and confirm it activates/routes to the correct card or workspace.
- [ ] Check for updates in the native app; verify the prompt/no-update/error flow.
  An actual download/install/relaunch requires a distinct newer signed release
  and controlled endpoint; the current-version local archive was not published.

Do not mark these native checks passed based only on the existing installed app,
which still contains the pre-upgrade dependencies.
