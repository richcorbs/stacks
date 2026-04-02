# Unicode Fix Plan

## Problem

~27% of Stacks commits have been fighting libvterm and rendering issues.
The core problems are:

1. **libvterm's unicode width tables are from 2007 (Unicode 5.0)** — they don't
   know about modern emoji, newer CJK blocks, or variation selectors (VS15/VS16).
   This causes incorrect cell widths, breaking grid alignment.

2. **Stacks only reads 2 of 6 available codepoints per cell** — grapheme clusters
   like flag emoji (2 regional indicators), family emoji (4+ codepoints with ZWJ),
   and characters with combining marks are truncated.

3. **The C-to-Zig boundary is fragile** — `cImport` can't handle libvterm's
   bitfields, requiring a manually defined `RawScreenCell` struct.

## What Won't Help

- **Writing a custom VT parser** — the parser (escape sequence handling) isn't the
  problem. libvterm's parser is fine. The issues are unicode width calculation and
  cell data extraction.

- **Forking Ghostty** — 270K lines of code to maintain for a problem solvable with
  targeted fixes. Ghostty's `libghostty-vt` library also doesn't expose cell-level
  access yet, so it can't replace libvterm today.

## Plan

### Step 1: Replace libvterm's unicode width tables

**File:** `vendor/libvterm/src/unicode.c`

libvterm's `mk_wcwidth()` and combining character tables are from 2007. Replace
them with modern Unicode 15+ data. Ghostty's `src/unicode/` has current tables
we can reference, or we can generate from Unicode's EastAsianWidth.txt.

This is the single highest-value change — correct widths mean emoji, CJK, and
symbols align properly in the grid without workarounds.

### Step 2: Read all 6 codepoints from cells

**Files:** `src/vt.zig`, `src/ui/term_text_view.zig`

Change `Cell.chars` from `[2]u32` to `[6]u32` (matching `VTERM_MAX_CHARS_PER_CELL`).
Update `getCell()` to copy all 6 codepoints. Update the rendering code to encode
all codepoints when drawing characters.

This lets combining marks, variation selectors, and ZWJ sequences survive into
the renderer.

### Step 3: Verify rendering

The two-pass rendering approach (CTLine for ASCII rows, individual drawing for
wide/symbol chars) is correct. After steps 1-2, verify that:

- Emoji render at correct double-width positions
- Flag emoji (🇺🇸) and ZWJ sequences (👨‍👩‍👧) display correctly
- CJK characters align to the grid
- Combining marks (é as e + ◌́) render properly
- Variation selectors (text vs emoji presentation) are respected

## Context

Analysis done by comparing Ghostty (`~/Code/ghostty`) and Stacks codebases.
See conversation history for full details including:
- Ghostty's `libghostty-vt` C API (not yet ready — no cell access)
- libvterm's 5,871 lines of C (parser is solid, unicode is outdated)
- Stacks' `drawWideChars` workaround pattern
