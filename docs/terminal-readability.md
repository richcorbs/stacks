# Focused shell readability (#270)

Shell xterm sessions use foreground `#f0f4fc` and minimum contrast ratio `7` while active. Inactive sessions retain foreground `#d6deeb`, contrast `1`, and the existing `.76` pane opacity. CSS and Pi chat are unchanged.

Contrast adjustment is preferable to overriding ANSI palette entries: it covers ANSI, 256-color, and explicit RGB foregrounds without changing application background colors. xterm uses half the contrast target for dim cells, preserving their distinction. Already-readable colors need no adjustment; background-like glyphs may be exempted by xterm. This is not a blanket color-to-white conversion or a pane brightness filter.

`useTerminalOptions` updates mounted sessions on focus changes. Session attachment also applies the latest focus state, covering cached remounts, restarts, and async runtime loading without changing session ownership or focus routing.

## Validation

- Configuration tests cover unchanged inactive styling, text-only active changes, and reversible/idempotent option updates.
- Hook tests cover focus changes without PTY calls/resizing/output loss, cached attachment/visibility changes, and focus changes during lazy runtime loading.
- A temporary Chromium fixture using the real xterm DOM renderer was visually inspected with all 16 ANSI colors, dim default/red, muted RGB blue/red, a dark 256-color green, and ANSI/RGB backgrounds. Computed foreground/background colors matched the opposite terminal after switching active/inactive options, confirming restoration. Background colors stayed unchanged; dim output remained distinct.
- Native Tauri interaction checks below remain manual; the browser fixture does not exercise native PTYs or the complete app.

## Native-app check

Run this in each of two shell splits:

```bash
python3 - <<'PY'
print('Plain default text')
for i in range(16):
    code = 30 + i if i < 8 else 90 + i - 8
    print(f'\033[{code}mANSI {i}: sample text\033[0m')
print('\033[2mDim default\033[0m  \033[2;31mDim red\033[0m')
print('\033[38;2;96;96;160mRGB muted blue\033[0m')
print('\033[38;2;150;50;65mRGB muted red\033[0m')
print('\033[38;5;28m256-color dark green\033[0m')
print('\033[41mANSI red background\033[0m')
print('\033[48;2;80;40;90mRGB purple background\033[0m')
PY
```

Compare mouse focus and `Cmd+[` / `Cmd+]`; split both directions; maximize/restore; switch away and back to exercise cached sessions. Verify text follows focus, existing output and shell processes survive, and backgrounds, selections, borders, controls, and Pi chat look unchanged. Final brightness preference should be confirmed on the target display.
