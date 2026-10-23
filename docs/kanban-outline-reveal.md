# Keyboard card outline reveal (#278)

The keyboard-focused card uses `scroll-margin: 3px` to include its 2px outline plus 1px offset in nearest-edge `scrollIntoView`. This applies to the actual reveal target in both views, not the open button or drag wrapper. Existing list/lane padding provides enough scroll range at boundaries; no spacing or focus-style changes are needed.

The keyboard-only animation-frame request, focus-before-reveal ordering, cancellation guards, and no-replay behavior in `useBoardKeyboardNavigation` are unchanged. Its existing tests cover those behaviors; CSS alone does not introduce any new reveal triggers.

## Layout regression fixture

From the repository root:

```sh
python3 -m http.server 8278
open http://localhost:8278/tests/kanban-outline-reveal.html
```

The self-running fixture loads production CSS and reproduces the list and nested board scroll-container hierarchy. Four PASS lines should appear. It checks:

- Every card downward/upward, first/last cards, and horizontal lane transitions.
- Complete outline visibility in all clipping scroll containers.
- No scrolling when already visible, and minimal movement when only the outline is clipped (allowing pixel rounding).
- Top/bottom edges and board left/right edges.
- Normal size and a smaller viewport with interface text enlarged by 6px.
- Stable nearest-edge behavior when an oversized card spans both viewport edges.

Automation can read `window.layoutTestResult` (`{ passed, results }`) after page load. No browser-testing dependency is required by the application. This fixture tests native browser layout, not React keyboard dispatch; the hook tests cover dispatch and reveal lifecycle.

Validated with Playwright WebKit and Chromium; both pass all four configurations. Removing the scroll margin reproduces a clipped-outline failure in both engines. The WebKit screenshot was also visually inspected. `npm run test` (1,169 tests), `npm run build`, and `cargo check` passed.

## Native Stacks smoke check (still required)

The fixture is not the running Tauri app. In Stacks/WebKit, navigate long lists and overflowing board lanes with arrows and Vim keys, checking partially hidden cards, first/last cards, and lane transitions. Repeat in a small window with enlarged interface text and an oversized card. Confirm pointer selection, manual scrolling, background updates, and opening/closing overlays do not snap back or replay a reveal. Preserve the existing outward outline appearance.
