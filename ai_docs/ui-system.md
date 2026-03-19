# UI System

## Window Layout (`src/ui/window.zig`)

```
NSWindow (transparent title bar, dark bg #171d26)
 └─ ThinSplitView (1px divider, horizontal)
     ├─ Sidebar (200px, fixed via width anchor)
     │   ├─ Header: "PROJECTS" + "+" button (44px)
     │   └─ NSScrollView
     │       └─ FlippedView (document view, top-down coords)
     │           ├─ ProjectRow (bold header, draggable)
     │           ├─ TerminalRow (DragRowView4, click to open)
     │           ├─ AddTerminalRow (+ button)
     │           └─ SeparatorLine (1px)
     └─ MainPanelView (custom NSView, dark bg #0f141b)
         ├─ Header Bar (44px, pinned to top)
         │   ├─ Terminal name label (left, bold #d8efe7)
         │   └─ Git info label (right, sizeToFit + pin right edge)
         └─ Terminal area (below header)
             └─ TermGridView2 instances (one per split pane leaf)
```

### Window Chrome
- Title bar is transparent (`setTitlebarAppearsTransparent: YES`, `setTitleVisibility: 1`)
- Window background color matches sidebar (`#171d26`)
- NSSplitView uses `ThinSplitView` subclass that overrides `dividerThickness` → 1px

### Header Bar
Located at the top of the main panel (44px, matches sidebar header height). Contains:
- **Left**: Terminal name (bold, 12pt, `#d8efe7`)
- **Right**: Git branch + change count, auto-sized via `sizeToFit` then pinned to right edge

Git info format: `<branch>  •  <N> changed`
- Orange (`0.85, 0.55, 0.35`) when changes exist
- Gray (`#9aa8bc`) when clean or no changes

Git status is fetched by running `git branch --show-current` and `git status --porcelain` via `std.process.Child`.

### App Delegate

Registered as `MyTermAppDelegate` (NSObject subclass). Key actions:
- `applicationDidFinishLaunching:` — window creation
- `applicationWillTerminate:` — clean PTY shutdown
- Split actions: `splitHorizontal:`, `splitVertical:`, `closePane:`, `focusNextPane:`, `focusPrevPane:`
- Font: `increaseFontSize:`, `decreaseFontSize:`
- Sidebar: `sidebarNext:`, `sidebarPrev:`, `sidebarActivate:`, `newTerminal:`
- Terminal CRUD: `openTerminal:`, `editTerminal:`, `deleteTerminal:`, `addTerminalToProject:`, `addProject:`

### Menu Bar

Created programmatically with two menus:
- **App menu**: Quit (⌘Q)
- **Shell menu**: Split (⌘D/⇧⌘D), Close (⌘W), Pane nav (⌘]/⌘[), Font (⌘+/⌘-), Sidebar nav (⌘⇧]/⌘⇧[), New Terminal (⌘T), Add Project (⌘O)

## Sidebar (`src/ui/sidebar.zig`)

### Terminal Rows
Terminal rows use `DragRowView4` (custom NSView subclass with `_infoIdx` ivar) containing an NSTextField label. This allows the wrapper to receive mouse events for drag-and-drop.

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

### Navigation vs Activation
Sidebar navigation (⌘⇧[/]) and terminal activation are separate:
- **Navigation** (`navigateSidebar`): moves `selected_nav_index` and shows a blue 1px border on the highlighted item. Does NOT switch the active terminal.
- **Activation** (`activateSelectedSidebarItem`): triggered by ⌘Enter. Opens the terminal or shows the add-terminal dialog for the highlighted item.

### Active Project Highlighting
Three background levels:
- Default sidebar: `#171d26`
- Active project (contains selected terminal): `#263040`
- Selected terminal row: `#404f61`
- Nav-highlighted item (not yet activated): blue 1px border + `#263040` bg

### New Terminal (⌘T)
`showNewTerminalForCurrentProject()` finds the project containing the currently selected terminal (or falls back to the first project) and opens the add-terminal dialog pre-populated with "Terminal" as the name.

### Context Menu
Right-click on terminal rows shows Edit (rename + change command) and Delete (with confirmation). The `DragRowView4` wrapper forwards right-clicks via `rightMouseDown:` to `NSMenu popUpContextMenu:withEvent:forView:`.

### Rebuilding
`rebuildSidebar(app)` removes all subviews from the document view and recreates them from the current project store state. Called after any data mutation (add/delete/rename/reorder).
