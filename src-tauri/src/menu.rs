use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle,
};

fn shortcuts_menu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let items = [
        (
            "menu-shortcut-toggle-global-terminal",
            "Toggle Top-level Terminal",
            "Cmd+T",
            Some("Cmd+T"),
        ),
        (
            "menu-shortcut-new-global-terminal-tab",
            "New Top-level Terminal Tab",
            "Cmd+Shift+T",
            Some("Cmd+Shift+T"),
        ),
        (
            "menu-shortcut-add-project",
            "Add Project",
            "Cmd+O",
            Some("Cmd+O"),
        ),
        (
            "menu-shortcut-switch-project",
            "Switch Project",
            "Cmd+Shift+P",
            Some("Cmd+Shift+P"),
        ),
        ("menu-shortcut-settings", "Settings", "Cmd+,", Some("Cmd+,")),
        (
            "menu-shortcut-split-terminal-right",
            "Split Terminal Right",
            "Cmd+D",
            Some("Cmd+D"),
        ),
        (
            "menu-shortcut-split-terminal-down",
            "Split Terminal Down",
            "Cmd+Shift+D",
            Some("Cmd+Shift+D"),
        ),
        (
            "menu-shortcut-close-terminal",
            "Close Focused Terminal",
            "Cmd+W",
            Some("Cmd+W"),
        ),
        (
            "menu-shortcut-clear-terminal",
            "Clear Focused Terminal",
            "Cmd+K",
            Some("Cmd+K"),
        ),
        (
            "menu-shortcut-search-terminal",
            "Search Focused Terminal",
            "Cmd+F",
            Some("Cmd+F"),
        ),
        (
            "menu-shortcut-command-palette",
            "Command Palette",
            "Cmd+P",
            Some("Cmd+P"),
        ),
        (
            "menu-shortcut-increase-terminal-font-size",
            "Increase Terminal Font Size",
            "Cmd+Plus",
            Some("Cmd+Plus"),
        ),
        (
            "menu-shortcut-decrease-terminal-font-size",
            "Decrease Terminal Font Size",
            "Cmd+-",
            Some("Cmd+-"),
        ),
        (
            "menu-shortcut-increase-ui-font-size",
            "Increase Interface Font Size",
            "Cmd+Alt+Plus",
            Some("Cmd+Alt+Plus"),
        ),
        (
            "menu-shortcut-decrease-ui-font-size",
            "Decrease Interface Font Size",
            "Cmd+Alt+-",
            Some("Cmd+Alt+-"),
        ),
        (
            "menu-shortcut-maximize-pane",
            "Maximize / Restore Pane",
            "Cmd+Shift+Enter",
            Some("Cmd+Shift+Enter"),
        ),
        (
            "menu-shortcut-global-terminal-tabs",
            "Navigate Top-level Terminal Tabs",
            "Cmd+1 … Cmd+9 / Cmd+[ / Cmd+]",
            None,
        ),
        (
            "menu-shortcut-card-tabs",
            "Navigate Card Tabs",
            "Cmd+1 … Cmd+5 / Cmd+[ / Cmd+]",
            None,
        ),
        (
            "menu-shortcut-drag-image",
            "Drag Image onto Terminal",
            "Insert image path",
            None,
        ),
        (
            "menu-shortcut-select-text",
            "Select Terminal Text",
            "Copy to clipboard",
            None,
        ),
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

    let refs = menu_items
        .iter()
        .map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect::<Vec<_>>();
    Submenu::with_items(app, "Shortcuts", true, &refs)
}

pub fn app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let shortcuts = shortcuts_menu(app)?;
    let menu = Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                "Stacks",
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &MenuItem::with_id(
                        app,
                        "check-for-updates",
                        "Check for Updates…",
                        true,
                        None::<&str>,
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(
                        app,
                        "reset-settings",
                        "Reset Window Settings",
                        true,
                        None::<&str>,
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(
                        app,
                        "menu-shortcut-quit",
                        "Quit Stacks",
                        true,
                        Some("Cmd+Q"),
                    )?,
                ],
            )?,
            &shortcuts,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
        ],
    )?;
    Ok(menu)
}
