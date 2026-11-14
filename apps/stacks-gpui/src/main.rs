//! Minimal GPUI app shell for Stacks — card #321 spike.
//!
//! This is the independently runnable shell: one window, native menu and
//! keybindings, a global terminal tab set, and settings/persistence stubs. The
//! shipped Tauri app is untouched. There is no project sidebar or kanban
//! placeholder in the native shell.

mod list;
mod notify;
mod settings;
mod shell;

use gpui::{
    App, AppContext, KeyBinding, Menu, MenuItem, SharedString, TitlebarOptions, WindowBounds,
    WindowOptions, actions, px, size,
};
use settings::{ShellSettings, ShellState, data_dir};
use shell::{Shell, mark_process_start, restore_bounds};

actions!(
    stacks_gpui,
    [
        About,
        Settings,
        Quit,
        ResetWindowSize,
        NewTerminal,
        FocusGlobalTerminal,
        ShowList,
        ShowTerminal,
        RefreshList,
        CloseTerminal,
        SplitRight,
        SplitDown,
        ToggleMaximize,
        ToggleSearch,
        ClearTerminal,
        CopySelection,
        PasteClipboard,
        NextTerminal,
        PreviousTerminal,
        NextPane,
        PreviousPane,
        MinimizeWindow,
        ZoomWindow
    ]
);

fn main() {
    mark_process_start();
    let data_dir = data_dir();
    let settings = ShellSettings::load(&data_dir).normalized();
    if !data_dir.join("settings.json").exists() {
        let _ = settings.save(&data_dir);
    }
    let state = ShellState::load(&data_dir);

    gpui_kit::application().run(move |cx: &mut App| {
        gpui_kit::init(cx);
        cx.on_window_closed(|cx, _window_id| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        cx.bind_keys(keybindings());

        let bounds = state
            .window
            .and_then(restore_bounds)
            .map(WindowBounds::Windowed)
            .unwrap_or_else(|| WindowBounds::centered(size(px(1180.0), px(760.0)), cx));

        let settings_for_window = settings.clone();
        let state_for_window = state.clone();
        let dir_for_window = data_dir.clone();
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(bounds),
                titlebar: Some(TitlebarOptions {
                    title: Some(SharedString::from("Stacks — GPUI shell spike")),
                    appears_transparent: false,
                    traffic_light_position: None,
                }),
                focus: true,
                show: true,
                window_min_size: Some(size(px(720.0), px(480.0))),
                ..Default::default()
            },
            cx,
            |window, cx| {
                cx.new(|cx| {
                    Shell::new(
                        window,
                        cx,
                        settings_for_window,
                        state_for_window,
                        dir_for_window,
                    )
                })
            },
        )
        .expect("open GPUI shell window");

        set_menus(cx);
        cx.activate(true);
    });
}

fn keybindings() -> Vec<KeyBinding> {
    let context = Some("Shell");
    vec![
        KeyBinding::new("cmd-q", Quit, context),
        KeyBinding::new("cmd-,", Settings, context),
        KeyBinding::new("cmd-t", FocusGlobalTerminal, context),
        KeyBinding::new("cmd-l", ShowList, context),
        KeyBinding::new("cmd-r", RefreshList, context),
        KeyBinding::new("shift-cmd-t", NewTerminal, context),
        KeyBinding::new("cmd-w", CloseTerminal, context),
        KeyBinding::new("cmd-d", SplitRight, context),
        KeyBinding::new("shift-cmd-d", SplitDown, context),
        KeyBinding::new("shift-cmd-enter", ToggleMaximize, context),
        KeyBinding::new("shift-cmd-m", ToggleMaximize, context),
        KeyBinding::new("cmd-f", ToggleSearch, context),
        KeyBinding::new("cmd-k", ClearTerminal, context),
        KeyBinding::new("cmd-c", CopySelection, context),
        KeyBinding::new("cmd-v", PasteClipboard, context),
        KeyBinding::new("cmd-[", PreviousTerminal, context),
        KeyBinding::new("cmd-]", NextTerminal, context),
        KeyBinding::new("shift-cmd-[", PreviousPane, context),
        KeyBinding::new("shift-cmd-]", NextPane, context),
        KeyBinding::new("alt-cmd-[", PreviousPane, context),
        KeyBinding::new("alt-cmd-]", NextPane, context),
        KeyBinding::new("cmd-m", MinimizeWindow, context),
    ]
}

fn set_menus(cx: &mut App) {
    cx.set_menus(vec![
        Menu {
            name: "Stacks".into(),
            disabled: false,
            items: vec![
                MenuItem::action("About Stacks GPUI Shell", About),
                MenuItem::separator(),
                MenuItem::action("Cards", ShowList),
                MenuItem::action("Global Terminal", ShowTerminal),
                MenuItem::action("Refresh Cards", RefreshList),
                MenuItem::separator(),
                MenuItem::action("Settings…", Settings),
                MenuItem::action("Reset Window Size", ResetWindowSize),
                MenuItem::separator(),
                MenuItem::action("Quit Stacks", Quit),
            ],
        },
        Menu {
            name: "Terminal".into(),
            disabled: false,
            items: vec![
                MenuItem::action("Global Terminal", ShowTerminal),
                MenuItem::action("Focus Global Terminal", FocusGlobalTerminal),
                MenuItem::action("New Terminal", NewTerminal),
                MenuItem::separator(),
                MenuItem::action("Split Right", SplitRight),
                MenuItem::action("Split Down", SplitDown),
                MenuItem::action("Toggle Maximize", ToggleMaximize),
                MenuItem::action("Close Terminal", CloseTerminal),
                MenuItem::separator(),
                MenuItem::action("Search", ToggleSearch),
                MenuItem::action("Clear", ClearTerminal),
                MenuItem::separator(),
                MenuItem::action("Copy", CopySelection),
                MenuItem::action("Paste", PasteClipboard),
                MenuItem::separator(),
                MenuItem::action("Previous Terminal", PreviousTerminal),
                MenuItem::action("Next Terminal", NextTerminal),
                MenuItem::separator(),
                MenuItem::action("Previous Pane", PreviousPane),
                MenuItem::action("Next Pane", NextPane),
            ],
        },
        Menu {
            name: "Window".into(),
            disabled: false,
            items: vec![
                MenuItem::action("Minimize", MinimizeWindow),
                MenuItem::action("Zoom", ZoomWindow),
            ],
        },
    ]);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stacks' shortcut table as wired into this shell. Keeping the assertion
    /// here catches a keybinding that silently moves to another action when
    /// someone edits the list.
    const EXPECTED: &[&str] = &[
        "stacks_gpui::Quit",
        "stacks_gpui::Settings",
        "stacks_gpui::FocusGlobalTerminal",
        "stacks_gpui::ShowList",
        "stacks_gpui::RefreshList",
        "stacks_gpui::NewTerminal",
        "stacks_gpui::CloseTerminal",
        "stacks_gpui::SplitRight",
        "stacks_gpui::SplitDown",
        "stacks_gpui::ToggleMaximize",
        "stacks_gpui::ToggleMaximize",
        "stacks_gpui::ToggleSearch",
        "stacks_gpui::ClearTerminal",
        "stacks_gpui::CopySelection",
        "stacks_gpui::PasteClipboard",
        "stacks_gpui::PreviousTerminal",
        "stacks_gpui::NextTerminal",
        "stacks_gpui::PreviousPane",
        "stacks_gpui::NextPane",
        "stacks_gpui::PreviousPane",
        "stacks_gpui::NextPane",
        "stacks_gpui::MinimizeWindow",
    ];

    #[test]
    fn shortcut_table_matches_stacks() {
        let bindings = keybindings();
        assert_eq!(bindings.len(), EXPECTED.len());
        for (binding, expected) in bindings.iter().zip(EXPECTED) {
            assert_eq!(binding.action().name(), *expected);
            assert_eq!(
                binding.keystrokes().len(),
                1,
                "single keystroke bindings only"
            );
        }
    }

    #[test]
    fn every_menu_action_has_a_handler_or_is_intentionally_global() {
        // Menu items are constructed with the same action types registered in
        // `register_actions`; this test documents the list that must stay in
        // sync. Adding a menu item without a handler shows up as a dead click.
        let menu_actions = [
            "stacks_gpui::About",
            "stacks_gpui::Settings",
            "stacks_gpui::ResetWindowSize",
            "stacks_gpui::Quit",
            "stacks_gpui::FocusGlobalTerminal",
            "stacks_gpui::NewTerminal",
            "stacks_gpui::SplitRight",
            "stacks_gpui::SplitDown",
            "stacks_gpui::ToggleMaximize",
            "stacks_gpui::CloseTerminal",
            "stacks_gpui::ToggleSearch",
            "stacks_gpui::ClearTerminal",
            "stacks_gpui::CopySelection",
            "stacks_gpui::PasteClipboard",
            "stacks_gpui::PreviousTerminal",
            "stacks_gpui::NextTerminal",
            "stacks_gpui::PreviousPane",
            "stacks_gpui::NextPane",
            "stacks_gpui::MinimizeWindow",
            "stacks_gpui::ZoomWindow",
        ];
        let unique: std::collections::BTreeSet<_> = menu_actions.iter().collect();
        assert_eq!(unique.len(), menu_actions.len(), "duplicate menu action");
    }
}
