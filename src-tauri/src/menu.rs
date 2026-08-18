use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle,
};

fn shortcuts_menu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let items = [
        ("menu-shortcut-add-project", "Add Project", "Cmd+O", Some("Cmd+O")),
        ("menu-shortcut-new-workspace", "New Workspace", "Cmd+N", Some("Cmd+N")),
        ("menu-shortcut-settings", "Settings", "Cmd+,", Some("Cmd+,")),
        ("menu-shortcut-toggle-sidebar", "Toggle Sidebar", "Cmd+B", Some("Cmd+B")),
        ("menu-shortcut-toggle-superthread", "Toggle Superthread", "Cmd+R", Some("Cmd+R")),
        ("menu-shortcut-split-terminal-right", "Split Terminal Right", "Cmd+D", Some("Cmd+D")),
        ("menu-shortcut-split-terminal-down", "Split Terminal Down", "Cmd+Shift+D", Some("Cmd+Shift+D")),
        ("menu-shortcut-close-terminal", "Close Focused Terminal", "Cmd+W", Some("Cmd+W")),
        ("menu-shortcut-clear-terminal", "Clear Focused Terminal", "Cmd+K", Some("Cmd+K")),
        ("menu-shortcut-search-terminal", "Search Focused Terminal", "Cmd+F", Some("Cmd+F")),
        ("menu-shortcut-command-palette", "Command Palette", "Cmd+P", Some("Cmd+P")),
        ("menu-shortcut-increase-terminal-font-size", "Increase Terminal Font Size", "Cmd+Plus", Some("Cmd+Plus")),
        ("menu-shortcut-decrease-terminal-font-size", "Decrease Terminal Font Size", "Cmd+-", Some("Cmd+-")),
        ("menu-shortcut-maximize-workspace", "Maximize / Restore Workspace", "Cmd+Shift+Enter", Some("Cmd+Shift+Enter")),
        ("menu-shortcut-focus-next-terminal", "Focus Next Terminal", "Cmd+]", Some("Cmd+]")),
        ("menu-shortcut-focus-previous-terminal", "Focus Previous Terminal", "Cmd+[", Some("Cmd+[")),
        ("menu-shortcut-focus-next-workspace", "Focus Next Workspace", "Cmd+Shift+]", Some("Cmd+Shift+]")),
        ("menu-shortcut-focus-previous-workspace", "Focus Previous Workspace", "Cmd+Shift+[", Some("Cmd+Shift+[")),
        ("menu-shortcut-activate-sidebar", "Activate Sidebar Selection", "Cmd+Enter", Some("Cmd+Enter")),
        ("menu-shortcut-select-workspace", "Select Workspace 1-9", "Cmd+1 … Cmd+9", None),
        ("menu-shortcut-drag-image", "Drag Image onto Terminal", "Insert image path", None),
        ("menu-shortcut-select-text", "Select Terminal Text", "Copy to clipboard", None),
    ];

    let menu_items = items
        .iter()
        .map(|(id, name, hint, accelerator)| {
            if let Some(accelerator) = accelerator {
                MenuItem::with_id(app, *id, *name, true, Some(*accelerator))
            } else {
                MenuItem::with_id(app, *id, format!("{} ({})", name, hint), true, None::<&str>)
            }
        })
        .collect::<tauri::Result<Vec<_>>>()?;

    let refs = menu_items.iter().map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect::<Vec<_>>();
    Submenu::with_items(app, "Shortcuts", true, &refs)
}

pub fn app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let shortcuts = shortcuts_menu(app)?;
    let menu = Menu::with_items(app, &[
        #[cfg(target_os = "macos")]
        &Submenu::with_items(app, "Stacks", true, &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "reset-settings", "Reset Window Settings", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ])?,
        &shortcuts,
        &Submenu::with_items(app, "Window", true, &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ])?,
    ])?;
    Ok(menu)
}
