//! Minimal GPUI app shell for the card #321 migration spike.
//!
//! Scope: window chrome, native menu/keybindings, one global terminal tab set
//! with split panes, focus handling, IME input handling, file drop,
//! notifications, and settings/persistence stubs. There is deliberately no
//! project sidebar or kanban placeholder: that layout predates the product
//! pivot and is not part of the native shell.
//! It deliberately does not port kanban, card detail, Pi chat, DIFF, GitHub or
//! Superthread.

use std::{
    ops::Range,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, Instant},
};

use ghostty_vt::key::Action as KeyAction;
use gpui::{
    AnyElement, App, Bounds, ClipboardItem, Context, CursorStyle as GpuiCursorStyle,
    ElementInputHandler, EntityInputHandler, ExternalPaths, FocusHandle, IntoElement, KeyDownEvent,
    KeyUpEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels,
    Point, Render, ScrollDelta, ScrollEvent, Styled, Subscription, Task, UTF16Selection, Window,
    canvas, div, point, prelude::*, px, relative, rgb, size,
};
use stacks_terminal::{
    keymap::{ghostty_key, ghostty_mods, is_text_input_key},
    pty::{Pty, PtyEvent},
    split_tree::{SplitDirection, SplitNode},
    terminal_model::{MouseAction, MouseButton as TermMouseButton, SearchInfo, TerminalModel},
    terminal_surface::{
        FONT_FAMILY, PADDING, PreparedFrame, TerminalMetrics, prepare_frame_with_style,
    },
};

use crate::{
    list::ListView,
    notify,
    settings::{PersistedTab, PersistedWindow, ShellSettings, ShellState},
};

const TAB_BAR_HEIGHT: f32 = 38.0;
const TOP_BAR_HEIGHT: f32 = 36.0;
const TOAST_DURATION: Duration = Duration::from_millis(1400);
const DEFAULT_WINDOW_SIZE: (f32, f32) = (1180.0, 760.0);
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "svg", "avif",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Surface {
    List,
    Terminal,
}

#[cfg_attr(test, allow(dead_code))]
struct Pane {
    id: String,
    title: String,
    model: TerminalModel,
    pty: Option<Pty>,
    generation: Option<String>,
    exit: Option<Option<i32>>,
    _task: Option<Task<()>>,
    metrics: TerminalMetrics,
    selection_anchor: Option<(u16, u16)>,
    selecting: bool,
    search_open: bool,
    search_query: String,
    search_info: SearchInfo,
}

impl Pane {
    fn display_title(&self, index: usize) -> String {
        if self.title.trim().is_empty() {
            format!("Terminal {}", index + 1)
        } else {
            self.title.clone()
        }
    }
}

struct Tab {
    layout: SplitNode,
    focused: String,
    maximized: Option<String>,
    panes: Vec<Pane>,
}

impl Tab {
    fn pane(&self, pane_id: &str) -> Option<&Pane> {
        self.panes.iter().find(|pane| pane.id == pane_id)
    }

    fn pane_mut(&mut self, pane_id: &str) -> Option<&mut Pane> {
        self.panes.iter_mut().find(|pane| pane.id == pane_id)
    }

    fn focused_pane(&self) -> Option<&Pane> {
        self.pane(&self.focused)
    }

    fn focused_pane_mut(&mut self) -> Option<&mut Pane> {
        let focused = self.focused.clone();
        self.pane_mut(&focused)
    }

    fn display_title(&self) -> String {
        self.focused_pane()
            .map(|pane| pane.display_title(0))
            .unwrap_or_else(|| "Terminal".into())
    }
}

pub struct Shell {
    pub settings: ShellSettings,
    data_dir: PathBuf,
    surface: Surface,
    list: gpui::Entity<ListView>,
    tabs: Vec<Tab>,
    selected: usize,
    show_settings: bool,
    focus_handle: FocusHandle,
    marked_text: String,
    toast: Option<(String, Instant)>,
    cursor_phase: bool,
    process_start: Instant,
    first_frame_reported: bool,
    last_window_title: Option<String>,
    persisted_bounds: Option<Bounds<Pixels>>,
    persistence_dirty: bool,
    _activation: Subscription,
    _bounds: Subscription,
}

impl Shell {
    pub fn new(
        window: &mut Window,
        cx: &mut Context<Self>,
        settings: ShellSettings,
        state: ShellState,
        data_dir: PathBuf,
    ) -> Self {
        let focus_handle = cx.focus_handle();
        let list = cx.new(ListView::new);
        let start_on_list = std::env::var("STACKS_GPUI_START_VIEW")
            .map(|value| value != "terminal")
            .unwrap_or(true);
        let mut shell = Self {
            settings,
            data_dir,
            surface: if start_on_list {
                Surface::List
            } else {
                Surface::Terminal
            },
            list,
            tabs: Vec::new(),
            selected: 0,
            show_settings: false,
            focus_handle: focus_handle.clone(),
            marked_text: String::new(),
            toast: None,
            cursor_phase: true,
            process_start: process_start(),
            first_frame_reported: false,
            last_window_title: None,
            persisted_bounds: None,
            persistence_dirty: false,
            _activation: Subscription::new(|| {}),
            _bounds: Subscription::new(|| {}),
        };

        shell.restore_tabs(state, cx);
        shell._activation = cx.observe_window_activation(window, |shell, window, cx| {
            let active = window.is_window_active();
            if std::env::var_os("STACKS_GPUI_TRACE_FOCUS").is_some() {
                eprintln!(
                    "STACKS_GPUI_TRACE focus {}",
                    if active { "gained" } else { "lost" }
                );
            }
            shell.report_focus(active, cx);
        });
        shell._bounds = cx.observe_window_bounds(window, |shell, window, cx| {
            shell.persisted_bounds = Some(persisted_window_bounds(window));
            shell.persistence_dirty = true;
            cx.notify();
        });
        shell.persisted_bounds = Some(persisted_window_bounds(window));
        let entity = cx.entity().downgrade();
        window.on_window_should_close(cx, move |_window, cx| {
            let _ = entity.update(cx, |shell, _cx| {
                if let Err(error) = shell.persist() {
                    eprintln!("shell state: {error:#}");
                }
            });
            true
        });
        shell.start_clock(cx);
        shell.start_persistence(cx);
        if shell.surface == Surface::List {
            shell.list.read(cx).focus_handle().focus(window, cx);
        } else {
            focus_handle.focus(window, cx);
        }
        shell
    }

    fn restore_tabs(&mut self, state: ShellState, cx: &mut Context<Self>) {
        if state.tabs.is_empty() {
            self.add_tab(cx);
            return;
        }
        let mut tabs = Vec::new();
        for persisted in state.tabs.into_iter().take(12) {
            let leaves = persisted.layout.leaves();
            if leaves.is_empty() {
                continue;
            }
            let mut panes = Vec::new();
            for pane_id in &leaves {
                panes.push(Self::make_pane(
                    &self.settings,
                    pane_id.clone(),
                    100,
                    30,
                    cx,
                ));
            }
            let focused = if leaves.iter().any(|pane| pane == &persisted.focused) {
                persisted.focused
            } else {
                leaves[0].clone()
            };
            tabs.push(Tab {
                layout: persisted.layout,
                focused,
                maximized: None,
                panes,
            });
        }
        if tabs.is_empty() {
            self.add_tab(cx);
        } else {
            self.tabs = tabs;
            self.selected = state.selected_tab.min(self.tabs.len() - 1);
        }
    }

    fn start_clock(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(250))
                    .await;
                if this
                    .update(cx, |shell, cx| {
                        let mut dirty = false;
                        if shell
                            .toast
                            .as_ref()
                            .is_some_and(|(_, at)| at.elapsed() > TOAST_DURATION)
                        {
                            shell.toast = None;
                            dirty = true;
                        }
                        shell.cursor_phase = !shell.cursor_phase;
                        let cursor_blinks = shell
                            .tabs
                            .get_mut(shell.selected)
                            .and_then(|tab| tab.focused_pane_mut())
                            .and_then(|pane| pane.model.frame().ok())
                            .and_then(|frame| frame.cursor)
                            .is_some_and(|cursor| cursor.visible && cursor.blinking);
                        if dirty || cursor_blinks {
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    fn start_persistence(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                if this
                    .update(cx, |shell, cx| {
                        if shell.persistence_dirty {
                            shell.persistence_dirty = false;
                            if let Err(error) = shell.persist() {
                                eprintln!("shell state: {error:#}");
                            }
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    fn persist(&self) -> anyhow::Result<()> {
        let state = ShellState {
            window: self.persisted_bounds.map(|bounds| PersistedWindow {
                x: f32::from(bounds.origin.x),
                y: f32::from(bounds.origin.y),
                width: f32::from(bounds.size.width),
                height: f32::from(bounds.size.height),
            }),
            selected_tab: self.selected,
            tabs: self
                .tabs
                .iter()
                .map(|tab| PersistedTab {
                    layout: tab.layout.clone(),
                    focused: tab.focused.clone(),
                })
                .collect(),
        };
        state.save(&self.data_dir)
    }

    fn mark_dirty(&mut self) {
        self.persistence_dirty = true;
    }

    fn make_pane(
        settings: &ShellSettings,
        id: String,
        cols: u16,
        rows: u16,
        cx: &mut Context<Self>,
    ) -> Pane {
        #[cfg(test)]
        {
            let _ = cx;
            // GPUI 0.3.12's test scheduler rejects background-thread wakes from
            // a real PTY reader. Shell tests exercise tabs/splits/actions, not
            // PTY I/O, so keep the pane model but skip the shell process.
            let model = TerminalModel::new(cols, rows, settings.scrollback_bytes)
                .unwrap_or_else(|_| TerminalModel::new(80, 24, 1_000_000).unwrap());
            return Pane {
                id,
                title: String::new(),
                model,
                pty: None,
                generation: None,
                exit: None,
                _task: None,
                metrics: TerminalMetrics::default(),
                selection_anchor: None,
                selecting: false,
                search_open: false,
                search_query: String::new(),
                search_info: SearchInfo::default(),
            };
        }
        #[cfg(not(test))]
        {
            Self::make_pane_live(settings, id, cols, rows, cx)
        }
    }

    #[cfg(not(test))]
    fn make_pane_live(
        settings: &ShellSettings,
        id: String,
        cols: u16,
        rows: u16,
        cx: &mut Context<Self>,
    ) -> Pane {
        let mut model = match TerminalModel::new(cols, rows, settings.scrollback_bytes) {
            Ok(model) => model,
            Err(error) => {
                eprintln!("terminal model: {error:#}");
                TerminalModel::new(80, 24, 1_000_000).expect("fallback terminal model")
            }
        };
        let (events_tx, events_rx) = async_channel::bounded(1024);
        let cwd = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        let pty =
            match Pty::spawn_with_shell(&cwd, cols, rows, settings.shell.as_deref(), events_tx) {
                Ok(pty) => pty,
                Err(error) => {
                    model.feed(
                        format!("\x1b[31mCould not start shell: {error:#}\x1b[0m\r\n").as_bytes(),
                    );
                    if std::env::var_os("STACKS_GPUI_METRICS").is_some() {
                        eprintln!("STACKS_GPUI_METRIC first_pty_spawn_ms=-1");
                    }
                    return Pane {
                        id,
                        title: "shell failed".into(),
                        model,
                        pty: None,
                        generation: None,
                        exit: Some(None),
                        _task: None,
                        metrics: TerminalMetrics::default(),
                        selection_anchor: None,
                        selecting: false,
                        search_open: false,
                        search_query: String::new(),
                        search_info: SearchInfo::default(),
                    };
                }
            };
        if std::env::var_os("STACKS_GPUI_METRICS").is_some() && FIRST_PTY_METRIC.set(()).is_ok() {
            eprintln!(
                "STACKS_GPUI_METRIC first_pty_spawn_ms={:.1}",
                process_start().elapsed().as_secs_f64() * 1000.0
            );
        }
        let generation = pty.generation.clone();
        let task_generation = generation.clone();
        let task_pane_id = id.clone();
        let task = cx.spawn(async move |this, cx| {
            while let Ok(event) = events_rx.recv().await {
                let generation = match &event {
                    PtyEvent::Data { generation, .. } | PtyEvent::Exit { generation, .. } => {
                        generation.clone()
                    }
                };
                if generation != task_generation {
                    continue;
                }
                let pane_id = task_pane_id.clone();
                if this
                    .update(cx, |shell, cx| shell.on_pty_event(&pane_id, event, cx))
                    .is_err()
                {
                    break;
                }
            }
        });
        Pane {
            id,
            title: String::new(),
            model,
            pty: Some(pty),
            generation: Some(generation),
            exit: None,
            _task: Some(task),
            metrics: TerminalMetrics::default(),
            selection_anchor: None,
            selecting: false,
            search_open: false,
            search_query: String::new(),
            search_info: SearchInfo::default(),
        }
    }

    fn add_tab(&mut self, cx: &mut Context<Self>) {
        let pane_id = format!("pane:{}", uuid::Uuid::new_v4());
        let pane = Self::make_pane(&self.settings, pane_id.clone(), 100, 30, cx);
        self.tabs.push(Tab {
            layout: SplitNode::leaf(pane_id.clone()),
            focused: pane_id,
            maximized: None,
            panes: vec![pane],
        });
        self.selected = self.tabs.len() - 1;
        self.mark_dirty();
        cx.notify();
    }

    fn split_focused(&mut self, direction: SplitDirection, cx: &mut Context<Self>) {
        let Some(target) = self.selected_tab().map(|tab| tab.focused.clone()) else {
            return;
        };
        let pane_id = format!("pane:{}", uuid::Uuid::new_v4());
        let pane = Self::make_pane(&self.settings, pane_id.clone(), 80, 24, cx);
        let Some(tab) = self.tabs.get_mut(self.selected) else {
            return;
        };
        tab.layout = tab.layout.split(&target, pane_id.clone(), direction);
        tab.panes.push(pane);
        tab.focused = pane_id;
        tab.maximized = None;
        self.marked_text.clear();
        self.mark_dirty();
        cx.notify();
    }

    fn close_focused_pane(&mut self, cx: &mut Context<Self>) {
        let Some(tab) = self.tabs.get_mut(self.selected) else {
            return;
        };
        if tab.panes.len() <= 1 {
            if self.tabs.len() > 1 {
                self.close_tab(self.selected, cx);
            }
            return;
        }
        let pane_id = tab.focused.clone();
        let leaves = tab.layout.leaves();
        let removed_index = leaves.iter().position(|pane| pane == &pane_id).unwrap_or(0);
        if let Some(layout) = tab.layout.remove(&pane_id) {
            tab.layout = layout;
        }
        tab.panes.retain(|pane| pane.id != pane_id);
        let remaining = tab.layout.leaves();
        tab.focused = remaining[removed_index.saturating_sub(1).min(remaining.len() - 1)].clone();
        tab.maximized = None;
        self.marked_text.clear();
        self.mark_dirty();
        cx.notify();
    }

    fn focus_pane(&mut self, pane_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let old_focused = self.tabs.get(self.selected).map(|tab| tab.focused.clone());
        let Some(tab) = self.tabs.get_mut(self.selected) else {
            return;
        };
        if !tab.layout.contains(pane_id) {
            return;
        }
        if tab.focused != pane_id {
            tab.focused = pane_id.to_string();
            self.marked_text.clear();
            // A maximized pane must follow pane navigation: the visible pane
            // is derived from `maximized`, not from the split tree.
            if tab.maximized.is_some() {
                tab.maximized = Some(pane_id.to_string());
            }
            self.mark_dirty();
        }
        if let Some(old) = old_focused.filter(|old| old != pane_id) {
            self.send_focus_to(&old, false);
        }
        self.send_focus_to(pane_id, true);
        self.focus_handle.focus(window, cx);
        cx.notify();
    }

    fn navigate_pane(&mut self, direction: i8, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self.tabs.get(self.selected) else {
            return;
        };
        let Some(next) = tab.layout.relative_pane(&tab.focused, direction) else {
            return;
        };
        self.focus_pane(&next, window, cx);
    }

    fn toggle_maximize_pane(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self.tabs.get_mut(self.selected) else {
            return;
        };
        if tab.layout.leaves().len() <= 1 {
            return;
        }
        let focused = tab.focused.clone();
        tab.maximized = if tab.maximized.as_deref() == Some(&focused) {
            None
        } else {
            Some(focused)
        };
        self.mark_dirty();
        cx.notify();
    }

    #[cfg_attr(test, allow(dead_code))]
    fn on_pty_event(&mut self, pane_id: &str, event: PtyEvent, cx: &mut Context<Self>) {
        let mut clipboard = Vec::new();
        let mut bells = 0;
        let mut notifications = Vec::new();
        let mut exited = None;
        {
            let Some(tab) = self
                .tabs
                .iter_mut()
                .find(|tab| tab.panes.iter().any(|pane| pane.id == pane_id))
            else {
                return;
            };
            let Some(pane) = tab.pane_mut(pane_id) else {
                return;
            };
            let event_generation = match &event {
                PtyEvent::Data { generation, .. } | PtyEvent::Exit { generation, .. } => generation,
            };
            if pane
                .generation
                .as_deref()
                .is_some_and(|expected| expected != event_generation)
            {
                return;
            }
            match event {
                PtyEvent::Data { data, .. } => {
                    let effects = pane.model.feed(&data);
                    if let Some(title) = effects.titles.last() {
                        pane.title = title.clone();
                    }
                    for bytes in effects.pty_writes {
                        if let Some(pty) = pane.pty.as_mut() {
                            let _ = pty.write(&bytes);
                        }
                    }
                    clipboard = effects.clipboard;
                    bells = effects.bells;
                    notifications = effects.notifications;
                }
                PtyEvent::Exit { status, .. } => {
                    let code = status.or_else(|| pane.pty.as_mut().and_then(Pty::exit_code));
                    pane.exit = Some(code);
                    pane.title = match code {
                        Some(0) | None => "shell exited".into(),
                        Some(code) => format!("shell exited ({code})"),
                    };
                    exited = Some(code);
                }
            }
        }

        for text in clipboard {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
            self.toast = Some(("OSC 52 clipboard updated".into(), Instant::now()));
        }
        let notify_enabled = self.settings.notifications;
        if bells > 0 {
            self.toast = Some(("Bell".into(), Instant::now()));
            if notify_enabled {
                let title = self
                    .focused_pane()
                    .map(|pane| pane.display_title(0))
                    .unwrap_or_else(|| "Terminal".into());
                notify::send("Stacks", &title);
            }
        }
        for (title, body) in notifications {
            self.toast = Some((
                if title.is_empty() {
                    body.clone()
                } else {
                    format!("{title}: {body}")
                },
                Instant::now(),
            ));
            if notify_enabled {
                notify::send(if title.is_empty() { "Stacks" } else { &title }, &body);
            }
        }
        if exited.is_some() {
            self.toast = Some(("Shell exited".into(), Instant::now()));
        }
        // PTY output does not change persisted layout. Do not mark state dirty
        // here or a busy shell rewrites shell-state.json every second.
        cx.notify();
    }

    fn selected_tab(&self) -> Option<&Tab> {
        self.tabs.get(self.selected)
    }

    fn selected_tab_mut(&mut self) -> Option<&mut Tab> {
        self.tabs.get_mut(self.selected)
    }

    fn focused_pane(&self) -> Option<&Pane> {
        self.selected_tab()?.focused_pane()
    }

    fn focused_pane_mut(&mut self) -> Option<&mut Pane> {
        self.selected_tab_mut()?.focused_pane_mut()
    }

    fn select_tab(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if index < self.tabs.len() {
            if let Some(old) = self.focused_pane().map(|pane| pane.id.clone()) {
                self.send_focus_to(&old, false);
            }
            self.selected = index;
            self.marked_text.clear();
            self.focus_handle.focus(window, cx);
            self.report_focus(true, cx);
            self.mark_dirty();
            cx.notify();
        }
    }

    fn close_tab(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.tabs.len() <= 1 || index >= self.tabs.len() {
            return;
        }
        self.tabs.remove(index);
        if self.selected >= self.tabs.len() {
            self.selected = self.tabs.len() - 1;
        } else if index < self.selected {
            self.selected -= 1;
        }
        self.marked_text.clear();
        self.mark_dirty();
        cx.notify();
    }

    fn send_focus_to(&mut self, pane_id: &str, gained: bool) {
        let Some(pane) = self.tabs.iter_mut().find_map(|tab| tab.pane_mut(pane_id)) else {
            return;
        };
        let bytes = pane.model.encode_focus(gained);
        if !bytes.is_empty()
            && let Some(pty) = pane.pty.as_mut()
        {
            let _ = pty.write(&bytes);
        }
    }

    fn report_focus(&mut self, gained: bool, cx: &mut Context<Self>) {
        if let Some(pane_id) = self.focused_pane().map(|pane| pane.id.clone()) {
            self.send_focus_to(&pane_id, gained);
        }
        cx.notify();
    }

    fn write_to_pty(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let Some(pane) = self.focused_pane_mut() else {
            return;
        };
        if let Some(pty) = pane.pty.as_mut()
            && let Err(error) = pty.write(bytes)
        {
            eprintln!("PTY write: {error:#}");
        }
        let _ = pane.model.scroll_to_bottom();
    }

    fn handle_file_drop(&mut self, paths: &ExternalPaths, cx: &mut Context<Self>) {
        let mut insert = String::new();
        let mut skipped = 0;
        for path in paths.paths() {
            if is_image_file(path) {
                if !insert.is_empty() {
                    insert.push(' ');
                }
                insert.push_str(&shell_escape_path(path));
            } else {
                skipped += 1;
            }
        }
        if insert.is_empty() {
            self.toast = Some(("Only image files can be dropped".into(), Instant::now()));
        } else {
            self.write_to_pty(insert.as_bytes());
            self.toast = Some(("Inserted dropped file path".into(), Instant::now()));
            if skipped > 0 {
                eprintln!("drop: ignored {skipped} non-image file(s)");
            }
        }
        cx.notify();
    }

    pub fn clear_focused(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if let Some(pane) = self.focused_pane_mut() {
            let _ = pane.model.clear_selection();
            pane.model.feed(b"\x1b[2J\x1b[H");
            let _ = pane.model.scroll_to_bottom();
        }
        cx.notify();
    }

    pub fn copy_selection(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(pane) = self.focused_pane_mut() else {
            return;
        };
        match pane.model.selection_text() {
            Ok(Some(text)) if !text.is_empty() => {
                cx.write_to_clipboard(ClipboardItem::new_string(text));
                let _ = pane.model.clear_selection();
                self.toast = Some(("Copied to clipboard".into(), Instant::now()));
            }
            Ok(_) => {}
            Err(error) => eprintln!("copy selection: {error:#}"),
        }
        cx.notify();
    }

    pub fn paste_clipboard(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else {
            return;
        };
        let Some(pane) = self.focused_pane_mut() else {
            return;
        };
        match pane.model.encode_paste(&text) {
            Ok(bytes) => {
                if let Some(pty) = pane.pty.as_mut() {
                    let _ = pty.write(&bytes);
                }
                let _ = pane.model.scroll_to_bottom();
                self.toast = Some(("Pasted".into(), Instant::now()));
            }
            Err(error) => eprintln!("paste: {error:#}"),
        }
        cx.notify();
    }

    pub fn toggle_search(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(pane) = self.focused_pane_mut() else {
            return;
        };
        pane.search_open = !pane.search_open;
        if pane.search_open {
            if pane.search_query.is_empty() {
                pane.search_info = SearchInfo::default();
            } else {
                let query = pane.search_query.clone();
                pane.search_info = pane.model.search_set(&query).unwrap_or_default();
            }
        } else {
            pane.search_query.clear();
            pane.search_info = SearchInfo::default();
            if let Err(error) = pane.model.search_clear() {
                eprintln!("search clear: {error:#}");
            }
        }
        cx.notify();
    }

    fn update_search_query(&mut self, query: String, cx: &mut Context<Self>) {
        let Some(pane) = self.focused_pane_mut() else {
            return;
        };
        pane.search_query = query;
        pane.search_info = match pane.model.search_set(&pane.search_query) {
            Ok(info) => info,
            Err(error) => {
                eprintln!("search: {error:#}");
                SearchInfo::default()
            }
        };
        cx.notify();
    }

    fn search_next(&mut self, backwards: bool, cx: &mut Context<Self>) {
        let Some(pane) = self.focused_pane_mut() else {
            return;
        };
        let result = if backwards {
            pane.model.search_prev()
        } else {
            pane.model.search_next()
        };
        match result {
            Ok(info) => pane.search_info = info,
            Err(error) => eprintln!("search next: {error:#}"),
        }
        cx.notify();
    }

    fn handle_search_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let keystroke = &event.keystroke;
        if keystroke.key == "escape" {
            self.toggle_search(window, cx);
            return true;
        }
        if keystroke.key == "enter" {
            self.search_next(keystroke.modifiers.shift, cx);
            return true;
        }
        if keystroke.key == "backspace" {
            let mut query = self
                .focused_pane()
                .map(|pane| pane.search_query.clone())
                .unwrap_or_default();
            query.pop();
            self.update_search_query(query, cx);
            return true;
        }
        if !keystroke.modifiers.control
            && !keystroke.modifiers.alt
            && !keystroke.modifiers.platform
            && let Some(text) = keystroke.key_char.as_deref()
            && !text.is_empty()
            && !text.chars().any(char::is_control)
        {
            let mut query = self
                .focused_pane()
                .map(|pane| pane.search_query.clone())
                .unwrap_or_default();
            query.push_str(text);
            self.update_search_query(query, cx);
        }
        true
    }

    fn handle_key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.surface == Surface::List {
            return;
        }
        if self.focused_pane().is_some_and(|pane| pane.search_open)
            && self.handle_search_key(event, window, cx)
        {
            cx.stop_propagation();
            return;
        }
        let keystroke = &event.keystroke;
        // Cmd+1..9 is intentionally handled here rather than as a keybinding:
        // it keeps the action vocabulary unit-only while preserving Stacks'
        // tab selection shortcut.
        if keystroke.modifiers.platform
            && !keystroke.modifiers.shift
            && !keystroke.modifiers.alt
            && !keystroke.modifiers.control
            && keystroke.key.len() == 1
            && keystroke.key.as_bytes()[0].is_ascii_digit()
        {
            let index = keystroke
                .key
                .parse::<usize>()
                .unwrap_or(1)
                .saturating_sub(1);
            self.select_tab(index, window, cx);
            cx.stop_propagation();
            return;
        }
        // Option+Cmd+[ / ] is Stacks' alias for pane navigation.
        if keystroke.modifiers.platform && keystroke.modifiers.alt && !keystroke.modifiers.control {
            let handled = match keystroke.key.as_str() {
                "[" => {
                    self.navigate_pane(-1, window, cx);
                    true
                }
                "]" => {
                    self.navigate_pane(1, window, cx);
                    true
                }
                _ => false,
            };
            if handled {
                cx.stop_propagation();
                return;
            }
        }
        if std::env::var_os("STACKS_GPUI_TRACE_FOCUS").is_some() {
            eprintln!(
                "STACKS_GPUI_TRACE key={:?} char={:?} mods={:?}",
                keystroke.key, keystroke.key_char, keystroke.modifiers
            );
        }
        if is_text_input_key(keystroke) {
            // Plain/Latin layouts write straight to the PTY. IME layouts use
            // GPUI's EntityInputHandler so AppKit composition and candidate
            // placement stay on the terminal cursor.
            if ime_layout(cx) {
                return;
            }
            if let Some(text) = keystroke.key_char.as_deref()
                && !text.is_empty()
            {
                self.write_to_pty(text.as_bytes());
                if let Some(pane) = self.focused_pane_mut() {
                    let _ = pane.model.clear_selection();
                }
                cx.stop_propagation();
                cx.notify();
            }
            return;
        }
        let Some(key) = ghostty_key(&keystroke.key) else {
            return;
        };
        let mods = ghostty_mods(keystroke.modifiers);
        let action = if event.is_held {
            KeyAction::Repeat
        } else {
            KeyAction::Press
        };
        let utf8 = keystroke.key_char.as_deref().filter(|text| {
            !text.is_empty() && !text.chars().any(char::is_control) && !keystroke.modifiers.control
        });
        let unshifted = keystroke
            .key_char
            .as_deref()
            .and_then(|text| text.chars().next());
        let Some(pane) = self.focused_pane_mut() else {
            return;
        };
        match pane
            .model
            .encode_key(key, mods, action, utf8, unshifted, false)
        {
            Ok(bytes) => {
                if let Some(pty) = pane.pty.as_mut() {
                    let _ = pty.write(&bytes);
                }
                let _ = pane.model.clear_selection();
                let _ = pane.model.scroll_to_bottom();
            }
            Err(error) => eprintln!("key encode: {error:#}"),
        }
        if let Some(pane) = self.focused_pane_mut() {
            pane.selection_anchor = None;
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn handle_key_up(&mut self, event: &KeyUpEvent, _window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.modifiers.platform {
            return;
        }
        let Some(key) = ghostty_key(&event.keystroke.key) else {
            return;
        };
        let mods = ghostty_mods(event.keystroke.modifiers);
        let Some(pane) = self.focused_pane_mut() else {
            return;
        };
        match pane
            .model
            .encode_key(key, mods, KeyAction::Release, None, None, false)
        {
            Ok(bytes) if !bytes.is_empty() => {
                if let Some(pty) = pane.pty.as_mut() {
                    let _ = pty.write(&bytes);
                }
                cx.notify();
            }
            Ok(_) => {}
            Err(error) => eprintln!("key release encode: {error:#}"),
        }
    }

    fn mouse_down(
        &mut self,
        pane_id: String,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.focus_pane(&pane_id, window, cx);
        let Some(pane) = self
            .tabs
            .get(self.selected)
            .and_then(|tab| tab.pane(&pane_id))
        else {
            return;
        };
        let metrics = pane.metrics;
        let tracking = pane.model.mouse_tracking();
        let Some((x, y)) = metrics.cell_at(event.position) else {
            return;
        };
        if tracking && !event.modifiers.shift {
            self.send_mouse(
                &pane_id,
                MouseAction::Press,
                Some(TermMouseButton::Left),
                event.position,
                event.modifiers,
                cx,
            );
            return;
        }
        if let Some(pane) = self.pane_mut(&pane_id) {
            pane.selection_anchor = Some((x, y));
            pane.selecting = true;
            let _ = pane.model.set_selection((x, y), (x, y));
        }
        cx.notify();
    }

    fn pane_mut(&mut self, pane_id: &str) -> Option<&mut Pane> {
        self.tabs.iter_mut().find_map(|tab| tab.pane_mut(pane_id))
    }

    fn mouse_move(
        &mut self,
        pane_id: String,
        event: &MouseMoveEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(pane) = self.pane_mut(&pane_id) else {
            return;
        };
        if !pane.selecting {
            return;
        }
        let Some((x, y)) = pane.metrics.cell_at(event.position) else {
            return;
        };
        if let Some(anchor) = pane.selection_anchor {
            let _ = pane.model.set_selection(anchor, (x, y));
            cx.notify();
        }
    }

    fn mouse_up(
        &mut self,
        pane_id: String,
        event: &MouseUpEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let selecting = self
            .tabs
            .get(self.selected)
            .and_then(|tab| tab.pane(&pane_id))
            .is_some_and(|pane| pane.selecting);
        if selecting {
            if let Some(pane) = self.pane_mut(&pane_id) {
                pane.selecting = false;
            }
            if self.settings.copy_on_select {
                self.copy_pane_selection(&pane_id, cx);
            } else {
                if let Some(pane) = self.pane_mut(&pane_id) {
                    let _ = pane.model.clear_selection();
                }
                cx.notify();
            }
            return;
        }
        let tracking = self
            .tabs
            .get(self.selected)
            .and_then(|tab| tab.pane(&pane_id))
            .is_some_and(|pane| pane.model.mouse_tracking());
        if tracking {
            self.send_mouse(
                &pane_id,
                MouseAction::Release,
                Some(TermMouseButton::Left),
                event.position,
                event.modifiers,
                cx,
            );
        }
    }

    fn copy_pane_selection(&mut self, pane_id: &str, cx: &mut Context<Self>) {
        let Some(pane) = self.pane_mut(pane_id) else {
            return;
        };
        match pane.model.selection_text() {
            Ok(Some(text)) if !text.is_empty() => {
                cx.write_to_clipboard(ClipboardItem::new_string(text));
                let _ = pane.model.clear_selection();
                self.toast = Some(("Copied to clipboard".into(), Instant::now()));
            }
            Ok(_) => {}
            Err(error) => eprintln!("copy selection: {error:#}"),
        }
        cx.notify();
    }

    fn send_mouse(
        &mut self,
        pane_id: &str,
        action: MouseAction,
        button: Option<TermMouseButton>,
        position: Point<Pixels>,
        modifiers: gpui::Modifiers,
        cx: &mut Context<Self>,
    ) {
        let Some(pane) = self.pane_mut(pane_id) else {
            return;
        };
        let Some(bounds) = pane.metrics.bounds else {
            return;
        };
        let x = f32::from(position.x - bounds.left());
        let y = f32::from(position.y - bounds.top());
        let bytes = pane.model.encode_mouse(
            action,
            button,
            ghostty_mods(modifiers),
            x,
            y,
            f32::from(bounds.size.width) as u32,
            f32::from(bounds.size.height) as u32,
            pane.metrics.cell_width.max(1.0) as u32,
            pane.metrics.cell_height.max(1.0) as u32,
        );
        if let Ok(bytes) = bytes
            && !bytes.is_empty()
            && let Some(pty) = pane.pty.as_mut()
        {
            let _ = pty.write(&bytes);
        }
        cx.notify();
    }

    fn scroll_wheel(
        &mut self,
        pane_id: String,
        event: &ScrollEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(pane) = self.pane_mut(&pane_id) else {
            return;
        };
        let lines = match event.delta {
            ScrollDelta::Lines(delta) => f32::from(delta.y),
            ScrollDelta::Pixels(delta) => f32::from(delta.y) / pane.metrics.cell_height.max(1.0),
        };
        pane.model.scroll(-(lines.round() as isize));
        let _ = pane.model.clear_selection();
        pane.selection_anchor = None;
        cx.notify();
    }

    fn prepare_terminal(
        &mut self,
        pane_id: &str,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> PreparedFrame {
        let focused = self.focused_pane().is_some_and(|pane| pane.id == pane_id);
        let marked = if focused {
            self.marked_text.clone()
        } else {
            String::new()
        };
        let cursor_phase = self.cursor_phase;
        let style = self.settings.terminal_style();
        let Some(pane) = self.pane_mut(pane_id) else {
            return PreparedFrame::default();
        };
        let (metrics, prepared) = prepare_frame_with_style(
            &mut pane.model,
            bounds,
            &style,
            &marked,
            cursor_phase,
            window,
        );
        pane.metrics = metrics;
        if let Some(pty) = pane.pty.as_mut()
            && let Err(error) = pty.resize(metrics.cols, metrics.rows)
        {
            eprintln!("PTY resize: {error:#}");
        }
        prepared
    }

    fn render_terminal(
        &self,
        pane_id: &str,
        focused: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let entity = cx.entity();
        let focus_handle = self.focus_handle.clone();
        let pane_for_prepare = pane_id.to_string();
        let pane_for_mouse = pane_id.to_string();
        let pane_for_move = pane_id.to_string();
        let pane_for_up = pane_id.to_string();
        let pane_for_up_out = pane_id.to_string();
        let pane_for_scroll = pane_id.to_string();
        let search = if focused {
            self.tabs
                .get(self.selected)
                .and_then(|tab| tab.pane(pane_id))
                .filter(|pane| pane.search_open)
                .map(|pane| (pane.search_query.clone(), pane.search_info))
        } else {
            None
        };
        let prepared_entity = entity.clone();
        let paint_entity = entity.clone();
        let focus_for_input = focus_handle.clone();

        div()
            .size_full()
            .min_w_0()
            .min_h_0()
            .relative()
            .cursor(GpuiCursorStyle::IBeam)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |shell, event, window, cx| {
                    shell.mouse_down(pane_for_mouse.clone(), event, window, cx);
                }),
            )
            .on_mouse_move(cx.listener(move |shell, event, window, cx| {
                shell.mouse_move(pane_for_move.clone(), event, window, cx);
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(move |shell, event, window, cx| {
                    shell.mouse_up(pane_for_up.clone(), event, window, cx);
                }),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(move |shell, event, window, cx| {
                    shell.mouse_up(pane_for_up_out.clone(), event, window, cx);
                }),
            )
            .on_scroll(cx.listener(move |shell, event, window, cx| {
                shell.scroll_wheel(pane_for_scroll.clone(), event, window, cx);
            }))
            .child(
                canvas(
                    move |bounds, window, cx| {
                        prepared_entity.update(cx, |shell, cx| {
                            shell.prepare_terminal(&pane_for_prepare, bounds, window, cx)
                        })
                    },
                    move |bounds, prepared, window, cx| {
                        if focused {
                            window.handle_input(
                                &focus_for_input,
                                ElementInputHandler::new(bounds, paint_entity.clone()),
                                cx,
                            );
                        }
                        prepared.paint(bounds, window, cx);
                    },
                )
                .size_full(),
            )
            .when_some(search, |this, (query, info)| {
                let count = if info.total == 0 {
                    "0/0".to_string()
                } else {
                    format!(
                        "{}/{}",
                        info.selected.map_or(1, |index| index + 1),
                        info.total
                    )
                };
                this.child(
                    div()
                        .absolute()
                        .top(px(8.0))
                        .right(px(12.0))
                        .flex()
                        .items_center()
                        .gap_1()
                        .px_2()
                        .py_1()
                        .rounded_md()
                        .bg(rgb(0x182433))
                        .border_1()
                        .border_color(rgb(0x38536e))
                        .text_sm()
                        .child(
                            div()
                                .min_w(px(140.0))
                                .max_w(px(300.0))
                                .truncate()
                                .text_color(if query.is_empty() {
                                    rgb(0x62778a)
                                } else {
                                    rgb(0xd7e1eb)
                                })
                                .child(if query.is_empty() {
                                    "Search…".to_string()
                                } else {
                                    query
                                }),
                        )
                        .child(div().text_color(rgb(0x8296a8)).child(count))
                        .child(
                            div()
                                .id("search-prev")
                                .px_1()
                                .cursor_pointer()
                                .text_color(rgb(0x8fb4d4))
                                .on_click(cx.listener(|shell, _, window, cx| {
                                    shell.search_next(true, cx);
                                    let _ = window;
                                }))
                                .child("↑"),
                        )
                        .child(
                            div()
                                .id("search-next")
                                .px_1()
                                .cursor_pointer()
                                .text_color(rgb(0x8fb4d4))
                                .on_click(cx.listener(|shell, _, window, cx| {
                                    shell.search_next(false, cx);
                                    let _ = window;
                                }))
                                .child("↓"),
                        )
                        .child(
                            div()
                                .id("search-close")
                                .px_1()
                                .cursor_pointer()
                                .text_color(rgb(0x93a7b8))
                                .on_click(cx.listener(|shell, _, window, cx| {
                                    shell.toggle_search(window, cx);
                                }))
                                .child("×"),
                        ),
                )
            })
    }

    fn render_split_node(&self, node: &SplitNode, tab: &Tab, cx: &mut Context<Self>) -> AnyElement {
        match node {
            SplitNode::Leaf { pane_id } => {
                let focused = tab.focused == *pane_id;
                div()
                    .size_full()
                    .min_w_0()
                    .min_h_0()
                    .border_1()
                    .border_color(if focused {
                        rgb(0x315574)
                    } else {
                        rgb(0x18222d)
                    })
                    .child(self.render_terminal(pane_id, focused, cx))
                    .into_any_element()
            }
            SplitNode::Split {
                direction,
                ratio,
                first,
                second,
                ..
            } => {
                let first = self.render_split_node(first, tab, cx);
                let second = self.render_split_node(second, tab, cx);
                let container = div().size_full().min_w_0().min_h_0();
                match direction {
                    SplitDirection::Row => container
                        .flex()
                        .flex_row()
                        .child(div().h_full().w(relative(*ratio)).min_w_0().child(first))
                        .child(
                            div()
                                .h_full()
                                .w(relative(1.0 - *ratio))
                                .min_w_0()
                                .child(second),
                        )
                        .into_any_element(),
                    SplitDirection::Column => container
                        .flex()
                        .flex_col()
                        .child(div().w_full().h(relative(*ratio)).min_h_0().child(first))
                        .child(
                            div()
                                .w_full()
                                .h(relative(1.0 - *ratio))
                                .min_h_0()
                                .child(second),
                        )
                        .into_any_element(),
                }
            }
        }
    }

    fn render_workspace(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(tab) = self.selected_tab() else {
            return div().size_full().into_any_element();
        };
        if let Some(maximized) = tab.maximized.as_deref()
            && tab.layout.contains(maximized)
        {
            let focused = tab.focused == maximized;
            return div()
                .size_full()
                .min_w_0()
                .min_h_0()
                .child(self.render_terminal(maximized, focused, cx))
                .into_any_element();
        }
        self.render_split_node(&tab.layout, tab, cx)
    }

    fn render_topbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let surface_label = if self.surface == Surface::List {
            "Cards"
        } else {
            "Global terminal"
        };
        let list_active = self.surface == Surface::List;
        let terminal_active = self.surface == Surface::Terminal;
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap_2()
            .h(px(TOP_BAR_HEIGHT))
            .flex_shrink_0()
            .px_3()
            .bg(rgb(0x11171f))
            .border_b_1()
            .border_color(rgb(0x222e3b))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .text_sm()
                    .child(div().text_color(rgb(0x8ea3b8)).child("Stacks"))
                    .child(div().text_color(rgb(0x50657a)).child("/"))
                    .child(div().text_color(rgb(0xd7e1eb)).child(surface_label)),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .ml_4()
                    .child(
                        div()
                            .id("surface-list")
                            .px_2()
                            .py_1()
                            .rounded_sm()
                            .cursor_pointer()
                            .text_xs()
                            .text_color(if list_active {
                                rgb(0xe3edf6)
                            } else {
                                rgb(0x7f95a9)
                            })
                            .bg(if list_active {
                                rgb(0x233447)
                            } else {
                                rgb(0x11171f)
                            })
                            .on_click(cx.listener(|shell, _, window, cx| {
                                shell.show_list(window, cx);
                            }))
                            .child("Cards ⌘L"),
                    )
                    .child(
                        div()
                            .id("surface-terminal")
                            .px_2()
                            .py_1()
                            .rounded_sm()
                            .cursor_pointer()
                            .text_xs()
                            .text_color(if terminal_active {
                                rgb(0xe3edf6)
                            } else {
                                rgb(0x7f95a9)
                            })
                            .bg(if terminal_active {
                                rgb(0x233447)
                            } else {
                                rgb(0x11171f)
                            })
                            .on_click(cx.listener(|shell, _, window, cx| {
                                shell.show_terminal(window, cx);
                            }))
                            .child("Terminal ⌘T"),
                    ),
            )
            .child(div().flex_1())
            .child(
                div()
                    .text_xs()
                    .text_color(rgb(0x5f7488))
                    .child("GPUI product-surface spike · ⌘, settings"),
            )
            .child(
                div()
                    .id("open-settings")
                    .px_1()
                    .rounded_sm()
                    .cursor_pointer()
                    .text_color(rgb(0x8fb4d4))
                    .hover(|style| style.bg(rgb(0x223246)))
                    .on_click(cx.listener(|shell, _, window, cx| {
                        shell.show_settings(window, cx);
                    }))
                    .child("⚙"),
            )
    }

    fn render_tab_bar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let tab_count = self.tabs.len();
        div()
            .flex()
            .flex_row()
            .items_center()
            .h(px(TAB_BAR_HEIGHT))
            .flex_shrink_0()
            .gap_1()
            .px_2()
            .bg(rgb(0x141a22))
            .border_b_1()
            .border_color(rgb(0x24303d))
            .children(self.tabs.iter().enumerate().map(|(index, tab)| {
                let active = index == self.selected;
                div()
                    .id(("tab", index))
                    .flex()
                    .items_center()
                    .gap_1()
                    .h(px(26.0))
                    .px_2()
                    .rounded_md()
                    .cursor_pointer()
                    .bg(if active { rgb(0x233447) } else { rgb(0x161d26) })
                    .border_1()
                    .border_color(if active { rgb(0x3b5e7d) } else { rgb(0x202a35) })
                    .text_color(if active { rgb(0xe3edf6) } else { rgb(0x8699aa) })
                    .text_sm()
                    .on_click(cx.listener(move |shell, _, window, cx| {
                        shell.select_tab(index, window, cx);
                    }))
                    .child(format!("{}", index + 1))
                    .child(div().max_w(px(150.0)).truncate().child(tab.display_title()))
                    .when(tab_count > 1, |this| {
                        this.child(
                            div()
                                .id(("close-tab", index))
                                .px_1()
                                .rounded_sm()
                                .hover(|style| style.bg(rgb(0x3a2530)).text_color(rgb(0xe6b5bd)))
                                .on_click(cx.listener(move |shell, _, window, cx| {
                                    cx.stop_propagation();
                                    shell.close_tab(index, cx);
                                    let _ = window;
                                }))
                                .child("×"),
                        )
                    })
            }))
            .child(
                div()
                    .id("new-tab")
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(26.0))
                    .rounded_md()
                    .cursor_pointer()
                    .text_color(rgb(0x8fb4d4))
                    .hover(|style| style.bg(rgb(0x223246)))
                    .on_click(cx.listener(|shell, _, window, cx| {
                        shell.new_terminal(window, cx);
                    }))
                    .child("+"),
            )
            .child(div().flex_1())
            .child(
                div()
                    .text_xs()
                    .text_color(rgb(0x62778a))
                    .child("⇧⌘T new · ⌘D split · ⇧⌘D stack · ⇧⌘↩ maximize"),
            )
    }

    fn render_settings_overlay(&self, cx: &mut Context<Self>) -> AnyElement {
        let rows = [
            (
                "Font",
                format!(
                    "{} {}px",
                    self.settings.font_family, self.settings.font_size
                ),
            ),
            ("Line height", format!("{}px", self.settings.line_height)),
            (
                "Scrollback",
                format!("{} bytes", self.settings.scrollback_bytes),
            ),
            (
                "Copy on select",
                if self.settings.copy_on_select {
                    "on"
                } else {
                    "off"
                }
                .to_string(),
            ),
            (
                "Notifications",
                if self.settings.notifications {
                    "on"
                } else {
                    "off"
                }
                .to_string(),
            ),
            (
                "Shell",
                self.settings
                    .shell
                    .clone()
                    .unwrap_or_else(|| "login shell ($SHELL)".into()),
            ),
            ("Theme", self.settings.theme.clone()),
        ];
        div()
            .size_full()
            .flex()
            .flex_col()
            .gap_3()
            .p_6()
            .bg(rgb(0x0f141b))
            .child(
                div()
                    .text_xl()
                    .text_color(rgb(0xd7e1eb))
                    .child("Settings (stub)"),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(rgb(0x708499))
                    .child(format!(
                        "Loaded from {}. The settings screen itself is out of scope; edit the JSON and relaunch.",
                        self.data_dir.join("settings.json").display()
                    )),
            )
            .children(rows.into_iter().map(|(label, value)| {
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .w_full()
                    .max_w(px(520.0))
                    .border_b_1()
                    .border_color(rgb(0x1f2a37))
                    .pb_1()
                    .child(div().text_sm().text_color(rgb(0x8ea3b8)).child(label))
                    .child(div().text_sm().text_color(rgb(0xd7e1eb)).child(value))
            }))
            .child(
                div()
                    .id("close-settings")
                    .mt_2()
                    .px_3()
                    .py_1()
                    .rounded_md()
                    .bg(rgb(0x233447))
                    .border_1()
                    .border_color(rgb(0x3b5e7d))
                    .text_sm()
                    .text_color(rgb(0xd7e1eb))
                    .cursor_pointer()
                    .on_click(cx.listener(|shell, _, window, cx| {
                        shell.show_settings(window, cx);
                    }))
                    .child("Back"),
            )
            .into_any_element()
    }
}

/// Action listeners must live on the focused element, not `App::on_action`:
/// global listeners run inside `Window::dispatch_action`, and updating the
/// window from there fails because GPUI has already taken the window out of
/// `App::windows` for the dispatch. Element listeners receive the window
/// directly, so shortcuts and native menu items both reach the shell.
trait ShellActions {
    fn on_shell_actions(self, cx: &mut Context<Shell>) -> Self;
}

impl ShellActions for gpui::Div {
    fn on_shell_actions(self, cx: &mut Context<Shell>) -> Self {
        self.on_action(cx.listener(|shell, _: &crate::About, window, cx| shell.about(window, cx)))
            .on_action(
                cx.listener(|shell, _: &crate::Settings, window, cx| {
                    shell.show_settings(window, cx)
                }),
            )
            .on_action(cx.listener(|shell, _: &crate::Quit, window, cx| shell.quit(window, cx)))
            .on_action(
                cx.listener(|shell, _: &crate::ResetWindowSize, window, cx| {
                    shell.reset_window_size(window, cx)
                }),
            )
            .on_action(cx.listener(|shell, _: &crate::NewTerminal, window, cx| {
                shell.new_terminal(window, cx)
            }))
            .on_action(
                cx.listener(|shell, _: &crate::FocusGlobalTerminal, window, cx| {
                    shell.focus_global_terminal(window, cx)
                }),
            )
            .on_action(
                cx.listener(|shell, _: &crate::ShowList, window, cx| shell.show_list(window, cx)),
            )
            .on_action(cx.listener(|shell, _: &crate::ShowTerminal, window, cx| {
                shell.show_terminal(window, cx)
            }))
            .on_action(cx.listener(|shell, _: &crate::RefreshList, window, cx| {
                shell.refresh_list(window, cx)
            }))
            .on_action(cx.listener(|shell, _: &crate::CloseTerminal, window, cx| {
                shell.close_terminal(window, cx)
            }))
            .on_action(
                cx.listener(|shell, _: &crate::SplitRight, window, cx| {
                    shell.split_right(window, cx)
                }),
            )
            .on_action(
                cx.listener(|shell, _: &crate::SplitDown, window, cx| shell.split_down(window, cx)),
            )
            .on_action(cx.listener(|shell, _: &crate::ToggleMaximize, window, cx| {
                shell.toggle_maximize(window, cx)
            }))
            .on_action(cx.listener(|shell, _: &crate::ToggleSearch, window, cx| {
                shell.toggle_search(window, cx)
            }))
            .on_action(cx.listener(|shell, _: &crate::ClearTerminal, window, cx| {
                shell.clear_focused(window, cx)
            }))
            .on_action(cx.listener(|shell, _: &crate::CopySelection, window, cx| {
                shell.copy_selection(window, cx)
            }))
            .on_action(cx.listener(|shell, _: &crate::PasteClipboard, window, cx| {
                shell.paste_clipboard(window, cx)
            }))
            .on_action(cx.listener(|shell, _: &crate::NextTerminal, window, cx| {
                shell.next_terminal(window, cx)
            }))
            .on_action(
                cx.listener(|shell, _: &crate::PreviousTerminal, window, cx| {
                    shell.previous_terminal(window, cx)
                }),
            )
            .on_action(
                cx.listener(|shell, _: &crate::NextPane, window, cx| shell.next_pane(window, cx)),
            )
            .on_action(cx.listener(|shell, _: &crate::PreviousPane, window, cx| {
                shell.previous_pane(window, cx)
            }))
            .on_action(cx.listener(|shell, _: &crate::MinimizeWindow, window, cx| {
                shell.minimize_window(window, cx)
            }))
            .on_action(
                cx.listener(|shell, _: &crate::ZoomWindow, window, cx| {
                    shell.zoom_window(window, cx)
                }),
            )
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.first_frame_reported {
            self.first_frame_reported = true;
            if std::env::var_os("STACKS_GPUI_METRICS").is_some() {
                eprintln!(
                    "STACKS_GPUI_METRIC first_frame_ms={:.1}",
                    self.process_start.elapsed().as_secs_f64() * 1000.0
                );
            }
        }
        let title = if self.surface == Surface::List {
            "Cards — Stacks".to_string()
        } else {
            format!(
                "{} — Stacks",
                self.focused_pane()
                    .map(|pane| pane.display_title(0))
                    .unwrap_or_else(|| "Global terminal".into())
            )
        };
        if self.last_window_title.as_deref() != Some(title.as_str()) {
            self.last_window_title = Some(title.clone());
            window.set_window_title(&title);
        }
        if !self.focus_handle.is_focused(window) {
            window.focus(&self.focus_handle, cx);
            cx.notify();
        }

        div()
            .size_full()
            .flex()
            .flex_col()
            .track_focus(&self.focus_handle)
            .key_context("Shell")
            .on_key_down(cx.listener(Self::handle_key_down))
            .on_key_up(cx.listener(Self::handle_key_up))
            .on_drop(cx.listener(|shell, paths: &ExternalPaths, _, cx| {
                shell.handle_file_drop(paths, cx);
            }))
            .bg(rgb(0x0f141b))
            .text_color(rgb(0xd7e1eb))
            .font_family(FONT_FAMILY)
            .on_shell_actions(cx)
            .child(self.render_topbar(cx))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .relative()
                    .when(self.surface == Surface::Terminal, |this| {
                        this.child(self.render_tab_bar(cx))
                    })
                    .child(
                        div()
                            .flex_1()
                            .min_h_0()
                            .min_w_0()
                            .child(if self.show_settings {
                                self.render_settings_overlay(cx)
                            } else if self.surface == Surface::List {
                                self.list.clone().into_any_element()
                            } else {
                                self.render_workspace(cx)
                            }),
                    )
                    .when_some(self.toast.as_ref(), |this, (message, _)| {
                        this.child(
                            div()
                                .absolute()
                                .top(px(52.0))
                                .left(px(0.0))
                                .right(px(0.0))
                                .flex()
                                .justify_center()
                                .child(
                                    div()
                                        .px_3()
                                        .py_1()
                                        .rounded_md()
                                        .bg(rgb(0x182433))
                                        .border_1()
                                        .border_color(rgb(0x38536e))
                                        .text_color(rgb(0xd7e1eb))
                                        .text_sm()
                                        .child(message.clone()),
                                ),
                        )
                    }),
            )
    }
}

impl EntityInputHandler for Shell {
    fn text_for_range(
        &mut self,
        _range: Range<usize>,
        _adjusted_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        Some(String::new())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        None
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        if self.marked_text.is_empty() {
            None
        } else {
            Some(0..self.marked_text.encode_utf16().count())
        }
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.marked_text.clear();
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        _range: Option<Range<usize>>,
        text: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.marked_text.clear();
        if text.is_empty() {
            cx.notify();
            return;
        }
        self.write_to_pty(text.as_bytes());
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _range: Option<Range<usize>>,
        new_text: &str,
        _new_selected_range: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.marked_text = new_text.to_string();
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        _range_utf16: Range<usize>,
        element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let pane = self.focused_pane_mut()?;
        let cursor = pane.model.frame().ok()?.cursor?;
        let metrics = pane.metrics;
        Some(ime_cursor_bounds(
            element_bounds,
            metrics.cell_width,
            metrics.cell_height,
            cursor.x,
            cursor.y,
        ))
    }

    fn character_index_for_point(
        &mut self,
        _point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}

/// Anchor for the IME candidate window. Kept as a free function so the shell
/// can assert (without a display server) that the candidate window tracks the
/// terminal cursor rather than the window origin.
pub fn ime_cursor_bounds(
    element_bounds: Bounds<Pixels>,
    cell_width: f32,
    cell_height: f32,
    cursor_x: u16,
    cursor_y: u16,
) -> Bounds<Pixels> {
    Bounds {
        origin: point(
            element_bounds.left() + px(PADDING + f32::from(cursor_x) * cell_width),
            element_bounds.top() + px(PADDING + f32::from(cursor_y) * cell_height),
        ),
        size: size(px(cell_width.max(1.0)), px(cell_height.max(1.0))),
    }
}

impl Shell {
    // --- action entry points -------------------------------------------------

    pub fn quit(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if let Err(error) = self.persist() {
            eprintln!("shell state: {error:#}");
        }
        cx.quit();
    }

    pub fn about(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.toast = Some((
            "Stacks GPUI product-surface spike · card #322".into(),
            Instant::now(),
        ));
        cx.notify();
    }

    pub fn show_settings(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.show_settings = !self.show_settings;
        cx.notify();
    }

    pub fn reset_window_size(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        window.resize(size(px(DEFAULT_WINDOW_SIZE.0), px(DEFAULT_WINDOW_SIZE.1)));
        self.mark_dirty();
        cx.notify();
    }

    pub fn new_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_settings = false;
        self.surface = Surface::Terminal;
        self.add_tab(cx);
        self.focus_handle.focus(window, cx);
        cx.notify();
    }

    pub fn focus_global_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_settings = false;
        self.surface = Surface::Terminal;
        self.focus_handle.focus(window, cx);
        self.report_focus(true, cx);
        cx.notify();
    }

    pub fn show_list(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_settings = false;
        self.surface = Surface::List;
        self.list.read(cx).focus_handle().focus(window, cx);
        cx.notify();
    }

    pub fn show_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_settings = false;
        self.surface = Surface::Terminal;
        self.focus_handle.focus(window, cx);
        cx.notify();
    }

    pub fn refresh_list(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.list.update(cx, |list, cx| list.reload_from_shell(cx));
        cx.notify();
    }

    pub fn close_terminal(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.close_focused_pane(cx);
    }

    pub fn split_right(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.split_focused(SplitDirection::Row, cx);
    }

    pub fn split_down(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.split_focused(SplitDirection::Column, cx);
    }

    pub fn toggle_maximize(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.toggle_maximize_pane(window, cx);
    }

    pub fn previous_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.tabs.is_empty() {
            let index = (self.selected + self.tabs.len() - 1) % self.tabs.len();
            self.select_tab(index, window, cx);
        }
    }

    pub fn next_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.tabs.is_empty() {
            let index = (self.selected + 1) % self.tabs.len();
            self.select_tab(index, window, cx);
        }
    }

    pub fn previous_pane(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.navigate_pane(-1, window, cx);
    }

    pub fn next_pane(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.navigate_pane(1, window, cx);
    }

    pub fn minimize_window(&mut self, window: &mut Window, _cx: &mut Context<Self>) {
        window.minimize_window();
    }

    pub fn zoom_window(&mut self, window: &mut Window, _cx: &mut Context<Self>) {
        window.zoom_window();
    }
}

/// GPUI's `Window::bounds()` is the outer NSWindow frame, while
/// `WindowOptions::window_bounds` is interpreted as the content rect. Persist
/// the origin with the viewport size or the window grows by the titlebar height
/// on every launch.
fn persisted_window_bounds(window: &Window) -> Bounds<Pixels> {
    Bounds {
        origin: window.bounds().origin,
        size: window.viewport_size(),
    }
}

pub fn restore_bounds(window: PersistedWindow) -> Option<Bounds<Pixels>> {
    let width = window.width.clamp(480.0, 6000.0);
    let height = window.height.clamp(320.0, 4000.0);
    if !window.x.is_finite() || !window.y.is_finite() {
        return None;
    }
    Some(Bounds {
        origin: point(px(window.x), px(window.y)),
        size: size(px(width), px(height)),
    })
}

static PROCESS_START: OnceLock<Instant> = OnceLock::new();
#[cfg_attr(test, allow(dead_code))]
static FIRST_PTY_METRIC: OnceLock<()> = OnceLock::new();

/// Called as the first statement in `main` so metrics include process start-up.
pub fn mark_process_start() {
    let _ = PROCESS_START.set(Instant::now());
}

pub(crate) fn process_start() -> Instant {
    *PROCESS_START.get_or_init(Instant::now)
}

fn is_image_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|extension| IMAGE_EXTENSIONS.contains(&extension.as_str()))
}

fn shell_escape_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    format!("'{}'", path.replace('\'', "'\\''"))
}

fn ime_layout(cx: &App) -> bool {
    let name = cx.keyboard_layout().name().to_lowercase();
    [
        "japanese",
        "kotoeri",
        "hiragana",
        "katakana",
        "romaji",
        "pinyin",
        "bopomofo",
        "zhuyin",
        "hangul",
        "korean",
        "chinese",
        "unicode hex",
    ]
    .iter()
    .any(|needle| name.contains(needle))
}

// The activation/bounds subscriptions are created after the shell exists, so
// the struct starts with inert subscriptions that are replaced immediately.
#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    fn actions_reach_the_focused_shell(cx: &mut gpui::TestAppContext) {
        let data_dir =
            std::env::temp_dir().join(format!("stacks-gpui-test-{}", uuid::Uuid::new_v4()));
        let (shell, cx) = cx.add_window_view(|window, cx| {
            Shell::new(
                window,
                cx,
                ShellSettings::default(),
                ShellState::default(),
                data_dir.clone(),
            )
        });
        cx.run_until_parked();

        assert_eq!(
            shell.read_with(cx, |shell, _| shell.tabs[shell.selected].panes.len()),
            1
        );

        cx.dispatch_action(crate::SplitRight);
        assert_eq!(
            shell.read_with(cx, |shell, _| shell.tabs[shell.selected].panes.len()),
            2,
            "Cmd+D / Split Right listener must reach the shell"
        );

        cx.dispatch_action(crate::SplitDown);
        assert_eq!(
            shell.read_with(cx, |shell, _| shell.tabs[shell.selected].panes.len()),
            3
        );

        cx.dispatch_action(crate::ToggleMaximize);
        let (focused, maximized) = shell.read_with(cx, |shell, _| {
            let tab = &shell.tabs[shell.selected];
            (tab.focused.clone(), tab.maximized.clone())
        });
        assert_eq!(
            maximized,
            Some(focused.clone()),
            "maximize must work once a split exists"
        );

        // Maximized panes are rendered from `maximized`, not `focused`, so
        // pane navigation must move both.
        cx.dispatch_action(crate::PreviousPane);
        let (previous, previous_maximized) = shell.read_with(cx, |shell, _| {
            let tab = &shell.tabs[shell.selected];
            (tab.focused.clone(), tab.maximized.clone())
        });
        assert_ne!(previous, focused);
        assert_eq!(
            previous_maximized,
            Some(previous.clone()),
            "maximized pane must follow PreviousPane"
        );

        cx.dispatch_action(crate::NextPane);
        let next_maximized =
            shell.read_with(cx, |shell, _| shell.tabs[shell.selected].maximized.clone());
        assert_eq!(
            next_maximized,
            Some(focused),
            "maximized pane must follow NextPane"
        );

        cx.dispatch_action(crate::CloseTerminal);
        assert_eq!(
            shell.read_with(cx, |shell, _| shell.tabs[shell.selected].panes.len()),
            2
        );

        cx.dispatch_action(crate::NewTerminal);
        assert_eq!(shell.read_with(cx, |shell, _| shell.tabs.len()), 2);

        cx.dispatch_action(crate::ShowList);
        assert_eq!(shell.read_with(cx, |shell, _| shell.surface), Surface::List);
        cx.dispatch_action(crate::ShowTerminal);
        assert_eq!(
            shell.read_with(cx, |shell, _| shell.surface),
            Surface::Terminal
        );

        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn ime_anchor_tracks_the_terminal_cursor() {
        let bounds = Bounds {
            origin: point(px(100.0), px(50.0)),
            size: size(px(800.0), px(600.0)),
        };
        let anchor = ime_cursor_bounds(bounds, 8.0, 18.0, 12, 5);
        assert_eq!(f32::from(anchor.origin.x), 100.0 + PADDING + 96.0);
        assert_eq!(f32::from(anchor.origin.y), 50.0 + PADDING + 90.0);
        assert_eq!(f32::from(anchor.size.width), 8.0);
        assert_eq!(f32::from(anchor.size.height), 18.0);
    }

    #[test]
    fn image_drop_escaping_quotes_paths() {
        assert_eq!(
            shell_escape_path(Path::new("/tmp/a b'c.png")),
            "'/tmp/a b'\\''c.png'"
        );
        assert!(is_image_file(Path::new("/tmp/cat.HEIC")));
        assert!(!is_image_file(Path::new("/tmp/notes.txt")));
    }
}
