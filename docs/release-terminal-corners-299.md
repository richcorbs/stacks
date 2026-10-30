# RELEASE output bottom corners (#299)

## Diagnosis and fix

The RELEASE terminal is flush with the bottom of `.kanbanDetail.cardWorkspace`.
That ancestor has `overflow: hidden`, a 12px radius, and a 1px border. The shared
terminal has square corners. The ancestor clips the terminal's vertical border
before it joins its bottom border. Its outward focus shadow is clipped too.
Global `box-sizing: border-box` is already present; this was not a content-box
sizing problem.

Give only `.releaseTerminal > .terminal` 11px bottom radii, matching the dialog's
inner corners. Keep the top corners square. Do not change overflow, border width,
focus/inactive colors, shadow, flex sizing, or terminal host padding. This follows
the existing rounded workspace geometry rather than introducing general terminal
rounding. If the dialog radius or border width changes, update this inner radius.

## Browser regression and manual inspection

```sh
npx playwright install chromium webkit # first run only
npm run test:release-terminal
# Optional screenshots:
RELEASE_TERMINAL_SCREENSHOTS=/tmp/stacks-299 npm run test:release-terminal
```

The fixture mounts the real `ReleaseTab`, `TerminalView`, session factory, and app
styles. A cached session receives harmless sustained xterm output; native setup,
latest-version lookup, and resize calls are stubbed. Unexpected native commands
fail. No shell, PTY, release script, publication, or repository mutation is used.

The test checks painted pixel connectivity at both bottom corners in Chromium
and WebKit. A negative control restores the original square corners and verifies
that both corners disconnect. Removing that override reconnects them without
changing the host bounds. It also checks mouse-wheel scrollback during output,
resizing, switching tabs, and the app's inactive/active color classes. Terminal
host padding remains `6px 0 4px 6px`.

For interactive inspection, run `npm run dev` and open
`/tests/release-terminal.html`. Use the fixture's RELEASE/Other tab buttons,
resize the browser, and scroll the output. Do not use the disabled release
controls to try to run a release.

## Validation completed

- Browser regression: Chromium and WebKit, including the failing negative control.
- Inspected WebKit screenshots at resized, active, and inactive states.
- `npm run test`: 163 files, 1,260 tests passed.
- `npm run build`: passed.
- `cargo check` from `src-tauri` with Rust environment loaded: passed.
- `npm run test:terminal-dependencies` and `npm run test:terminal-reflow`: passed
  in Chromium and WebKit (ordinary terminal rendering, sizing, scrolling/reflow,
  Unicode, focus, and cached remount coverage). Shared terminal CSS is unchanged.

## Remaining confirmation

No real release was run. Confirm during the next actual release in the native
app, including OS window focus changes. The browser fixture exercises the app's
inactive class, not native focus event delivery, and cannot establish that an
unseen user screenshot had no additional cause.
