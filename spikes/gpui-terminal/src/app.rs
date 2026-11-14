//! The one-window Cmd+T spike: tabs, PTY, emulator, renderer, and input.

use std::{
    ops::Range,
    time::{Duration, Instant},
};

use ghostty_vt::key::Action as KeyAction;
use gpui::{
    AnyElement, App, Bounds, ClipboardItem, Context, CursorStyle as GpuiCursorStyle,
    ElementInputHandler, EntityInputHandler, FocusHandle, IntoElement, KeyDownEvent, KeyUpEvent,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Point,
    Render, ScrollDelta, ScrollEvent, Styled, Task, UTF16Selection, Window, canvas, div, point,
    prelude::*, px, relative, rgb, size,
};

use crate::host_ipc::{HostCommand, HostEvent, HostLink, host_socket_from_env_or_args};
use stacks_terminal::{
    fixtures::{demo_fixture, demo_second_tab},
    keymap::{ghostty_key, ghostty_mods, is_text_input_key},
    pty::{Pty, PtyEvent},
    split_tree::{SplitDirection, SplitNode},
    terminal_model::{MouseAction, MouseButton as TermMouseButton, SearchInfo, TerminalModel},
    terminal_surface::{FONT_FAMILY, PADDING, PreparedFrame, TerminalMetrics, prepare_frame},
};

const TAB_BAR_HEIGHT: f32 = 38.0;
const TOAST_DURATION: Duration = Duration::from_millis(1400);

struct Pane {
    id: String,
    title: String,
    model: TerminalModel,
    pty: Option<Pty>,
    generation: Option<String>,
    exit: Option<Option<i32>>,
    bell_count: usize,
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
    #[allow(dead_code)]
    id: String,
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

    fn any_exit(&self) -> bool {
        self.panes.iter().any(|pane| pane.exit.is_some())
    }
}

pub struct SpikeApp {
    tabs: Vec<Tab>,
    selected: usize,
    visible: bool,
    focus_handle: FocusHandle,
    marked_text: String,
    toast: Option<(String, Instant)>,
    cursor_phase: bool,
    last_render: Option<(Instant, Duration)>,
    activation: Option<gpui::Subscription>,
    demo: bool,
    raised: bool,
    /// Present only when Stacks launched this process with a host socket.
    host: Option<HostLink>,
    host_task: Option<Task<()>>,
    last_host_title: Option<String>,
    /// When the native window last became visible. Used to swallow the
    /// Cmd+T key event macOS may replay to the helper right after Stacks
    /// hands focus over, which would otherwise open-and-immediately-close.
    visible_since: Option<Instant>,
}

impl SpikeApp {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus_handle = cx.focus_handle();
        let demo = std::env::var_os("SPIKE_DEMO").is_some();
        let mut app = Self {
            tabs: Vec::new(),
            selected: 0,
            visible: true,
            focus_handle: focus_handle.clone(),
            marked_text: String::new(),
            toast: None,
            cursor_phase: true,
            last_render: None,
            activation: None,
            demo,
            raised: false,
            host: None,
            host_task: None,
            last_host_title: None,
            visible_since: None,
        };
        let activation = cx.observe_window_activation(window, |app, window, cx| {
            let gained = window.is_window_active();
            app.report_focus(gained, cx);
        });
        app.activation = Some(activation);
        app.add_tab(cx);
        if demo {
            app.split_focused(SplitDirection::Row, cx);
            app.split_focused(SplitDirection::Column, cx);
            app.add_demo_tab(cx);
            app.add_demo_tab(cx);
            app.selected = 0;
        }
        app.start_clock(cx);
        match host_socket_from_env_or_args() {
            Some(path) => app.connect_host(&path, window, cx),
            None => focus_handle.focus(window, cx),
        }
        app
    }

    /// Connect to the Tauri host and drive the window from its commands.
    fn connect_host(
        &mut self,
        path: &std::path::Path,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (link, commands) = match HostLink::connect(path) {
            Ok(link) => link,
            Err(error) => {
                // Without a host there is no UI to drive this hidden window.
                eprintln!("host mode: {error:#}");
                cx.quit();
                return;
            }
        };
        link.emit(&HostEvent::Ready {
            pid: std::process::id(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        });
        self.host = Some(link);
        self.visible = false;
        #[cfg(target_os = "macos")]
        crate::mac_front::set_window_visible(false);
        let task = cx.spawn_in(window, async move |this, cx| {
            while let Ok(command) = commands.recv().await {
                let quit = command == HostCommand::Quit;
                if this
                    .update_in(cx, |app, window, cx| {
                        app.handle_host_command(command, window, cx)
                    })
                    .is_err()
                {
                    break;
                }
                if quit {
                    if let Ok(()) = this.update(cx, |_, cx| cx.quit()) {
                        break;
                    }
                }
            }
        });
        self.host_task = Some(task);
        let entity = cx.entity().downgrade();
        window.on_window_should_close(cx, move |_window, cx| {
            // Closing the native terminal window hides it; PTYs survive so
            // `Cmd+T` reopens the same tabs. `Cmd+Q` is the explicit quit path.
            let _ = entity.update(cx, |app, cx| {
                #[cfg(target_os = "macos")]
                crate::mac_front::set_window_visible(false);
                app.visible = false;
                app.report_focus(false, cx);
                app.emit(&HostEvent::Visibility { visible: false });
                cx.notify();
            });
            false
        });
    }

    fn handle_host_command(
        &mut self,
        command: HostCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if std::env::var_os("SPIKE_INPUT_DEBUG").is_some() {
            eprintln!("HOST COMMAND {command:?} visible={}", self.visible);
        }
        match command {
            HostCommand::Ping => {
                self.emit(&HostEvent::Ready {
                    pid: std::process::id(),
                    version: env!("CARGO_PKG_VERSION").to_string(),
                });
            }
            HostCommand::Show => self.set_visible(true, window, cx),
            HostCommand::Hide => self.set_visible(false, window, cx),
            HostCommand::Toggle => self.set_visible(!self.visible, window, cx),
            HostCommand::NewTab => {
                self.set_visible(true, window, cx);
                self.add_tab(cx);
                self.focus_handle.focus(window, cx);
            }
            HostCommand::Close => self.close_focused_pane(cx),
            HostCommand::SplitRight => self.split_focused(SplitDirection::Row, cx),
            HostCommand::SplitDown => self.split_focused(SplitDirection::Column, cx),
            HostCommand::Maximize => self.toggle_maximize_pane(cx),
            HostCommand::NextPane => self.navigate_pane(1, window, cx),
            HostCommand::PreviousPane => self.navigate_pane(-1, window, cx),
            HostCommand::NextTab => {
                if !self.tabs.is_empty() {
                    let index = (self.selected + 1) % self.tabs.len();
                    self.select_tab(index, window, cx);
                }
            }
            HostCommand::PreviousTab => {
                if !self.tabs.is_empty() {
                    let index = (self.selected + self.tabs.len() - 1) % self.tabs.len();
                    self.select_tab(index, window, cx);
                }
            }
            HostCommand::SelectTab { index } => self.select_tab(index, window, cx),
            HostCommand::Search => {
                let open = self.focused_pane().is_some_and(|pane| pane.search_open);
                if !open {
                    self.toggle_search(cx);
                }
            }
            HostCommand::Clear => self.clear_focused(cx),
            HostCommand::Copy => self.copy_selection(cx),
            HostCommand::Paste => self.paste(cx),
            HostCommand::Quit => cx.quit(),
        }
        self.emit_title();
    }

    fn emit(&self, event: &HostEvent) {
        if let Some(host) = self.host.as_ref() {
            host.emit(event);
        }
    }

    /// Publish the focused pane title so the host can mirror it in the Tauri
    /// window or a native notification. Only sent when it changes.
    fn emit_title(&mut self) {
        // Do not cache a title while disconnected: the pre-connect add_tab
        // would otherwise suppress the first title event after the host joins.
        if self.host.is_none() {
            return;
        }
        let Some(tab) = self.selected_tab() else {
            return;
        };
        let title = format!("{} · {}", self.selected + 1, tab.display_title());
        if self.last_host_title.as_deref() == Some(title.as_str()) {
            return;
        }
        self.last_host_title = Some(title.clone());
        self.emit(&HostEvent::Title { title });
    }

    fn start_clock(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(250))
                    .await;
                if this
                    .update(cx, |app, cx| {
                        let mut dirty = false;
                        if app
                            .toast
                            .as_ref()
                            .is_some_and(|(_, at)| at.elapsed() > TOAST_DURATION)
                        {
                            app.toast = None;
                            dirty = true;
                        }
                        app.cursor_phase = !app.cursor_phase;
                        let cursor_blinks = app
                            .tabs
                            .get_mut(app.selected)
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

    fn make_pane(
        demo: bool,
        id: String,
        cols: u16,
        rows: u16,
        fixture: Option<String>,
        cx: &mut Context<Self>,
    ) -> Pane {
        let mut model = match TerminalModel::new(cols, rows, 2_000_000) {
            Ok(model) => model,
            Err(error) => {
                eprintln!("terminal model: {error:#}");
                TerminalModel::new(80, 24, 1_000_000).expect("fallback terminal model")
            }
        };
        if let Some(fixture) = fixture {
            model.feed(fixture.as_bytes());
            return Pane {
                id,
                title: "spike · fixture".into(),
                model,
                pty: None,
                generation: None,
                exit: None,
                bell_count: 0,
                _task: None,
                metrics: TerminalMetrics::default(),
                selection_anchor: None,
                selecting: false,
                search_open: false,
                search_query: String::new(),
                search_info: SearchInfo::default(),
            };
        }
        if demo {
            model.feed(demo_second_tab().as_bytes());
            return Pane {
                id,
                title: "spike · demo".into(),
                model,
                pty: None,
                generation: None,
                exit: None,
                bell_count: 0,
                _task: None,
                metrics: TerminalMetrics::default(),
                selection_anchor: None,
                selecting: false,
                search_open: false,
                search_query: String::new(),
                search_info: SearchInfo::default(),
            };
        }

        let (events_tx, events_rx) = async_channel::bounded(1024);
        let cwd = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        let pty = match Pty::spawn(&cwd, cols, rows, events_tx) {
            Ok(pty) => pty,
            Err(error) => {
                model.feed(
                    format!("\x1b[31mCould not start shell: {error:#}\x1b[0m\r\n").as_bytes(),
                );
                return Pane {
                    id,
                    title: "shell failed".into(),
                    model,
                    pty: None,
                    generation: None,
                    exit: Some(None),
                    bell_count: 0,
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
                    .update(cx, |app, cx| app.on_pty_event(&pane_id, event, cx))
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
            bell_count: 0,
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
        let tab_id = uuid::Uuid::new_v4().to_string();
        let pane_id = format!("pane:{}", uuid::Uuid::new_v4());
        let fixture = self.demo.then(demo_fixture);
        let pane = Self::make_pane(self.demo, pane_id.clone(), 100, 30, fixture, cx);
        self.tabs.push(Tab {
            id: tab_id,
            layout: SplitNode::leaf(pane_id.clone()),
            focused: pane_id,
            maximized: None,
            panes: vec![pane],
        });
        self.selected = self.tabs.len() - 1;
        self.emit_title();
        cx.notify();
    }

    fn add_demo_tab(&mut self, cx: &mut Context<Self>) {
        let tab_id = uuid::Uuid::new_v4().to_string();
        let pane_id = format!("pane:{}", uuid::Uuid::new_v4());
        let pane = Self::make_pane(true, pane_id.clone(), 90, 26, None, cx);
        self.tabs.push(Tab {
            id: tab_id,
            layout: SplitNode::leaf(pane_id.clone()),
            focused: pane_id,
            maximized: None,
            panes: vec![pane],
        });
    }

    fn split_focused(&mut self, direction: SplitDirection, cx: &mut Context<Self>) {
        let Some(target) = self.selected_tab().map(|tab| tab.focused.clone()) else {
            return;
        };
        let pane_id = format!("pane:{}", uuid::Uuid::new_v4());
        let fixture = self.demo.then(demo_second_tab);
        let pane = Self::make_pane(self.demo, pane_id.clone(), 80, 24, fixture, cx);
        let Some(tab) = self.tabs.get_mut(self.selected) else {
            return;
        };
        tab.layout = tab.layout.split(&target, pane_id.clone(), direction);
        if std::env::var_os("SPIKE_INPUT_DEBUG").is_some() {
            eprintln!("SPLIT {direction:?} target={target} new={pane_id}");
        }
        tab.panes.push(pane);
        tab.focused = pane_id;
        tab.maximized = None;
        self.marked_text.clear();
        self.emit_title();
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
        if std::env::var_os("SPIKE_INPUT_DEBUG").is_some() {
            eprintln!("CLOSE PANE {pane_id}");
        }
        let remaining = tab.layout.leaves();
        tab.focused = remaining[removed_index.saturating_sub(1).min(remaining.len() - 1)].clone();
        tab.maximized = None;
        self.marked_text.clear();
        self.emit_title();
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
            if std::env::var_os("SPIKE_INPUT_DEBUG").is_some() {
                eprintln!("FOCUS PANE {pane_id}");
            }
            tab.focused = pane_id.to_string();
            self.marked_text.clear();
            // A maximized pane must follow pane navigation: the visible pane
            // is derived from `maximized`, not from the split tree.
            if tab.maximized.is_some() {
                tab.maximized = Some(pane_id.to_string());
            }
        }
        if let Some(old) = old_focused.filter(|old| old != pane_id) {
            self.send_focus_to(&old, false);
        }
        self.send_focus_to(pane_id, true);
        self.focus_handle.focus(window, cx);
        self.emit_title();
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

    fn toggle_maximize_pane(&mut self, cx: &mut Context<Self>) {
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
        self.emit_title();
        cx.notify();
    }

    fn on_pty_event(&mut self, pane_id: &str, event: PtyEvent, cx: &mut Context<Self>) {
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
                if std::env::var_os("SPIKE_INPUT_DEBUG").is_some() {
                    eprintln!(
                        "PTY OUT {:?}",
                        String::from_utf8_lossy(&data)
                            .replace('\r', "\\r")
                            .replace('\n', "\\n")
                    );
                }
                let effects = pane.model.feed(&data);
                if let Some(title) = effects.titles.last() {
                    pane.title = title.clone();
                }
                pane.bell_count += effects.bells;
                for bytes in effects.pty_writes {
                    if let Some(pty) = pane.pty.as_mut() {
                        let _ = pty.write(&bytes);
                    }
                }
                for text in effects.clipboard {
                    cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                    self.toast = Some(("OSC 52 clipboard updated".into(), Instant::now()));
                }
                if effects.bells > 0 {
                    self.toast = Some(("Bell".into(), Instant::now()));
                    let title = self
                        .focused_pane()
                        .map(|pane| pane.display_title(0))
                        .unwrap_or_default();
                    self.emit(&HostEvent::Bell { title });
                }
                if let Some((title, body)) = effects.notifications.last() {
                    self.toast = Some((
                        if title.is_empty() {
                            body.clone()
                        } else {
                            format!("{title}: {body}")
                        },
                        Instant::now(),
                    ));
                }
            }
            PtyEvent::Exit { status, .. } => {
                let code = status.or_else(|| pane.pty.as_mut().and_then(Pty::exit_code));
                pane.exit = Some(code);
                pane.title = match code {
                    Some(0) | None => "shell exited".into(),
                    Some(code) => format!("shell exited ({code})"),
                };
            }
        }
        self.emit_title();
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
            self.emit_title();
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
        self.emit_title();
        cx.notify();
    }

    fn toggle_visible(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.set_visible(!self.visible, window, cx);
    }

    /// Show/hide the native window itself. In host mode this orders the AppKit
    /// window in/out, activates the helper app on show, and tells the host to
    /// take focus back on hide.
    fn set_visible(&mut self, visible: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.visible == visible {
            if visible {
                window.activate_window();
                cx.activate(true);
                self.focus_handle.focus(window, cx);
            }
            return;
        }
        self.visible = visible;
        self.visible_since = visible.then(Instant::now);
        if std::env::var_os("SPIKE_INPUT_DEBUG").is_some() {
            eprintln!("SET VISIBLE {visible}");
        }
        if visible {
            #[cfg(target_os = "macos")]
            crate::mac_front::set_window_visible(true);
            window.activate_window();
            cx.activate(true);
            self.focus_handle.focus(window, cx);
        } else {
            self.report_focus(false, cx);
            #[cfg(target_os = "macos")]
            crate::mac_front::set_window_visible(false);
        }
        self.emit(&HostEvent::Visibility { visible });
        self.emit_title();
        cx.notify();
    }

    fn send_focus_to(&mut self, pane_id: &str, gained: bool) {
        let Some(pane) = self.pane_mut(pane_id) else {
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
        if !self.visible {
            return;
        }
        let Some(pane_id) = self.focused_pane().map(|pane| pane.id.clone()) else {
            return;
        };
        self.send_focus_to(&pane_id, gained);
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

    /// `Cmd+K` parity with Stacks' clear action: clear the visible screen
    /// without touching scrollback or the running program.
    fn clear_focused(&mut self, cx: &mut Context<Self>) {
        if let Some(pane) = self.focused_pane_mut() {
            let _ = pane.model.clear_selection();
            pane.model.feed(b"\x1b[2J\x1b[H");
            let _ = pane.model.scroll_to_bottom();
        }
        cx.notify();
    }

    fn copy_selection(&mut self, cx: &mut Context<Self>) {
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

    fn paste(&mut self, cx: &mut Context<Self>) {
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

    fn toggle_search(&mut self, cx: &mut Context<Self>) {
        let Some(pane) = self.focused_pane_mut() else {
            return;
        };
        pane.search_open = !pane.search_open;
        if std::env::var_os("SPIKE_INPUT_DEBUG").is_some() {
            eprintln!("SEARCH open={} pane={}", pane.search_open, pane.id);
        }
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
        let result = pane.model.search_set(&pane.search_query);
        pane.search_info = match result {
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

    fn handle_search_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) -> bool {
        let keystroke = &event.keystroke;
        if keystroke.key == "escape" {
            self.toggle_search(cx);
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

    fn handle_shortcut(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let modifiers = event.keystroke.modifiers;
        let key = event.keystroke.key.to_lowercase();
        if modifiers.platform && modifiers.alt && !modifiers.control {
            return match key.as_str() {
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
        }
        if !modifiers.platform || modifiers.control || modifiers.alt {
            return false;
        }
        if modifiers.shift {
            // Stacks' shortcuts, so the native window behaves like the Tauri
            // terminal when it owns the keyboard.
            match key.as_str() {
                "[" | "{" => {
                    self.navigate_pane(-1, window, cx);
                    return true;
                }
                "]" | "}" => {
                    self.navigate_pane(1, window, cx);
                    return true;
                }
                "enter" => {
                    self.toggle_maximize_pane(cx);
                    return true;
                }
                _ => {}
            }
        }
        match key.as_str() {
            "d" if modifiers.shift => {
                self.split_focused(SplitDirection::Column, cx);
                true
            }
            "d" => {
                self.split_focused(SplitDirection::Row, cx);
                true
            }
            "m" if modifiers.shift => {
                self.toggle_maximize_pane(cx);
                true
            }
            "t" if modifiers.shift => {
                self.visible = true;
                self.add_tab(cx);
                self.focus_handle.focus(window, cx);
                true
            }
            "t" => {
                // A host-driven show can hand focus here while the physical
                // Cmd+T key event (or its auto-repeat) is still in flight.
                // Treat that as the same key press, not a hide request.
                let just_shown = self
                    .visible_since
                    .is_some_and(|at| at.elapsed() < Duration::from_millis(600));
                if std::env::var_os("SPIKE_INPUT_DEBUG").is_some() {
                    eprintln!(
                        "HELPER CMD+T visible={} just_shown={just_shown} held={}",
                        self.visible, event.is_held
                    );
                }
                // Ignore auto-repeat while the key stays down, and ignore the
                // key macOS replays right after Stacks hands focus over.
                if !event.is_held && !(self.visible && just_shown) {
                    self.toggle_visible(window, cx);
                }
                true
            }
            "w" => {
                self.close_focused_pane(cx);
                true
            }
            "q" => {
                if self.host.is_some() {
                    // Stacks owns the confirm-quit flow and the rest of the app.
                    self.emit(&HostEvent::QuitRequested);
                    self.set_visible(false, window, cx);
                } else {
                    cx.quit();
                }
                true
            }
            "k" => {
                self.clear_focused(cx);
                true
            }
            "f" => {
                self.toggle_search(cx);
                true
            }
            "c" => {
                self.copy_selection(cx);
                true
            }
            "v" => {
                self.paste(cx);
                true
            }
            "[" => {
                if !self.tabs.is_empty() {
                    let index = (self.selected + self.tabs.len() - 1) % self.tabs.len();
                    self.select_tab(index, window, cx);
                }
                true
            }
            "]" => {
                if !self.tabs.is_empty() {
                    let index = (self.selected + 1) % self.tabs.len();
                    self.select_tab(index, window, cx);
                }
                true
            }
            key if key.len() == 1 && key.as_bytes()[0].is_ascii_digit() => {
                let index = key.parse::<usize>().unwrap_or(1).saturating_sub(1);
                self.select_tab(index, window, cx);
                true
            }
            _ => false,
        }
    }

    fn handle_key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.handle_shortcut(event, window, cx) {
            cx.stop_propagation();
            return;
        }
        if self.focused_pane().is_some_and(|pane| pane.search_open)
            && self.handle_search_key(event, cx)
        {
            cx.stop_propagation();
            return;
        }
        if !self.visible {
            return;
        }
        let keystroke = &event.keystroke;
        if std::env::var_os("SPIKE_INPUT_DEBUG").is_some() {
            eprintln!(
                "KEY key={:?} char={:?} mods={:?} focused={}",
                keystroke.key,
                keystroke.key_char,
                keystroke.modifiers,
                self.focus_handle.is_focused(window)
            );
        }
        if is_text_input_key(keystroke) {
            // US/Latin layouts go straight to the PTY. This makes plain typing
            // independent of whether the first-frame input handler registered.
            // IME layouts stay on GPUI/AppKit's text-input path so composition
            // and committed text are handled by EntityInputHandler.
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
        if !self.visible || event.keystroke.modifiers.platform {
            return;
        }
        let Some(key) = ghostty_key(&event.keystroke.key) else {
            return;
        };
        let mods = ghostty_mods(event.keystroke.modifiers);
        let Some(pane) = self.focused_pane_mut() else {
            return;
        };
        // The encoder produces nothing unless the running program enabled
        // Kitty's REPORT_EVENTS flag, so this is safe for legacy apps.
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
        if !self.visible {
            return;
        }
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
            self.copy_pane_selection(&pane_id, cx);
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
        let started = Instant::now();
        let focused = self.focused_pane().is_some_and(|pane| pane.id == pane_id);
        let marked = if focused {
            self.marked_text.clone()
        } else {
            String::new()
        };
        let cursor_phase = self.cursor_phase;
        let Some(pane) = self.pane_mut(pane_id) else {
            return PreparedFrame::default();
        };
        let (metrics, prepared) =
            prepare_frame(&mut pane.model, bounds, &marked, cursor_phase, window);
        pane.metrics = metrics;
        if let Some(pty) = pane.pty.as_mut()
            && let Err(error) = pty.resize(metrics.cols, metrics.rows)
        {
            eprintln!("PTY resize: {error:#}");
        }
        self.last_render = Some((Instant::now(), started.elapsed()));
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
                cx.listener(move |app, event, window, cx| {
                    app.mouse_down(pane_for_mouse.clone(), event, window, cx);
                }),
            )
            .on_mouse_move(cx.listener(move |app, event, window, cx| {
                app.mouse_move(pane_for_move.clone(), event, window, cx);
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(move |app, event, window, cx| {
                    app.mouse_up(pane_for_up.clone(), event, window, cx);
                }),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(move |app, event, window, cx| {
                    app.mouse_up(pane_for_up_out.clone(), event, window, cx);
                }),
            )
            .on_scroll(cx.listener(move |app, event, window, cx| {
                app.scroll_wheel(pane_for_scroll.clone(), event, window, cx);
            }))
            .child(
                canvas(
                    move |bounds, window, cx| {
                        prepared_entity.update(cx, |app, cx| {
                            app.prepare_terminal(&pane_for_prepare, bounds, window, cx)
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
                                .on_click(cx.listener(|app, _, _, cx| app.search_next(true, cx)))
                                .child("↑"),
                        )
                        .child(
                            div()
                                .id("search-next")
                                .px_1()
                                .cursor_pointer()
                                .text_color(rgb(0x8fb4d4))
                                .on_click(cx.listener(|app, _, _, cx| app.search_next(false, cx)))
                                .child("↓"),
                        )
                        .child(
                            div()
                                .id("search-close")
                                .px_1()
                                .cursor_pointer()
                                .text_color(rgb(0x93a7b8))
                                .on_click(cx.listener(|app, _, _, cx| app.toggle_search(cx)))
                                .child("×"),
                        ),
                )
            })
            .when(focused, |this| {
                this.when_some(self.toast.as_ref(), |this, (message, _)| {
                    this.child(
                        div()
                            .absolute()
                            .top(px(42.0))
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
                })
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
                    .on_click(cx.listener(move |app, _, window, cx| {
                        app.select_tab(index, window, cx);
                    }))
                    .child(format!("{}", index + 1))
                    .child(div().max_w(px(150.0)).truncate().child(tab.display_title()))
                    .when(tab.any_exit(), |this| {
                        this.child(div().text_color(rgb(0xb85c5c)).child("●"))
                    })
                    .when(tab_count > 1, |this| {
                        this.child(
                            div()
                                .id(("close-tab", index))
                                .px_1()
                                .rounded_sm()
                                .hover(|style| style.bg(rgb(0x3a2530)).text_color(rgb(0xe6b5bd)))
                                .on_click(cx.listener(move |app, _, _, cx| {
                                    cx.stop_propagation();
                                    app.close_tab(index, cx);
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
                    .on_click(cx.listener(|app, _, window, cx| {
                        app.add_tab(cx);
                        app.focus_handle.focus(window, cx);
                    }))
                    .child("+"),
            )
            .child(div().flex_1())
            .child(
                div()
                    .text_xs()
                    .text_color(rgb(0x62778a))
                    .child("⌘T hide · ⇧⌘T new · ⌘W close · ⇧⌘↩ maximize"),
            )
            .child(
                div()
                    .id("hide-terminal")
                    .size(px(26.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_md()
                    .cursor_pointer()
                    .text_color(rgb(0x93a7b8))
                    .hover(|style| style.bg(rgb(0x3a2530)).text_color(rgb(0xe6b5bd)))
                    .on_click(cx.listener(|app, _, window, cx| app.toggle_visible(window, cx)))
                    .child("×"),
            )
    }
}

impl Render for SpikeApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.raised {
            self.raised = true;
            if self.visible {
                window.activate_window();
            }
            if std::env::var_os("SPIKE_ON_TOP").is_some() {
                #[cfg(target_os = "macos")]
                crate::mac_front::raise_window();
            }
        }
        if self.visible && !self.focus_handle.is_focused(window) {
            window.focus(&self.focus_handle, cx);
            // The first frame may run before the focus tree owns the handle. Ask
            // for one more frame so the canvas can register its input handler.
            cx.notify();
        }
        div()
            .size_full()
            .flex()
            .flex_col()
            .track_focus(&self.focus_handle)
            .key_context("Spike")
            .on_key_down(cx.listener(Self::handle_key_down))
            .on_key_up(cx.listener(Self::handle_key_up))
            .bg(rgb(0x0f141b))
            .text_color(rgb(0xd7e1eb))
            .font_family(FONT_FAMILY)
            .children(if self.visible {
                Some(
                    div()
                        .size_full()
                        .flex()
                        .flex_col()
                        .child(self.render_tab_bar(cx))
                        .child(
                            div()
                                .flex_1()
                                .min_h_0()
                                .min_w_0()
                                .child(self.render_workspace(cx)),
                        ),
                )
            } else {
                Some(
                    div()
                        .size_full()
                        .flex()
                        .flex_col()
                        .items_center()
                        .justify_center()
                        .gap_3()
                        .child(
                            div()
                                .text_2xl()
                                .text_color(rgb(0xaebfd0))
                                .child("Stacks · GPUI terminal spike"),
                        )
                        .child(
                            div()
                                .text_sm()
                                .text_color(rgb(0x6f8497))
                                .child("Press ⌘T to open the global terminal"),
                        ),
                )
            })
    }
}

impl EntityInputHandler for SpikeApp {
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
        if std::env::var_os("SPIKE_INPUT_DEBUG").is_some() {
            eprintln!("IME COMMIT {text:?}");
        }
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
        Some(Bounds {
            origin: point(
                element_bounds.left() + px(PADDING + f32::from(cursor.x) * metrics.cell_width),
                element_bounds.top() + px(PADDING + f32::from(cursor.y) * metrics.cell_height),
            ),
            size: size(
                px(metrics.cell_width.max(1.0)),
                px(metrics.cell_height.max(1.0)),
            ),
        })
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
