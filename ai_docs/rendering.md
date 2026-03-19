# Terminal Rendering (`src/ui/term_text_view.zig`)

The largest file (~1558 lines). Handles grid drawing, keyboard input, mouse selection, split panes, scrollback, and clipboard.

## Layout

The main panel reserves 44px at the top for the header bar. `layoutActiveSession` computes `term_bounds` as the panel bounds minus the header height, then recursively lays out the split tree within that area.

## Drawing Pipeline

Each terminal pane is a custom `NSView` subclass (`TermGridView2`) with a `drawRect:` override:

```
drawRect:
  1. Get CGContext via [[NSGraphicsContext currentContext] CGContext]
  2. Fill background (default bg color)
  3. Clip to view bounds (prevents overflow into adjacent panes)
  4. For each visible row (including scrollback offset):
     a. Build NSMutableAttributedString for the full row
     b. Set per-character foreground color + font via addAttribute:value:range:
     c. Draw row background spans (colored bg cells)
     d. Create CTLine from attributed string
     e. Draw CTLine at (x=0, y=row*cell_height) using CTLineDraw
  5. Draw cursor (filled block for focused, outline for unfocused)
  6. Draw selection highlight (blue overlay)
  7. Draw focus border (1px blue inset)
```

## Cell Metrics

Cell width and height are measured empirically, not from font metrics:

```zig
// Create a 10-character test string "MMMMMMMMMM" as CTLine
// Measure total width via CTLineGetTypographicBounds
// cell_width = total_width / 10
// cell_height = ascent + descent + leading
```

This avoids mismatches between `maximumAdvancement` and actual CTLine rendering.

## Per-Row CTLine Approach

Individual character drawing caused spacing issues with monospace fonts. Instead:
- Build one `NSMutableAttributedString` per row
- Add `NSForegroundColorAttributeName` per character range
- Bold/italic get different `NSFont` variants
- Create `CTLine` and draw once per row

## Split Panes

Binary tree of `SplitNode`:

```
SplitNode = union(enum) {
    leaf: LeafData { vt, pty, scroll_offset, ... }
    split: SplitData { dir, ratio, left: *SplitNode, right: *SplitNode }
}
```

Layout is computed recursively in `layoutNode()`:
- Leaf nodes position a `TermGridView2` at the computed rect (with inset for border)
- Split nodes divide the rect by ratio along the split direction
- A 4px gap between panes allows for divider dragging

### Auto-Rebalancing
After each split or close, `rebalanceAxis(direction)` walks the tree and adjusts ratios so all leaves along the split axis get equal space. For example, 3 horizontal panes → 33/33/33 instead of 50/25/25. Uses `countLeavesAlongAxis()` to count leaves visible along a given direction, then sets `ratio = left_count / total_count`.

### Pane Borders
- Focused pane: 1px blue border (`#4a90d9`)
- Non-focused panes: 0.5px subtle dark border (`#333d4d`)

### Keyboard Shortcuts
- `⌘D` — split horizontal
- `⇧⌘D` — split vertical  
- `⌘W` — close focused pane (with confirmation dialog)
- `⌘]` / `⌘[` — cycle focus between panes

### Divider Dragging
Handled at the `MainPanelView` level (parent of all terminal views) because the gap between panes can't receive events from child views. `MainPanelView` has `mouseDown`/`mouseDragged`/`mouseUp` that detect hits on divider zones and adjust split ratios.

## Mouse Selection

- `mouseDown` starts selection (converts pixel → row/col)
- `mouseDragged` extends selection
- `mouseUp` copies selected text to clipboard (`NSPasteboard`)
- Toast notification "Copied to clipboard" shown for 1.5s

## Keyboard Input

`keyDown:` on `TermGridView2`:
1. Check for modifier keys (⌘ shortcuts handled by menu bar)
2. Extract UTF-8 characters from `[event characters]`
3. Map special keys (arrows, backspace, tab, etc.) to vterm key codes
4. Write to PTY via `vterm_keyboard_unichar` or `vterm_keyboard_key`

## Scrollback

- Scroll wheel events adjust `scroll_offset` on the focused pane
- Positive offset = scrolled up into history
- Rendering reads from scrollback buffer for rows above the visible grid
- Respects macOS natural scrolling preference

## Font Sizing

Global font size (⌘+/⌘-/⌘0) triggers:
1. Update font size variable
2. Recalculate cell metrics
3. Resize all VTerm/PTY instances to new cols/rows
4. `setNeedsDisplay:YES` on all terminal views
