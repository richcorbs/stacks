# Pi composer resize regression

Run the browser suite with:

```sh
npx playwright install chromium webkit
npm run test:composer-resize
```

The suite mounts the production `PiGuiView` with only the Pi session transport
and Tauri IPC mocked. It spies on the real composer's inline `style` writes in
Chromium and WebKit.

## Card #348 reproduction

Every prompt change used to run `resizeComposerInput` from an effect. That
function collapsed the focused textarea with `height: auto` and then wrote
`height`, `maxHeight`, and `overflowY` before measuring `scrollHeight`. In
WKWebView, mutating a focused input's layout while an edit is being committed
can drop that character. The failure was rhythm-dependent and letter-agnostic.

The composer now:

- Measures required content height with an off-screen mirror textarea inside a
  closed shadow root, so the focused input is never collapsed for measurement.
- Writes `height`, `maxHeight`, and `overflowY` only when the settled value
  differs from the current inline value.
- Coalesces restyles into one animation frame, cancelled on unmount.
- Defers restyling during IME composition and reruns once composition ends.
- Calls `chatScroll.layout()` only when the composer height actually changed.
  Submit/collapse bottom-follow remains owned by the existing chat-scroll
  controller and `npm run test:chat-scroll`.

The regression contract is: typing inside a line that already fits performs
zero style writes. Growth, shrink, font-size changes, and post-composition
restyling still write exactly the new settled height.

Do not reintroduce a per-character effect that mutates a focused textarea's
layout. A green Playwright run does not replace the native check: type slowly
(one character every ~300 ms) in the card chat composer and the workspace Pi
pane to verify no character is lost and the caret does not jump.
