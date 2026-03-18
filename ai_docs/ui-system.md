# UI System

## Window Layout (`src/ui/window.zig`)

```
NSWindow
 └─ NSSplitView (horizontal)
     ├─ Sidebar (200px, fixed via width anchor)
     │   └─ NSScrollView
     │       └─ FlippedView (document view, top-down coords)
     │           ├─ ProjectRow (bold header, draggable)
     │           ├─ TerminalRow (DragRowView4, click to open)
     │           ├─ AddTerminalRow (+ button)
     │           └─ SeparatorLine (1px)
     └─ MainPanelView (custom NSView)
         └─ TermGridView2 instances (one per split pane leaf)
```

### App Delegate

Registered as `MyTermAppDelegate` (NSObject subclass). Handles:
- `applicationDidFinishLaunching:` — window creation
- `applicationWillTerminate:` — clean PTY shutdown
- `applicationShouldTerminateAfterLastWindowClosed:` → YES
- Menu bar actions: `openTerminal:`, `editTerminal:`, `deleteTerminal:`, `addTerminal:`, `increaseFontSize:`, `decreaseFontSize:`, `resetFontSize:`, `splitHorizontal:`, `splitVertical:`, `closePane:`, `nextPane:`, `prevPane:`

### Menu Bar

Created programmatically. Key menus:
- **File**: Close Pane (⌘W)
- **Edit**: Paste (⌘V), Select All (⌘A)
- **View**: Font size (⌘+/⌘-/⌘0), Split (⌘D/⇧⌘D), Pane nav (⌘]/⌘[)
- **Navigate**: Sidebar nav (⌘⇧]/⌘⇧[)

## Sidebar (`src/ui/sidebar.zig`)

### View Hierarchy
- Uses a `FlippedView` (custom NSView with `isFlipped` → YES) so y=0 is top
- All rows positioned with absolute frames (no Auto Layout within the scroll content)
- Sidebar root uses Auto Layout constraints to pin to parent

### Terminal Rows
Terminal rows use `DragRowView4` (custom NSView subclass) instead of NSButton to allow drag-and-drop. Contains an NSTextField label for the terminal name.

### Drag-and-Drop
Implemented via manual mouse tracking (not NSDragging protocol):

```
mouseDown  → record start position, identify dragged item
mouseDragged → if moved >5px, activate drag:
               - fade source row to 30% alpha
               - push resize↕ cursor
               - show blue indicator line at drop position
mouseUp    → if drag active: reorder data, save, rebuild sidebar
             if not: treat as click (open terminal)
```

Two drag modes:
- **Terminal drag**: reorder within same project (info index < PROJECT_IDX_OFFSET)
- **Project drag**: reorder projects (info index ≥ PROJECT_IDX_OFFSET = 10000)

### Active Project Highlighting
Three background levels:
- Default sidebar: `#171d26`
- Active project (contains selected terminal): `#1f2630`
- Selected terminal row: `#334050`

### Navigation
- `⌘⇧]` / `⌘⇧[` cycles through nav items (terminals + add-terminal buttons)
- `Enter` activates the selected nav item
- Nav items are tracked in `nav_items[]` array, rebuilt each `rebuildSidebar()`

### Context Menu
Right-click on terminal rows shows Edit (rename + change command) and Delete (with confirmation). Menu items use `setTag:` on `NSMenuItem` (which is an NSObject subclass and supports tags) to identify the target terminal.

### Rebuilding
`rebuildSidebar(app)` removes all subviews from the document view and recreates them from the current project store state. Called after any data mutation (add/delete/rename/reorder).
