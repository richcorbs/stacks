//! Application state machine: focus, screens, overlays and key dispatch.

use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use stacks_core::{
    CardDetail, CardSnapshot, CardStatus, CardSummary, DeliveryStep, Project, WorkGroup,
    WorkflowAction, WorkflowActionPresentation,
    diff::{DiffFile, GitReviewContext, ParsedDiff},
    pi,
    pty::{PtyEvent, PtySink},
    settings::{self, TuiPreferences},
};

use crate::{
    core_bridge::{self, Store},
    event::{CoreEvent, EventBus, EventSender},
    keys::{KEYMAP, Key},
    screens::terminal::TerminalWorkspace,
    split_tree::SplitDirection,
    theme::{self, ColorDepth, Theme},
    widgets::{TextArea, TextInput},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Board,
    Detail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DetailTab {
    Overview,
    Chat,
    Diff,
    Terminal,
    Work,
}

impl DetailTab {
    pub const ALL: [Self; 5] = [
        Self::Overview,
        Self::Chat,
        Self::Diff,
        Self::Terminal,
        Self::Work,
    ];

    pub fn index(self) -> usize {
        Self::ALL.iter().position(|tab| *tab == self).unwrap_or(0)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Overview => "Overview",
            Self::Chat => "Chat",
            Self::Diff => "Diff",
            Self::Terminal => "Terminal",
            Self::Work => "Work",
        }
    }

    pub fn thread(self) -> &'static str {
        if self == Self::Work {
            "work"
        } else {
            "planning"
        }
    }

    pub fn is_pi(self) -> bool {
        matches!(self, Self::Chat | Self::Work)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Board,
    Sidebar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pending {
    G,
    CtrlW,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Overlay {
    Help,
    Settings,
    Palette,
    Projects,
    Actions,
    NewCard,
    EditCard,
    FinishRefinement,
    Filter,
    GlobalTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoardRowKind {
    Group,
    Card,
}

#[derive(Debug, Clone)]
pub struct BoardRow {
    pub kind: BoardRowKind,
    pub group: WorkGroup,
    pub group_index: usize,
    pub card_id: Option<String>,
    pub label: String,
    pub count: usize,
    pub collapsed: bool,
    pub depth: usize,
    pub has_children: bool,
    pub expanded: bool,
}

#[derive(Debug, Clone)]
pub struct NewCardState {
    pub project_id: String,
    pub title: TextInput,
    pub content: TextArea,
    pub focus: usize,
}

#[derive(Debug, Clone)]
pub struct EditCardState {
    pub card_id: String,
    pub revision: i64,
    pub title: TextInput,
    pub content: TextArea,
    pub focus: usize,
}

#[derive(Debug, Clone)]
pub struct RefinementState {
    pub card_id: String,
    pub revision: i64,
    pub content: TextArea,
}

#[derive(Debug, Clone)]
pub struct PaletteItem {
    pub id: String,
    pub label: String,
    pub hint: String,
    pub action: PaletteAction,
}

#[derive(Debug, Clone)]
pub enum PaletteAction {
    Key(Key),
    Card(String),
    Project(String),
}

#[derive(Debug, Clone)]
pub struct ConfirmAction {
    pub title: String,
    pub detail: String,
    pub primary_label: String,
    pub destructive: bool,
    pub workflow: Option<WorkflowRun>,
}

#[derive(Debug, Clone)]
pub struct WorkflowRun {
    pub card_id: String,
    pub action: WorkflowAction,
    pub revision: i64,
    pub feature_environment: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmOutcome {
    Pending,
    Confirmed,
    Cancelled,
}

pub struct Confirm {
    pub title: String,
    pub detail: String,
    pub primary_label: String,
    pub destructive: bool,
    started: Instant,
    delay: Duration,
    pub focus_primary: bool,
    payload: Option<ConfirmAction>,
}

impl Confirm {
    fn new(action: ConfirmAction, delay: Duration) -> Self {
        Self {
            title: action.title.clone(),
            detail: action.detail.clone(),
            primary_label: action.primary_label.clone(),
            destructive: action.destructive,
            started: Instant::now(),
            delay,
            focus_primary: false,
            payload: Some(action),
        }
    }

    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    pub fn ready(&self) -> bool {
        self.started.elapsed() >= self.delay
    }

    pub fn countdown(&self) -> String {
        let remaining = self.delay.saturating_sub(self.started.elapsed());
        format!("{:.1}s", remaining.as_secs_f32().max(0.0))
    }

    pub fn toggle_focus(&mut self) {
        self.focus_primary = !self.focus_primary;
    }

    pub fn outcome(&self) -> ConfirmOutcome {
        if !self.ready() {
            ConfirmOutcome::Pending
        } else if self.focus_primary {
            ConfirmOutcome::Confirmed
        } else {
            ConfirmOutcome::Cancelled
        }
    }

    fn into_action(mut self) -> ConfirmAction {
        self.payload
            .take()
            .expect("confirmation payload is present until confirmed")
    }
}

#[derive(Debug, Default)]
pub struct DiffState {
    pub files: Vec<DiffFile>,
    pub selected: usize,
    pub reviewed: HashSet<String>,
    pub collapsed_dirs: HashSet<String>,
    pub context: Option<GitReviewContext>,
    pub parsed: Option<ParsedDiff>,
    pub path: Option<String>,
    pub scroll: u16,
    pub hunk: usize,
    pub visual: Option<usize>,
}

pub struct GlobalTab {
    pub title: String,
    pub workspace: TerminalWorkspace,
}

pub struct App {
    pub store: Store,
    pub events: EventBus,
    pub sender: EventSender,
    pub depth: ColorDepth,
    pub theme: Theme,
    pub automation_socket: PathBuf,

    pub board: Option<CardSnapshot>,
    pub loading_board: bool,
    pub board_rows: Vec<BoardRow>,
    pub board_cursor: usize,
    pub sidebar_visible: bool,
    pub sidebar_cursor: usize,
    pub project_scope: Option<String>,
    pub filter: String,
    pub hide_done: bool,
    pub collapsed_groups: [bool; 4],
    pub collapsed_parents: HashSet<String>,
    pub focus: Focus,

    pub screen: Screen,
    pub detail_tab: DetailTab,
    pub detail: Option<CardDetail>,
    pub detail_loading: bool,
    pub selected_card: Option<String>,
    pub detail_scroll: u16,

    pub overlay: Option<Overlay>,
    pub confirm: Option<Confirm>,
    pub actions: Vec<WorkflowActionPresentation>,
    pub action_cursor: usize,
    pub pending: Option<Pending>,
    pub quit: bool,

    pub new_card: Option<NewCardState>,
    pub new_card_draft: Option<(String, String, String)>,
    pub edit_card: Option<EditCardState>,
    pub refinement: Option<RefinementState>,
    pub filter_input: TextInput,
    pub palette_query: TextInput,
    pub palette_items: Vec<PaletteItem>,
    pub palette_cursor: usize,
    pub project_query: TextInput,
    pub project_picker_cursor: usize,
    pub usage: BTreeMap<String, u64>,

    pub diff: DiffState,
    pub terminals: TerminalWorkspace,
    pub chat: TerminalWorkspace,
    pub work: TerminalWorkspace,
    pub terminal_focus: bool,
    pub global_tabs: Vec<GlobalTab>,
    pub global_active: usize,
    pub global_terminal_focus: bool,

    pub preferences: TuiPreferences,
    pub settings_cursor: usize,
    pub help_scroll: u16,
    pub message: String,
    pub error: Option<String>,
    pub in_flight: usize,
    pub started: Instant,
    pub cols: u16,
    pub rows: u16,
    pub headless: bool,
}

impl App {
    pub fn new(
        store: Store,
        automation_socket: PathBuf,
        board: Option<CardSnapshot>,
        headless: bool,
    ) -> Self {
        let settings = settings::load();
        let preferences = settings.tui_preferences();
        let depth = theme::detect_depth();
        let accent = preferences.accent.clone();
        let bus = EventBus::new();
        let sender = bus.sender();
        let database_missing = !store.exists();
        let mut app = Self {
            store,
            events: bus,
            sender,
            depth,
            theme: theme::theme(depth, accent.as_deref()),
            automation_socket,
            board,
            loading_board: false,
            board_rows: Vec::new(),
            board_cursor: 0,
            sidebar_visible: true,
            sidebar_cursor: 0,
            project_scope: None,
            filter: String::new(),
            hide_done: preferences.hide_done,
            collapsed_groups: [false, false, false, true],
            collapsed_parents: HashSet::new(),
            focus: Focus::Board,
            screen: Screen::Board,
            detail_tab: DetailTab::Overview,
            detail: None,
            detail_loading: false,
            selected_card: None,
            detail_scroll: 0,
            overlay: None,
            confirm: None,
            actions: Vec::new(),
            action_cursor: 0,
            pending: None,
            quit: false,
            new_card: None,
            new_card_draft: None,
            edit_card: None,
            refinement: None,
            filter_input: TextInput::default(),
            palette_query: TextInput::default(),
            palette_items: Vec::new(),
            palette_cursor: 0,
            project_query: TextInput::default(),
            project_picker_cursor: 0,
            usage: settings.command_usage_counts.clone().unwrap_or_default(),
            diff: DiffState::default(),
            terminals: TerminalWorkspace::new("card"),
            chat: TerminalWorkspace::new("card-chat"),
            work: TerminalWorkspace::new("card-work"),
            terminal_focus: false,
            global_tabs: Vec::new(),
            global_active: 0,
            global_terminal_focus: true,
            preferences,
            settings_cursor: 0,
            help_scroll: 0,
            message: if database_missing {
                "No Stacks database found. Use --db to point at workflow.sqlite3.".into()
            } else {
                "Ready".into()
            },
            error: None,
            in_flight: 0,
            started: Instant::now(),
            cols: 120,
            rows: 40,
            headless,
        };
        app.recompute_rows();
        app.board_cursor = app.first_card_cursor().unwrap_or(0);
        app
    }

    pub fn refresh_board(&mut self) {
        self.loading_board = true;
        self.in_flight += 1;
        core_bridge::load_board(Arc::clone(&self.store), self.sender.clone());
    }

    pub fn open_detail(&mut self, card_id: String) {
        self.selected_card = Some(card_id.clone());
        self.screen = Screen::Detail;
        self.detail = None;
        self.detail_tab = DetailTab::Overview;
        self.detail_scroll = 0;
        self.diff = DiffState::default();
        self.load_detail(card_id);
    }

    fn load_detail(&mut self, card_id: String) {
        self.detail_loading = true;
        self.in_flight += 1;
        core_bridge::load_detail(Arc::clone(&self.store), card_id, self.sender.clone());
    }

    pub fn close_detail(&mut self) {
        self.screen = Screen::Board;
        self.detail = None;
        self.actions.clear();
        self.overlay = None;
        self.stop_card_sessions();
        self.detail_scroll = 0;
        self.pending = None;
        self.terminal_focus = false;
    }

    fn stop_card_sessions(&mut self) {
        self.chat.close_all();
        self.work.close_all();
        self.terminals.close_all();
        self.terminal_focus = false;
    }

    pub fn recompute_rows(&mut self) {
        let Some(board) = self.board.as_ref() else {
            self.board_rows.clear();
            self.board_cursor = 0;
            return;
        };
        let mut rows = Vec::new();
        let filter = self.filter.to_ascii_lowercase();
        let filtering = !filter.is_empty();
        for (group_index, group) in WorkGroup::ALL.into_iter().enumerate() {
            if self.hide_done && group == WorkGroup::Done && !filtering {
                continue;
            }
            let mut cards = stacks_core::group_cards(&board.cards, group, &board.projects)
                .into_iter()
                .filter(|card| {
                    if let Some(scope) = self.project_scope.as_deref() {
                        if card.project_id.as_deref() != Some(scope) {
                            return false;
                        }
                    }
                    if filter.is_empty() {
                        return true;
                    }
                    let project = card
                        .project(&board.projects)
                        .map(|project| project.name.to_ascii_lowercase())
                        .unwrap_or_default();
                    card.title.to_ascii_lowercase().contains(&filter)
                        || card.external_id.contains(&filter)
                        || card.id.to_ascii_lowercase().contains(&filter)
                        || project.contains(&filter)
                })
                .cloned()
                .collect::<Vec<_>>();
            cards.sort_by(|left, right| {
                left.sort_order
                    .cmp(&right.sort_order)
                    .then(left.created_at.cmp(&right.created_at))
                    .then(left.id.cmp(&right.id))
            });
            // A search must reveal matches even inside a collapsed Done/Backlog
            // group; otherwise a valid card looks like "no cards match".
            let collapsed = self.collapsed_groups[group_index] && !filtering;
            rows.push(BoardRow {
                kind: BoardRowKind::Group,
                group,
                group_index,
                card_id: None,
                label: group.label().to_string(),
                count: cards.len(),
                collapsed,
                depth: 0,
                has_children: false,
                expanded: !collapsed,
            });
            if collapsed {
                continue;
            }
            let card_ids = cards
                .iter()
                .map(|card| card.id.clone())
                .collect::<HashSet<_>>();
            for card in &cards {
                if let Some(parent) = card.parent.as_ref() {
                    if self.collapsed_parents.contains(&parent.id) && card_ids.contains(&parent.id)
                    {
                        continue;
                    }
                }
                rows.push(BoardRow {
                    kind: BoardRowKind::Card,
                    group,
                    group_index,
                    card_id: Some(card.id.clone()),
                    label: card.title.clone(),
                    count: 0,
                    collapsed: false,
                    depth: usize::from(card.parent.is_some()),
                    has_children: !card.children.is_empty(),
                    expanded: !self.collapsed_parents.contains(&card.id),
                });
            }
        }
        if !rows.iter().any(|row| row.kind == BoardRowKind::Card) {
            rows.clear();
        }
        self.board_rows = rows;
        self.board_cursor = self
            .board_cursor
            .min(self.board_rows.len().saturating_sub(1));
        if self.board_rows.is_empty() {
            self.board_cursor = 0;
        }
    }

    fn first_card_cursor(&self) -> Option<usize> {
        self.board_rows
            .iter()
            .position(|row| row.kind == BoardRowKind::Card)
    }

    pub fn selected_board_card(&self) -> Option<&CardSummary> {
        let row = self.board_rows.get(self.board_cursor)?;
        let id = row.card_id.as_deref()?;
        self.board.as_ref()?.cards.iter().find(|card| card.id == id)
    }

    pub fn selected_project(&self) -> Option<&Project> {
        let board = self.board.as_ref()?;
        board
            .projects
            .iter()
            .find(|project| Some(project.id.as_str()) == self.project_scope.as_deref())
    }

    pub fn detail_project(&self) -> Option<&Project> {
        let detail = self.detail.as_ref()?;
        detail
            .card
            .project(self.board.as_ref()?.projects.as_slice())
    }

    pub fn project_count(&self, project_id: &str) -> usize {
        self.board
            .as_ref()
            .map(|board| {
                board
                    .cards
                    .iter()
                    .filter(|card| card.project_id.as_deref() == Some(project_id))
                    .count()
            })
            .unwrap_or(0)
    }

    pub fn apply_preferences(&mut self) {
        let settings = settings::load();
        self.usage = settings.command_usage_counts.clone().unwrap_or_default();
        self.preferences = settings.tui_preferences();
        self.theme = theme::theme(self.depth, self.preferences.accent.as_deref());
    }

    pub fn save_preferences(&mut self) {
        if let Err(error) = settings::save_tui_preferences(&self.preferences) {
            self.error = Some(format!("Could not save settings: {error}"));
        }
        self.apply_preferences();
    }

    // ---- core events -------------------------------------------------

    pub fn handle_core_event(&mut self, event: CoreEvent) {
        match event {
            CoreEvent::Board(result) => {
                self.loading_board = false;
                self.in_flight = self.in_flight.saturating_sub(1);
                match result {
                    Ok(board) => {
                        self.board = Some(board);
                        self.error = None;
                        self.recompute_rows();
                    }
                    Err(error) => self.error = Some(error),
                }
            }
            CoreEvent::Detail { card_id, result } => {
                self.detail_loading = false;
                self.in_flight = self.in_flight.saturating_sub(1);
                if self.selected_card.as_deref() != Some(card_id.as_str()) {
                    return;
                }
                match result {
                    Ok(detail) => {
                        self.actions = detail.capabilities.clone();
                        self.detail = Some(detail);
                        self.error = None;
                        if self.detail_tab == DetailTab::Diff {
                            self.refresh_diff();
                        }
                        if self.detail_tab.is_pi() {
                            self.ensure_pi_pane(self.detail_tab);
                        }
                    }
                    Err(error) => self.error = Some(error),
                }
            }
            CoreEvent::Action {
                card_id,
                action,
                result,
            } => {
                self.in_flight = self.in_flight.saturating_sub(1);
                match result {
                    Ok(()) => {
                        self.message = format!("{} done", action.label());
                        self.error = None;
                        self.refresh_board();
                        if self.selected_card.as_deref() == Some(card_id.as_str()) {
                            self.load_detail(card_id.clone());
                        }
                        if matches!(
                            action,
                            WorkflowAction::Close
                                | WorkflowAction::Delete
                                | WorkflowAction::MergePr
                                | WorkflowAction::MergeLocal
                        ) {
                            self.stop_card_sessions();
                            if action == WorkflowAction::Close {
                                let _ = self.store.complete_local_runtime_cleanup(&card_id, &[]);
                            }
                        }
                    }
                    Err(error) => {
                        self.error = Some(error);
                        self.refresh_board();
                    }
                }
            }
            CoreEvent::DiffFiles { card_id, result } => {
                self.in_flight = self.in_flight.saturating_sub(1);
                if self.selected_card.as_deref() != Some(card_id.as_str()) {
                    return;
                }
                match result {
                    Ok((files, context)) => {
                        self.diff.files = files;
                        self.diff.context = Some(context);
                        self.diff.selected = 0;
                        self.diff.parsed = None;
                        self.diff.path = None;
                        self.diff.hunk = 0;
                        self.diff.scroll = 0;
                        if !self.diff.files.is_empty() {
                            self.open_diff_file(0);
                        }
                        self.error = None;
                    }
                    Err(error) => self.error = Some(error),
                }
            }
            CoreEvent::FileDiff { path, result } => {
                self.in_flight = self.in_flight.saturating_sub(1);
                if self
                    .diff
                    .files
                    .get(self.diff.selected)
                    .map(|file| file.path.as_str())
                    != Some(path.as_str())
                {
                    return;
                }
                match result {
                    Ok(diff) => {
                        self.diff.parsed = Some(stacks_core::diff::parse_unified(&diff));
                        self.diff.path = Some(path);
                        self.diff.scroll = 0;
                        self.diff.hunk = 0;
                        self.error = None;
                    }
                    Err(error) => self.error = Some(error),
                }
            }
            CoreEvent::Reorder(result) => {
                self.in_flight = self.in_flight.saturating_sub(1);
                match result {
                    Ok(()) => {
                        self.message = "Reordered".into();
                        self.refresh_board();
                    }
                    Err(error) => self.error = Some(error),
                }
            }
            CoreEvent::Created(result) => {
                self.in_flight = self.in_flight.saturating_sub(1);
                match result {
                    Ok(card_id) => {
                        self.message = "Card created".into();
                        self.new_card = None;
                        self.new_card_draft = None;
                        self.overlay = None;
                        self.refresh_board();
                        self.open_detail(card_id);
                    }
                    Err(error) => self.error = Some(error),
                }
            }
            CoreEvent::Edited(result) => {
                self.in_flight = self.in_flight.saturating_sub(1);
                match result {
                    Ok(()) => {
                        self.message = "Saved".into();
                        self.error = None;
                        self.edit_card = None;
                        self.refinement = None;
                        self.overlay = None;
                        self.refresh_board();
                        if let Some(card_id) = self.selected_card.clone() {
                            self.load_detail(card_id);
                        }
                    }
                    Err(error) => self.error = Some(error),
                }
            }
            CoreEvent::AutomationChanged { card_id, message } => {
                self.message = message;
                self.refresh_board();
                if self.selected_card.as_deref() == Some(card_id.as_str()) {
                    self.load_detail(card_id);
                }
            }
            CoreEvent::Pty { pane, event } => match event {
                PtyEvent::Data {
                    terminal_id,
                    generation,
                    data,
                } => {
                    let pane = if terminal_id.is_empty() {
                        pane
                    } else {
                        terminal_id
                    };
                    for workspace in self.workspaces_mut() {
                        workspace.feed(&pane, &generation, &data);
                    }
                }
                PtyEvent::Exit {
                    terminal_id,
                    generation,
                    status,
                } => {
                    let pane = if terminal_id.is_empty() {
                        pane
                    } else {
                        terminal_id
                    };
                    for workspace in self.workspaces_mut() {
                        workspace.exited(&pane, &generation, status);
                    }
                }
            },
            CoreEvent::Toast(message) => self.message = message,
            CoreEvent::Notice(message) => self.message = message,
        }
    }

    fn workspaces_mut(&mut self) -> Vec<&mut TerminalWorkspace> {
        let mut workspaces = vec![&mut self.terminals, &mut self.chat, &mut self.work];
        for tab in &mut self.global_tabs {
            workspaces.push(&mut tab.workspace);
        }
        workspaces
    }

    // ---- key dispatch ------------------------------------------------

    pub fn handle_key(&mut self, key: Key) {
        self.error = None;
        if self.confirm.is_some() {
            self.handle_confirm_key(key);
            return;
        }
        if let Some(overlay) = self.overlay.clone() {
            if self.handle_overlay_key(overlay, key.clone()) {
                return;
            }
        }
        if let Some(pending) = self.pending.take() {
            match pending {
                Pending::G => {
                    if key == Key::Char('g') {
                        self.scroll_to_top();
                        return;
                    }
                }
                Pending::CtrlW => {
                    if self.handle_pane_prefix(key.clone()) {
                        return;
                    }
                }
            }
        }
        if key == Key::Ctrl('q') {
            self.request_quit();
            return;
        }
        if self.terminal_owns_keyboard() {
            self.handle_terminal_key(key);
            return;
        }
        match key {
            Key::Char('?') => {
                self.overlay = Some(Overlay::Help);
                self.help_scroll = 0;
            }
            Key::Ctrl('p') | Key::Char(':') => self.open_palette(),
            Key::Ctrl('o') => self.open_projects(),
            Key::Ctrl('g') => self.toggle_global_terminal(),
            Key::Ctrl('r') => self.refresh_board(),
            Key::Ctrl(',') => self.overlay = Some(Overlay::Settings),
            Key::Ctrl('b') => self.sidebar_visible = !self.sidebar_visible,
            _ => match self.screen {
                Screen::Board => self.handle_board_key(key),
                Screen::Detail => self.handle_detail_key(key),
            },
        }
    }

    pub fn handle_paste(&mut self, text: String) {
        self.handle_key(Key::Paste(text));
    }

    fn terminal_owns_keyboard(&self) -> bool {
        if self.overlay.is_some() {
            return false;
        }
        if self.screen != Screen::Detail {
            return false;
        }
        if !self.terminal_focus {
            return false;
        }
        matches!(
            self.detail_tab,
            DetailTab::Terminal | DetailTab::Chat | DetailTab::Work
        ) && !self.active_workspace().is_empty()
    }

    fn active_workspace(&self) -> &TerminalWorkspace {
        match (self.screen, self.detail_tab) {
            (Screen::Detail, DetailTab::Terminal) => &self.terminals,
            (Screen::Detail, DetailTab::Chat) => &self.chat,
            (Screen::Detail, DetailTab::Work) => &self.work,
            _ => self
                .global_tabs
                .get(self.global_active)
                .map(|tab| &tab.workspace)
                .unwrap_or(&self.terminals),
        }
    }

    pub fn active_workspace_mut(&mut self) -> &mut TerminalWorkspace {
        match (self.screen, self.detail_tab) {
            (Screen::Detail, DetailTab::Terminal) => &mut self.terminals,
            (Screen::Detail, DetailTab::Chat) => &mut self.chat,
            (Screen::Detail, DetailTab::Work) => &mut self.work,
            _ => {
                let index = self
                    .global_active
                    .min(self.global_tabs.len().saturating_sub(1));
                if self.global_tabs.is_empty() {
                    return &mut self.terminals;
                }
                &mut self.global_tabs[index].workspace
            }
        }
    }

    fn scroll_to_top(&mut self) {
        match self.screen {
            Screen::Board => self.board_cursor = 0,
            Screen::Detail => match self.detail_tab {
                DetailTab::Diff => {
                    self.diff.scroll = 0;
                    self.diff.hunk = 0;
                }
                DetailTab::Terminal | DetailTab::Chat | DetailTab::Work => {
                    let workspace = self.active_workspace_mut();
                    if let Some(pane) = workspace.focused_pane_mut() {
                        pane.screen.scroll(usize::MAX / 2);
                    }
                }
                DetailTab::Overview => self.detail_scroll = 0,
            },
        }
    }

    fn handle_board_key(&mut self, key: Key) {
        match key {
            Key::Char('j') | Key::Down => self.move_board(1),
            Key::Char('k') | Key::Up => self.move_board(-1),
            Key::Char('g') => self.pending = Some(Pending::G),
            Key::Char('G') => {
                self.board_cursor = self.board_rows.len().saturating_sub(1);
            }
            Key::Ctrl('d') => self.move_board(10),
            Key::Ctrl('u') => self.move_board(-10),
            Key::Ctrl('a') => {
                self.hide_done = !self.hide_done;
                self.preferences.hide_done = self.hide_done;
                self.save_preferences();
                self.recompute_rows();
            }
            Key::Char('/') => {
                self.filter_input = TextInput::new(self.filter.clone());
                self.overlay = Some(Overlay::Filter);
            }
            Key::Ctrl('f') => self.cycle_project_scope(),
            Key::Enter if self.focus == Focus::Sidebar => {
                let index = self.sidebar_cursor;
                self.project_scope = if index == 0 {
                    None
                } else {
                    self.board
                        .as_ref()
                        .and_then(|board| board.projects.get(index - 1))
                        .map(|project| project.id.clone())
                };
                self.recompute_rows();
                self.focus = Focus::Sidebar;
                self.message = match self.selected_project() {
                    Some(project) => format!("Project filter: {}", project.name),
                    None => "Project filter: all projects".into(),
                };
            }
            Key::Char('l') | Key::Right | Key::Esc if self.focus == Focus::Sidebar => {
                self.focus = Focus::Board;
            }
            Key::Enter => {
                if let Some(row) = self.board_rows.get(self.board_cursor).cloned() {
                    match row.kind {
                        BoardRowKind::Group => {
                            self.collapsed_groups[row.group_index] =
                                !self.collapsed_groups[row.group_index];
                            self.recompute_rows();
                        }
                        BoardRowKind::Card => {
                            if let Some(card_id) = row.card_id {
                                self.open_detail(card_id);
                            }
                        }
                    }
                }
            }
            Key::Char('h') | Key::Left => {
                if let Some(row) = self.board_rows.get(self.board_cursor).cloned() {
                    match row.kind {
                        BoardRowKind::Group => {
                            self.collapsed_groups[row.group_index] = true;
                            self.recompute_rows();
                        }
                        BoardRowKind::Card if row.has_children && row.expanded => {
                            self.collapsed_parents
                                .insert(row.card_id.clone().unwrap_or_default());
                            self.recompute_rows();
                        }
                        BoardRowKind::Card => self.focus_sidebar(),
                    }
                }
            }
            Key::Char('l') | Key::Right => {
                if let Some(row) = self.board_rows.get(self.board_cursor).cloned() {
                    match row.kind {
                        BoardRowKind::Group => {
                            self.collapsed_groups[row.group_index] = false;
                            self.recompute_rows();
                        }
                        BoardRowKind::Card if row.has_children && !row.expanded => {
                            self.collapsed_parents
                                .remove(row.card_id.as_deref().unwrap_or_default());
                            self.recompute_rows();
                        }
                        BoardRowKind::Card => {}
                    }
                }
            }
            Key::Char('n') => self.start_new_card(),
            Key::Char('J') => self.reorder(1),
            Key::Char('K') => self.reorder(-1),
            Key::Tab => {
                if self.focus == Focus::Sidebar {
                    self.focus = Focus::Board;
                } else {
                    self.focus_sidebar();
                }
            }
            _ => {}
        }
    }

    fn focus_sidebar(&mut self) {
        self.focus = Focus::Sidebar;
        let index = self
            .board
            .as_ref()
            .and_then(|board| {
                self.project_scope.as_deref().and_then(|scope| {
                    board
                        .projects
                        .iter()
                        .position(|project| project.id == scope)
                        .map(|index| index + 1)
                })
            })
            .unwrap_or(0);
        self.sidebar_cursor = index;
        self.message = "PROJECTS · j/k move · Enter filter · Esc back".into();
    }

    fn move_board(&mut self, delta: i32) {
        if self.board_rows.is_empty() {
            return;
        }
        if self.focus == Focus::Sidebar {
            let count = self
                .board
                .as_ref()
                .map(|board| board.projects.len() + 1)
                .unwrap_or(1);
            let next = self.sidebar_cursor as i32 + delta;
            self.sidebar_cursor = next.clamp(0, count as i32 - 1) as usize;
            self.message = self
                .sidebar_cursor_label()
                .unwrap_or_else(|| "PROJECTS".into());
            return;
        }
        let last = self.board_rows.len().saturating_sub(1) as i32;
        self.board_cursor = (self.board_cursor as i32 + delta).clamp(0, last) as usize;
    }

    fn sidebar_cursor_label(&self) -> Option<String> {
        let board = self.board.as_ref()?;
        if self.sidebar_cursor == 0 {
            return Some("▶ All projects".into());
        }
        board
            .projects
            .get(self.sidebar_cursor.saturating_sub(1))
            .map(|project| format!("▶ {}", project.name))
    }

    fn cycle_project_scope(&mut self) {
        let Some(board) = self.board.as_ref() else {
            return;
        };
        let mut ids: Vec<Option<String>> = vec![None];
        ids.extend(
            board
                .projects
                .iter()
                .map(|project| Some(project.id.clone())),
        );
        let current = ids
            .iter()
            .position(|id| id.as_deref() == self.project_scope.as_deref())
            .unwrap_or(0);
        let next = (current + 1) % ids.len();
        self.project_scope = ids[next].clone();
        self.sidebar_cursor = next;
        self.recompute_rows();
        self.message = match self.selected_project() {
            Some(project) => format!("Scope: {}", project.name),
            None => "Scope: all projects".into(),
        };
    }

    fn reorder(&mut self, delta: i32) {
        let Some(card) = self.selected_board_card().cloned() else {
            return;
        };
        if card.status != CardStatus::NeedsRefinement {
            self.message = "Reorder is available in the Backlog (needs refinement)".into();
            return;
        }
        let Some(board) = self.board.as_ref() else {
            return;
        };
        let ordered = stacks_core::grouping::backlog_cards(board)
            .into_iter()
            .map(|card| card.id.clone())
            .collect::<Vec<_>>();
        let Some(index) = ordered.iter().position(|id| *id == card.id) else {
            return;
        };
        let target = index as i32 + delta;
        if target < 0 || target >= ordered.len() as i32 {
            return;
        }
        let mut next = ordered.clone();
        next.swap(index, target as usize);
        self.in_flight += 1;
        self.message = "Reordering…".into();
        core_bridge::reorder_backlog(Arc::clone(&self.store), ordered, next, self.sender.clone());
    }

    fn handle_detail_key(&mut self, key: Key) {
        match key {
            Key::Esc => {
                if self.detail_tab.is_pi() && self.terminal_focus {
                    self.terminal_focus = false;
                    self.message = "NORMAL — i to focus Pi, Esc to go back".into();
                    return;
                }
                if self.detail_tab == DetailTab::Terminal && self.terminal_focus {
                    self.terminal_focus = false;
                    self.message = "NORMAL — i to focus terminal, Esc to go back".into();
                    return;
                }
                self.close_detail();
            }
            Key::Char('1') => self.select_tab(DetailTab::Overview),
            Key::Char('2') => self.select_tab(DetailTab::Chat),
            Key::Char('3') => self.select_tab(DetailTab::Diff),
            Key::Char('4') => self.select_tab(DetailTab::Terminal),
            Key::Char('5') => self.select_tab(DetailTab::Work),
            Key::Tab => {
                let next = (self.detail_tab.index() + 1) % DetailTab::ALL.len();
                self.select_tab(DetailTab::ALL[next]);
            }
            Key::BackTab => {
                let next =
                    (self.detail_tab.index() + DetailTab::ALL.len() - 1) % DetailTab::ALL.len();
                self.select_tab(DetailTab::ALL[next]);
            }
            Key::Char('a') => self.open_actions(),
            Key::Char('e') => self.start_edit_card(),
            Key::Char('j') | Key::Down => self.scroll_detail(1),
            Key::Char('k') | Key::Up => self.scroll_detail(-1),
            Key::PageDown | Key::Ctrl('d') => self.scroll_detail(10),
            Key::PageUp | Key::Ctrl('u') => self.scroll_detail(-10),
            Key::Char('g') => self.pending = Some(Pending::G),
            Key::Char('G') => {
                if self.detail_tab == DetailTab::Diff {
                    if let Some(parsed) = self.diff.parsed.as_ref() {
                        self.diff.scroll = parsed.lines.len().saturating_sub(1) as u16;
                    }
                } else if self.detail_tab.is_pi() || self.detail_tab == DetailTab::Terminal {
                    let workspace = self.active_workspace_mut();
                    if let Some(pane) = workspace.focused_pane_mut() {
                        pane.screen.scroll(0);
                    }
                } else {
                    self.detail_scroll = u16::MAX / 2;
                }
            }
            Key::Char('i') | Key::Enter
                if self.detail_tab.is_pi() || self.detail_tab == DetailTab::Terminal =>
            {
                self.terminal_focus = true;
            }
            Key::Char('r')
                if self.detail_tab.is_pi()
                    && !self.active_workspace().is_empty()
                    && self
                        .active_workspace()
                        .panes
                        .values()
                        .all(|pane| !pane.alive()) =>
            {
                self.stop_pi_workspace(self.detail_tab);
                self.ensure_pi_pane(self.detail_tab);
            }
            _ => match self.detail_tab {
                DetailTab::Diff => self.handle_diff_key(key),
                DetailTab::Terminal => {
                    self.handle_terminal_key(key);
                }
                DetailTab::Chat | DetailTab::Work => {
                    if self.handle_terminal_key(key) {
                        return;
                    }
                }
                DetailTab::Overview => {}
            },
        }
    }

    fn select_tab(&mut self, tab: DetailTab) {
        if self.detail_tab != tab {
            self.detail_tab = tab;
            self.detail_scroll = 0;
            self.pending = None;
        }
        match tab {
            DetailTab::Diff => {
                self.terminal_focus = false;
                self.refresh_diff();
            }
            DetailTab::Terminal => {
                self.ensure_card_terminal();
                self.terminal_focus = true;
            }
            DetailTab::Chat | DetailTab::Work => {
                self.ensure_pi_pane(tab);
                self.terminal_focus = true;
            }
            DetailTab::Overview => self.terminal_focus = false,
        }
    }

    fn scroll_detail(&mut self, delta: i32) {
        match self.detail_tab {
            DetailTab::Diff => {
                if delta > 0 {
                    self.diff.scroll = self.diff.scroll.saturating_add(delta as u16);
                } else {
                    self.diff.scroll = self.diff.scroll.saturating_sub((-delta) as u16);
                }
            }
            DetailTab::Terminal | DetailTab::Chat | DetailTab::Work => {
                let workspace = self.active_workspace_mut();
                workspace.scroll_focused(-delta);
            }
            _ => {
                if delta > 0 {
                    self.detail_scroll = self.detail_scroll.saturating_add(delta as u16);
                } else {
                    self.detail_scroll = self.detail_scroll.saturating_sub((-delta) as u16);
                }
            }
        }
    }

    fn handle_diff_key(&mut self, key: Key) {
        match key {
            Key::Char('h') => self.toggle_diff_directory(Some(true)),
            Key::Char('l') => self.toggle_diff_directory(Some(false)),
            Key::Enter => self.toggle_diff_directory(None),
            Key::Char(' ') => {
                if let Some(file) = self.diff.files.get(self.diff.selected) {
                    let path = file.path.clone();
                    if !self.diff.reviewed.remove(&path) {
                        self.diff.reviewed.insert(path);
                    }
                }
            }
            Key::Char('n') | Key::Tab => self.step_diff_file(1),
            Key::Char('p') | Key::BackTab => self.step_diff_file(-1),
            Key::Char(']') => self.step_hunk(1),
            Key::Char('[') => self.step_hunk(-1),
            Key::Char('v') => {
                self.diff.visual = Some(self.diff.scroll as usize);
                self.message = "Visual select: j/k extend, y yank, Esc cancel".into();
            }
            Key::Char('y') if self.diff.visual.is_some() => self.yank_diff_selection(),
            Key::Esc => {
                if self.diff.visual.take().is_some() {
                    self.message = "Selection cancelled".into();
                } else {
                    self.close_detail();
                }
            }
            Key::Char('j') | Key::Down => self.diff.scroll = self.diff.scroll.saturating_add(1),
            Key::Char('k') | Key::Up => self.diff.scroll = self.diff.scroll.saturating_sub(1),
            _ => {}
        }
    }

    fn yank_diff_selection(&mut self) {
        let Some(parsed) = self.diff.parsed.as_ref() else {
            return;
        };
        let start = self.diff.visual.unwrap_or(0);
        let end = self.diff.scroll as usize;
        let (start, end) = if start <= end {
            (start, end)
        } else {
            (end, start)
        };
        let text = parsed
            .lines
            .iter()
            .skip(start)
            .take(end.saturating_sub(start) + 1)
            .map(|line| line.text.clone())
            .collect::<Vec<_>>()
            .join("\n");
        self.diff.visual = None;
        self.yank(&text);
    }

    fn toggle_diff_directory(&mut self, collapse: Option<bool>) {
        let Some(file) = self.diff.files.get(self.diff.selected) else {
            return;
        };
        let Some(directory) = crate::screens::diff::parent_dir(&file.path) else {
            self.message = "This file is at the repository root".into();
            return;
        };
        let collapsed = self.diff.collapsed_dirs.contains(&directory);
        let should_collapse = collapse.unwrap_or(!collapsed);
        if should_collapse {
            self.diff.collapsed_dirs.insert(directory.clone());
        } else {
            self.diff.collapsed_dirs.remove(&directory);
        }
        let visible =
            crate::screens::diff::visible_file_indices(&self.diff.files, &self.diff.collapsed_dirs);
        if !visible.contains(&self.diff.selected) {
            if let Some(next) = visible.first().copied() {
                self.open_diff_file(next);
            }
        }
        self.message = format!(
            "{} {directory}/",
            if should_collapse {
                "Folded"
            } else {
                "Unfolded"
            }
        );
    }

    fn step_diff_file(&mut self, delta: i32) {
        if self.diff.files.is_empty() {
            return;
        }
        let visible =
            crate::screens::diff::visible_file_indices(&self.diff.files, &self.diff.collapsed_dirs);
        if visible.is_empty() {
            return;
        }
        let current = visible
            .iter()
            .position(|index| *index == self.diff.selected)
            .unwrap_or(0);
        let next = (current as i32 + delta).rem_euclid(visible.len() as i32) as usize;
        self.open_diff_file(visible[next]);
    }

    fn open_diff_file(&mut self, index: usize) {
        self.diff.selected = index;
        self.diff.scroll = 0;
        self.diff.hunk = 0;
        self.diff.parsed = None;
        self.diff.path = None;
        let Some(file) = self.diff.files.get(index) else {
            return;
        };
        let Some((worktree, target)) = self.diff_context() else {
            return;
        };
        self.in_flight += 1;
        core_bridge::load_file_diff(worktree, target, file.path.clone(), self.sender.clone());
    }

    fn step_hunk(&mut self, delta: i32) {
        let Some(parsed) = self.diff.parsed.as_ref() else {
            return;
        };
        if parsed.hunk_starts.is_empty() {
            return;
        }
        let next =
            (self.diff.hunk as i32 + delta).clamp(0, parsed.hunk_starts.len() as i32 - 1) as usize;
        self.diff.hunk = next;
        self.diff.scroll = parsed.hunk_starts[next] as u16;
    }

    fn diff_context(&self) -> Option<(String, String)> {
        let detail = self.detail.as_ref()?;
        let board = self.board.as_ref()?;
        let project = detail.card.project(&board.projects)?;
        let worktree = detail
            .card
            .environment
            .as_ref()
            .map(|environment| environment.worktree_path.clone())
            .unwrap_or_else(|| project.path.clone());
        let target = detail
            .card
            .environment
            .as_ref()
            .and_then(|environment| environment.target_branch.clone())
            .unwrap_or_else(|| project.target_branch.clone());
        Some((worktree, target))
    }

    pub fn refresh_diff(&mut self) {
        let Some(detail) = self.detail.as_ref() else {
            return;
        };
        let card_id = detail.card.id.clone();
        let Some((worktree, target)) = self.diff_context() else {
            self.error = Some("The card has no project context for a diff".into());
            return;
        };
        self.in_flight += 1;
        core_bridge::load_diff_files(
            Arc::clone(&self.store),
            card_id,
            worktree,
            target,
            self.sender.clone(),
        );
    }

    fn yank(&mut self, text: &str) {
        use std::io::Write;
        print!("{}", crate::widgets::osc52(text));
        let _ = std::io::stdout().flush();
        self.message = format!("Yanked {} line(s) (OSC 52)", text.lines().count());
    }

    // ---- native Pi panes ---------------------------------------------

    fn ensure_pi_pane(&mut self, tab: DetailTab) {
        if !self.pi_workspace(tab).is_empty() {
            return;
        }
        let Some(detail) = self.detail.as_ref() else {
            return;
        };
        let Some(board) = self.board.as_ref() else {
            return;
        };
        let Some(project) = detail.card.project(&board.projects).cloned() else {
            self.error = Some("The card has no project for a Pi session".into());
            return;
        };
        let card_id = detail.card.id.clone();
        let cwd = if tab == DetailTab::Work {
            detail
                .card
                .environment
                .as_ref()
                .map(|environment| environment.worktree_path.clone())
                .unwrap_or_else(|| project.path.clone())
        } else {
            project.path.clone()
        };
        let trusted = pi::project_trusted(&project.path);
        let launch = match pi::native_launch(
            &project,
            Some((&card_id, tab.thread())),
            trusted,
            &self.automation_socket,
        ) {
            Ok(launch) => launch,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        let cols = self.cols.saturating_sub(4).max(20);
        let rows = self.rows.saturating_sub(6).max(5);
        let sink = self.pty_sink();
        let workspace = self.pi_workspace_mut(tab);
        match workspace.open_program(&cwd, &launch, cols, rows, sink) {
            Ok(_) => {
                self.message = if tab == DetailTab::Work {
                    "Pi work session started".into()
                } else {
                    "Pi planning session started".into()
                };
                self.error = None;
            }
            Err(error) => self.error = Some(error),
        }
    }

    fn pi_workspace(&self, tab: DetailTab) -> &TerminalWorkspace {
        if tab == DetailTab::Work {
            &self.work
        } else {
            &self.chat
        }
    }

    fn pi_workspace_mut(&mut self, tab: DetailTab) -> &mut TerminalWorkspace {
        if tab == DetailTab::Work {
            &mut self.work
        } else {
            &mut self.chat
        }
    }

    fn stop_pi_workspace(&mut self, tab: DetailTab) {
        self.pi_workspace_mut(tab).close_all();
    }

    // ---- terminals ---------------------------------------------------

    fn ensure_card_terminal(&mut self) {
        if !self.terminals.is_empty() {
            return;
        }
        let Some(detail) = self.detail.as_ref() else {
            return;
        };
        let Some(board) = self.board.as_ref() else {
            return;
        };
        let cwd = detail
            .card
            .environment
            .as_ref()
            .map(|environment| environment.worktree_path.clone())
            .or_else(|| {
                detail
                    .card
                    .project(&board.projects)
                    .map(|project| project.path.clone())
            });
        let Some(cwd) = cwd else {
            self.error = Some("The card has no worktree to open".into());
            return;
        };
        let cols = self.cols.saturating_sub(2).max(20);
        let rows = self.rows.saturating_sub(8).max(5);
        let env = [
            ("STACKS_CARD_ID", detail.card.id.as_str()),
            ("STACKS_TUI", "1"),
        ];
        let sink = self.pty_sink();
        match self.terminals.open_pane(&cwd, None, cols, rows, &env, sink) {
            Ok(_) => {
                self.message = "Terminal opened".into();
                self.error = None;
            }
            Err(error) => self.error = Some(error),
        }
    }

    fn pty_sink(&self) -> PtySink {
        let sender = self.sender.clone();
        Arc::new(move |event: PtyEvent| {
            let pane = match &event {
                PtyEvent::Data { terminal_id, .. } | PtyEvent::Exit { terminal_id, .. } => {
                    terminal_id.clone()
                }
            };
            sender.send(CoreEvent::Pty { pane, event });
        })
    }

    fn handle_terminal_key(&mut self, key: Key) -> bool {
        if self.active_workspace().is_empty() {
            return false;
        }
        if key == Key::Ctrl('w') {
            self.pending = Some(Pending::CtrlW);
            return true;
        }
        if self.active_workspace().active_copy().is_some() {
            let workspace = self.active_workspace_mut();
            if let Some((text, _)) = workspace.copy_input(key) {
                self.yank(&text);
            }
            return true;
        }
        if let Some(bytes) = self.encode_terminal_key(&key) {
            let workspace = self.active_workspace_mut();
            if let Err(error) = workspace.write(&bytes) {
                self.error = Some(error);
            }
        }
        true
    }

    fn encode_terminal_key(&self, key: &Key) -> Option<Vec<u8>> {
        let key = match key {
            Key::Char(character) => stacks_core::terminal::Key::Char(*character),
            Key::Ctrl(character) => stacks_core::terminal::Key::Ctrl(*character),
            Key::Alt(character) => stacks_core::terminal::Key::Alt(*character),
            Key::Enter => stacks_core::terminal::Key::Enter,
            Key::Esc => stacks_core::terminal::Key::Esc,
            Key::Tab => stacks_core::terminal::Key::Tab,
            Key::BackTab => stacks_core::terminal::Key::BackTab,
            Key::Backspace => stacks_core::terminal::Key::Backspace,
            Key::Delete => stacks_core::terminal::Key::Delete,
            Key::Insert => stacks_core::terminal::Key::Insert,
            Key::Up => stacks_core::terminal::Key::Up,
            Key::Down => stacks_core::terminal::Key::Down,
            Key::Left => stacks_core::terminal::Key::Left,
            Key::Right => stacks_core::terminal::Key::Right,
            Key::Home => stacks_core::terminal::Key::Home,
            Key::End => stacks_core::terminal::Key::End,
            Key::PageUp => stacks_core::terminal::Key::PageUp,
            Key::PageDown => stacks_core::terminal::Key::PageDown,
            Key::F(number) => stacks_core::terminal::Key::F(*number),
            Key::Paste(text) => return Some(text.as_bytes().to_vec()),
        };
        let application_cursor = self
            .active_workspace()
            .focused_pane()
            .is_some_and(|pane| pane.screen.application_cursor());
        stacks_core::terminal::encode_key(key, application_cursor, false)
    }

    fn handle_pane_prefix(&mut self, key: Key) -> bool {
        if key == Key::Char('n') {
            self.terminal_focus = false;
            self.message = "NORMAL — i to focus, n/x for tabs, Esc back".into();
            return true;
        }
        match key {
            Key::Char('|') | Key::Char('-') => {
                let direction = if key == Key::Char('|') {
                    SplitDirection::Row
                } else {
                    SplitDirection::Column
                };
                let (cols, rows) = {
                    let workspace = self.active_workspace();
                    if direction == SplitDirection::Row {
                        (workspace.cols / 2, workspace.rows)
                    } else {
                        (workspace.cols, workspace.rows / 2)
                    }
                };
                let sink = self.pty_sink();
                let workspace = self.active_workspace_mut();
                if let Some(pane) = workspace.focused_pane() {
                    let cwd = pane.cwd.clone();
                    match workspace.open_pane(&cwd, None, cols, rows, &[], sink) {
                        Ok(id) => {
                            workspace.tree = workspace.tree.split(
                                &workspace.focused.clone(),
                                id.clone(),
                                direction,
                            );
                            workspace.focused = id;
                        }
                        Err(error) => self.error = Some(error),
                    }
                }
                true
            }
            Key::Char('o') => {
                self.active_workspace_mut().cycle(true);
                true
            }
            Key::Char('x') | Key::Char('q') => {
                let workspace = self.active_workspace_mut();
                workspace.close_focused();
                true
            }
            Key::Char('z') => {
                let workspace = self.active_workspace_mut();
                workspace.maximized = !workspace.maximized;
                true
            }
            Key::Char('[') => {
                self.active_workspace_mut().start_copy();
                true
            }
            _ => false,
        }
    }

    fn toggle_global_terminal(&mut self) {
        if self.overlay == Some(Overlay::GlobalTerminal) {
            self.overlay = None;
            return;
        }
        if self.global_tabs.is_empty() {
            self.new_global_tab();
        }
        self.overlay = Some(Overlay::GlobalTerminal);
        self.global_terminal_focus = true;
    }

    fn new_global_tab(&mut self) {
        let cwd = dirs::home_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".into());
        let sink = self.pty_sink();
        let mut workspace = TerminalWorkspace::new("global");
        let cols = self.cols.saturating_sub(4).max(20);
        let rows = self.rows.saturating_sub(6).max(5);
        match workspace.open_pane(&cwd, None, cols, rows, &[], sink) {
            Ok(_) => {
                self.global_tabs.push(GlobalTab {
                    title: format!("Terminal {}", self.global_tabs.len() + 1),
                    workspace,
                });
                self.global_active = self.global_tabs.len() - 1;
            }
            Err(error) => self.error = Some(error),
        }
    }

    fn handle_global_terminal_key(&mut self, key: Key) -> bool {
        if key == Key::Ctrl('g') {
            self.overlay = None;
            return true;
        }
        if self.pending == Some(Pending::CtrlW) {
            self.pending = None;
            if key == Key::Char('n') {
                self.global_terminal_focus = false;
                self.message = "NORMAL — i to focus, n/x tabs, Esc close".into();
                return true;
            }
            if let Some(tab) = self.global_tabs.get_mut(self.global_active) {
                let workspace = &mut tab.workspace;
                match key {
                    Key::Char('[') => workspace.start_copy(),
                    Key::Char('x') | Key::Char('q') => workspace.close_focused(),
                    Key::Char('o') => workspace.cycle(true),
                    Key::Char('z') => workspace.maximized = !workspace.maximized,
                    _ => {}
                }
                return true;
            }
        }
        if self.global_terminal_focus {
            if key == Key::Ctrl('w') {
                self.pending = Some(Pending::CtrlW);
                return true;
            }
            if let Some(bytes) = self.encode_terminal_key(&key) {
                if let Some(tab) = self.global_tabs.get_mut(self.global_active) {
                    let workspace = &mut tab.workspace;
                    if workspace.active_copy().is_some() {
                        if let Some((text, _)) = workspace.copy_input(key) {
                            self.yank(&text);
                        }
                    } else if let Err(error) = workspace.write(&bytes) {
                        self.error = Some(error);
                    }
                }
                return true;
            }
        }
        match key {
            Key::Esc => {
                self.overlay = None;
                true
            }
            Key::Char('i') | Key::Enter => {
                self.global_terminal_focus = true;
                true
            }
            Key::Char('n') => {
                self.new_global_tab();
                true
            }
            Key::Char('x') if self.global_tabs.len() > 1 => {
                self.global_tabs.remove(self.global_active);
                self.global_active = self.global_active.min(self.global_tabs.len() - 1);
                true
            }
            Key::Tab => {
                if !self.global_tabs.is_empty() {
                    self.global_active = (self.global_active + 1) % self.global_tabs.len();
                }
                true
            }
            Key::BackTab => {
                if !self.global_tabs.is_empty() {
                    self.global_active =
                        (self.global_active + self.global_tabs.len() - 1) % self.global_tabs.len();
                }
                true
            }
            Key::Char('j') | Key::Down => {
                if let Some(tab) = self.global_tabs.get_mut(self.global_active) {
                    tab.workspace.scroll_focused(-1);
                }
                true
            }
            Key::Char('k') | Key::Up => {
                if let Some(tab) = self.global_tabs.get_mut(self.global_active) {
                    tab.workspace.scroll_focused(1);
                }
                true
            }
            _ => true,
        }
    }

    // ---- overlays ----------------------------------------------------

    fn open_actions(&mut self) {
        if self.actions.is_empty() {
            self.message = "No actions for this card".into();
            return;
        }
        self.action_cursor = 0;
        self.overlay = Some(Overlay::Actions);
    }

    fn open_palette(&mut self) {
        self.palette_query.clear();
        self.palette_cursor = 0;
        self.rebuild_palette();
        self.overlay = Some(Overlay::Palette);
    }

    fn rebuild_palette(&mut self) {
        let query = self.palette_query.value.to_ascii_lowercase();
        let mut items = Vec::new();
        for group in KEYMAP {
            for (key_label, description) in group.entries {
                let id = format!("key:{}:{}", group.group, description);
                let label = format!("{} — {}", key_label, description);
                if !query.is_empty() && !fuzzy(&query, &label.to_ascii_lowercase()) {
                    continue;
                }
                if let Some(key) = key_from_help(key_label) {
                    items.push(PaletteItem {
                        id,
                        label,
                        hint: group.group.to_string(),
                        action: PaletteAction::Key(key),
                    });
                }
            }
        }
        if let Some(board) = self.board.as_ref() {
            for card in &board.cards {
                let label = format!(
                    "#{} {} · {}",
                    card.external_id,
                    card.title,
                    card.project(&board.projects)
                        .map(|project| project.name.clone())
                        .unwrap_or_default()
                );
                if !query.is_empty() && !fuzzy(&query, &label.to_ascii_lowercase()) {
                    continue;
                }
                items.push(PaletteItem {
                    id: format!("card:{}", card.id),
                    label,
                    hint: "Card".into(),
                    action: PaletteAction::Card(card.id.clone()),
                });
            }
            for project in &board.projects {
                if !query.is_empty() && !fuzzy(&query, &project.name.to_ascii_lowercase()) {
                    continue;
                }
                items.push(PaletteItem {
                    id: format!("project:{}", project.id),
                    label: project.name.clone(),
                    hint: "Project".into(),
                    action: PaletteAction::Project(project.id.clone()),
                });
            }
        }
        items.sort_by(|left, right| {
            // Literal substring matches (e.g. "settings") must beat fuzzy
            // card-title matches; then prefer recency, then stable labels.
            let rank = |label: &str| {
                if !query.is_empty() && label.to_ascii_lowercase().contains(&query) {
                    0
                } else {
                    1
                }
            };
            let kind = |action: &PaletteAction| {
                if query.is_empty() {
                    return 0;
                }
                match action {
                    PaletteAction::Key(_) => 0,
                    PaletteAction::Project(_) => 1,
                    PaletteAction::Card(_) => 2,
                }
            };
            kind(&left.action)
                .cmp(&kind(&right.action))
                .then(rank(&left.label).cmp(&rank(&right.label)))
                .then(
                    self.usage
                        .get(&right.id)
                        .copied()
                        .unwrap_or(0)
                        .cmp(&self.usage.get(&left.id).copied().unwrap_or(0)),
                )
                .then(left.label.cmp(&right.label))
        });
        self.palette_items = items;
        self.palette_cursor = self
            .palette_cursor
            .min(self.palette_items.len().saturating_sub(1));
    }

    fn execute_palette(&mut self) {
        let Some(item) = self.palette_items.get(self.palette_cursor).cloned() else {
            return;
        };
        self.overlay = None;
        let _ = settings::record_command_usage(&item.id);
        self.usage.insert(
            item.id.clone(),
            self.usage.get(&item.id).copied().unwrap_or(0) + 1,
        );
        match item.action {
            PaletteAction::Key(key) => self.handle_key(key),
            PaletteAction::Card(card_id) => self.open_detail(card_id),
            PaletteAction::Project(project_id) => {
                self.project_scope = Some(project_id);
                self.recompute_rows();
                self.screen = Screen::Board;
                self.detail = None;
            }
        }
    }

    fn open_projects(&mut self) {
        self.project_query.clear();
        self.project_picker_cursor = 0;
        self.overlay = Some(Overlay::Projects);
    }

    fn execute_project(&mut self) {
        let Some(board) = self.board.as_ref() else {
            return;
        };
        if self.project_picker_cursor == 0 {
            self.project_scope = None;
        } else if let Some(project) = board.projects.get(self.project_picker_cursor - 1) {
            self.project_scope = Some(project.id.clone());
        }
        self.overlay = None;
        self.recompute_rows();
    }

    fn start_new_card(&mut self) {
        let Some(board) = self.board.as_ref() else {
            return;
        };
        let is_local = |project: &&Project| project.kanban_source.as_deref() != Some("superthread");
        let scoped = self
            .project_scope
            .as_deref()
            .and_then(|id| board.projects.iter().find(|project| project.id == id));
        let Some(project) = scoped.or_else(|| board.projects.iter().find(is_local)) else {
            self.error = Some(
                "Add a local project in Stacks before creating a card (Ctrl-O switches projects)"
                    .into(),
            );
            return;
        };
        if !is_local(&project) {
            self.error = Some(
                "Cards can only be created in a local Kanban project; choose one with Ctrl-O"
                    .into(),
            );
            return;
        }
        let (title, content) = self
            .new_card_draft
            .take()
            .map(|(_, title, content)| (title, content))
            .unwrap_or_default();
        self.new_card = Some(NewCardState {
            project_id: project.id.clone(),
            title: TextInput::new(title),
            content: TextArea::new(content),
            focus: 0,
        });
        self.overlay = Some(Overlay::NewCard);
    }

    fn start_edit_card(&mut self) {
        let Some(detail) = self.detail.as_ref() else {
            return;
        };
        if !detail.card.provider.contains("local") {
            self.message = "Editing is limited to local cards".into();
            return;
        }
        self.edit_card = Some(EditCardState {
            card_id: detail.card.id.clone(),
            revision: detail.card.workflow_revision,
            title: TextInput::new(detail.card.title.clone()),
            content: TextArea::new(detail.content.clone()),
            focus: 0,
        });
        self.overlay = Some(Overlay::EditCard);
    }

    fn start_refinement(&mut self) {
        let Some(detail) = self.detail.as_ref() else {
            return;
        };
        self.refinement = Some(RefinementState {
            card_id: detail.card.id.clone(),
            revision: detail.card.workflow_revision,
            content: TextArea::new(detail.content.clone()),
        });
        self.overlay = Some(Overlay::FinishRefinement);
    }

    fn submit_new_card(&mut self) {
        let Some(state) = self.new_card.as_ref() else {
            return;
        };
        if state.title.is_empty() {
            self.error = Some("A card title is required".into());
            return;
        }
        let project_id = state.project_id.clone();
        let title = state.title.value.trim().to_string();
        let content = state.content.value.clone();
        self.new_card_draft = Some((project_id.clone(), title.clone(), content.clone()));
        self.in_flight += 1;
        core_bridge::create_card(
            Arc::clone(&self.store),
            project_id,
            title,
            content,
            self.sender.clone(),
        );
    }

    fn submit_edit_card(&mut self) {
        let Some(state) = self.edit_card.clone() else {
            return;
        };
        self.in_flight += 1;
        core_bridge::update_card(
            Arc::clone(&self.store),
            state.card_id,
            state.revision,
            Some(state.title.value),
            Some(state.content.value),
            self.sender.clone(),
        );
    }

    fn submit_refinement(&mut self) {
        let Some(state) = self.refinement.clone() else {
            return;
        };
        if state.content.is_empty() {
            self.error = Some("A final card description is required".into());
            return;
        }
        self.in_flight += 1;
        core_bridge::finish_refinement(
            Arc::clone(&self.store),
            state.card_id,
            state.revision,
            state.content.value,
            self.sender.clone(),
        );
    }

    fn open_confirm(&mut self, action: ConfirmAction) {
        let delay = Duration::from_millis(self.preferences.confirmation_delay_ms);
        self.confirm = Some(Confirm::new(action, delay));
    }

    fn request_quit(&mut self) {
        let busy = self.is_busy();
        if !busy {
            self.quit = true;
            return;
        }
        self.open_confirm(ConfirmAction {
            title: "Quit Stacks TUI?".into(),
            detail: "Terminals and native Pi sessions started here will be stopped.".into(),
            primary_label: "Quit".into(),
            destructive: true,
            workflow: None,
        });
    }

    fn handle_confirm_key(&mut self, key: Key) {
        let Some(confirm) = self.confirm.as_mut() else {
            return;
        };
        match key {
            Key::Esc | Key::Char('n') => {
                self.confirm = None;
                self.message = "Cancelled".into();
            }
            Key::Tab | Key::BackTab => confirm.toggle_focus(),
            Key::Char('y') | Key::Enter => match confirm.outcome() {
                ConfirmOutcome::Pending => {
                    self.message = format!("Waiting for confirmation ({})", confirm.countdown());
                }
                ConfirmOutcome::Cancelled => {
                    self.confirm = None;
                    self.message = "Cancelled".into();
                }
                ConfirmOutcome::Confirmed => {
                    let action = self.confirm.take().unwrap().into_action();
                    self.run_confirm(action);
                }
            },
            _ => {}
        }
    }

    fn run_confirm(&mut self, action: ConfirmAction) {
        if let Some(workflow) = action.workflow {
            self.in_flight += 1;
            self.message = format!("Running {}…", workflow.action.label());
            core_bridge::run_action(
                Arc::clone(&self.store),
                workflow.card_id,
                workflow.action,
                workflow.revision,
                workflow.feature_environment,
                self.sender.clone(),
            );
        } else {
            self.quit = true;
        }
    }

    fn run_action(&mut self, action: &WorkflowActionPresentation) {
        let Some(detail) = self.detail.as_ref() else {
            return;
        };
        if let Some(reason) = &action.disabled_reason {
            self.message = reason.clone();
            return;
        }
        if action.action == WorkflowAction::FinishRefinement {
            self.overlay = None;
            self.start_refinement();
            return;
        }
        let run = WorkflowRun {
            card_id: detail.card.id.clone(),
            action: action.action,
            revision: detail.card.workflow_revision,
            feature_environment: action.action == WorkflowAction::CreatePrWithFe,
        };
        if let Some(confirmation) = action.confirmation.clone() {
            self.open_confirm(ConfirmAction {
                title: confirmation.title,
                detail: confirmation.detail,
                primary_label: action.label.clone(),
                destructive: matches!(
                    action.appearance,
                    stacks_core::WorkflowActionAppearance::DangerGhost
                ) || matches!(
                    action.action,
                    WorkflowAction::MergeLocal | WorkflowAction::MergePr | WorkflowAction::Close
                ),
                workflow: Some(run),
            });
        } else {
            self.in_flight += 1;
            self.message = format!("Running {}…", action.label);
            core_bridge::run_action(
                Arc::clone(&self.store),
                run.card_id,
                run.action,
                run.revision,
                run.feature_environment,
                self.sender.clone(),
            );
        }
    }

    fn handle_overlay_key(&mut self, overlay: Overlay, key: Key) -> bool {
        match overlay {
            Overlay::Help => {
                match key {
                    Key::Esc | Key::Char('?') | Key::Char('q') => self.overlay = None,
                    Key::Char('j') | Key::Down => {
                        self.help_scroll = self.help_scroll.saturating_add(1)
                    }
                    Key::Char('k') | Key::Up => {
                        self.help_scroll = self.help_scroll.saturating_sub(1)
                    }
                    Key::PageDown | Key::Ctrl('d') => {
                        self.help_scroll = self.help_scroll.saturating_add(12)
                    }
                    Key::PageUp | Key::Ctrl('u') => {
                        self.help_scroll = self.help_scroll.saturating_sub(12)
                    }
                    Key::Char('g') => self.help_scroll = 0,
                    Key::Char('G') => self.help_scroll = u16::MAX / 2,
                    _ => {}
                }
                true
            }
            Overlay::Settings => {
                self.handle_settings_key(key);
                true
            }
            Overlay::Palette => {
                match key {
                    Key::Esc => self.overlay = None,
                    Key::Enter => self.execute_palette(),
                    Key::Up | Key::Ctrl('p') => {
                        self.palette_cursor = self.palette_cursor.saturating_sub(1)
                    }
                    Key::Down | Key::Ctrl('n') => {
                        self.palette_cursor = (self.palette_cursor + 1)
                            .min(self.palette_items.len().saturating_sub(1))
                    }
                    Key::Ctrl('u') => {
                        self.palette_query.clear();
                        self.rebuild_palette();
                    }
                    Key::Paste(text) => {
                        self.palette_query.insert_str(&text);
                        self.rebuild_palette();
                    }
                    _ if self.palette_query.handle(&key) => self.rebuild_palette(),
                    _ => {}
                }
                true
            }
            Overlay::Projects => {
                match key {
                    Key::Esc => self.overlay = None,
                    Key::Enter => self.execute_project(),
                    Key::Up => {
                        self.project_picker_cursor = self.project_picker_cursor.saturating_sub(1)
                    }
                    Key::Down => {
                        let count = self
                            .board
                            .as_ref()
                            .map(|board| board.projects.len() + 1)
                            .unwrap_or(1);
                        self.project_picker_cursor =
                            (self.project_picker_cursor + 1).min(count.saturating_sub(1));
                    }
                    Key::Ctrl('n') => {
                        self.overlay = None;
                        self.start_new_card();
                    }
                    Key::Ctrl('u') => self.project_query.clear(),
                    _ => {
                        self.project_query.handle(&key);
                    }
                }
                true
            }
            Overlay::Actions => {
                match key {
                    Key::Esc => self.overlay = None,
                    Key::Up | Key::Char('k') => {
                        self.action_cursor = self.action_cursor.saturating_sub(1)
                    }
                    Key::Down | Key::Char('j') => {
                        self.action_cursor =
                            (self.action_cursor + 1).min(self.actions.len().saturating_sub(1))
                    }
                    Key::Enter => {
                        if let Some(action) = self.actions.get(self.action_cursor).cloned() {
                            self.run_action(&action);
                        }
                    }
                    _ => {}
                }
                true
            }
            Overlay::NewCard => {
                self.handle_new_card_key(key);
                true
            }
            Overlay::EditCard => {
                self.handle_edit_card_key(key);
                true
            }
            Overlay::FinishRefinement => {
                self.handle_refinement_key(key);
                true
            }
            Overlay::Filter => {
                match key {
                    Key::Esc | Key::Enter => {
                        self.filter = self.filter_input.value.clone();
                        self.overlay = None;
                        self.recompute_rows();
                    }
                    Key::Ctrl('u') => {
                        self.filter_input.clear();
                        self.filter.clear();
                        self.recompute_rows();
                    }
                    _ if self.filter_input.handle(&key) => {
                        self.filter = self.filter_input.value.clone();
                        self.recompute_rows();
                    }
                    _ => {}
                }
                true
            }
            Overlay::GlobalTerminal => self.handle_global_terminal_key(key),
        }
    }

    fn handle_settings_key(&mut self, key: Key) {
        const FIELDS: usize = 5;
        match key {
            Key::Esc => {
                self.overlay = None;
                self.save_preferences();
            }
            Key::Char('j') | Key::Down => {
                self.settings_cursor = (self.settings_cursor + 1) % FIELDS
            }
            Key::Char('k') | Key::Up => {
                self.settings_cursor = (self.settings_cursor + FIELDS - 1) % FIELDS
            }
            Key::Enter | Key::Char('l') | Key::Right | Key::Char(' ') => self.adjust_setting(1),
            Key::Char('h') | Key::Left => self.adjust_setting(-1),
            _ => {}
        }
    }

    fn adjust_setting(&mut self, delta: i32) {
        match self.settings_cursor {
            0 => {
                let steps = [0, 1_000, 2_000, 3_000, 5_000];
                let current = self.preferences.confirmation_delay_ms;
                let index = steps.iter().position(|step| *step == current).unwrap_or(2);
                let next = (index as i32 + delta).clamp(0, steps.len() as i32 - 1) as usize;
                self.preferences.confirmation_delay_ms = steps[next];
            }
            1 => self.preferences.copy_on_select = !self.preferences.copy_on_select,
            2 => {
                let current = self.preferences.terminal_font_size.unwrap_or(14) as i32;
                self.preferences.terminal_font_size = Some((current + delta).clamp(8, 32) as u32);
            }
            3 => {
                let choices = theme::accent_choices();
                let current = self
                    .preferences
                    .accent
                    .as_deref()
                    .and_then(|accent| choices.iter().position(|choice| *choice == accent))
                    .unwrap_or(0);
                let next = (current as i32 + delta).rem_euclid(choices.len() as i32) as usize;
                self.preferences.accent = Some(choices[next].to_string());
            }
            4 => self.preferences.hide_done = !self.preferences.hide_done,
            _ => {}
        }
        self.hide_done = self.preferences.hide_done;
        self.theme = theme::theme(self.depth, self.preferences.accent.as_deref());
        self.save_preferences();
        self.recompute_rows();
    }

    fn handle_new_card_key(&mut self, key: Key) {
        let Some(state) = self.new_card.as_mut() else {
            return;
        };
        match key {
            Key::Esc => {
                self.new_card_draft = Some((
                    state.project_id.clone(),
                    state.title.value.clone(),
                    state.content.value.clone(),
                ));
                self.overlay = None;
                self.message = "Draft kept; press n to resume".into();
            }
            Key::Tab => state.focus = 1 - state.focus,
            Key::Enter if state.focus == 0 => state.focus = 1,
            Key::Enter => self.submit_new_card(),
            Key::Ctrl('s') => self.submit_new_card(),
            _ => {
                if state.focus == 0 {
                    state.title.handle(&key);
                } else {
                    state.content.handle(&key);
                }
            }
        }
    }

    fn handle_edit_card_key(&mut self, key: Key) {
        let Some(state) = self.edit_card.as_mut() else {
            return;
        };
        match key {
            Key::Esc => {
                self.overlay = None;
                self.message = "Edit cancelled".into();
            }
            Key::Tab => state.focus = 1 - state.focus,
            Key::Ctrl('s') => self.submit_edit_card(),
            _ => {
                if state.focus == 0 {
                    state.title.handle(&key);
                } else {
                    state.content.handle(&key);
                }
            }
        }
    }

    fn handle_refinement_key(&mut self, key: Key) {
        let Some(state) = self.refinement.as_mut() else {
            return;
        };
        match key {
            Key::Esc => {
                self.overlay = None;
                self.message = "Refinement edit kept in this session".into();
            }
            Key::Ctrl('s') => self.submit_refinement(),
            _ => {
                state.content.handle(&key);
            }
        }
    }

    // ---- helpers -----------------------------------------------------

    pub fn detail_delivery(&self) -> Option<DeliveryStep> {
        let detail = self.detail.as_ref()?;
        let board = self.board.as_ref()?;
        Some(stacks_core::grouping::delivery_step(
            &detail.card,
            &board.projects,
        ))
    }

    pub fn active_transcript(&self) -> &TerminalWorkspace {
        self.active_workspace()
    }

    pub fn is_busy(&self) -> bool {
        self.in_flight > 0
            || self.chat.panes.values().any(|pane| pane.alive())
            || self.work.panes.values().any(|pane| pane.alive())
            || self.terminals.panes.values().any(|pane| pane.alive())
            || self
                .global_tabs
                .iter()
                .any(|tab| tab.workspace.panes.values().any(|pane| pane.alive()))
    }

    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    pub fn tab_scroll(&self) -> u16 {
        self.detail_scroll
    }

    pub fn detail_tab_index(&self) -> usize {
        self.detail_tab.index()
    }

    /// Drive time-based UI (confirmation focus) from the render loop.
    pub fn tick(&mut self) {
        if let Some(confirm) = self.confirm.as_mut() {
            if confirm.ready() && !confirm.focus_primary {
                confirm.focus_primary = true;
            }
        }
    }

    /// Drain worker events until the queue is quiet or the deadline passes.
    pub fn pump(&mut self, max_ms: u64) {
        let deadline = Instant::now() + Duration::from_millis(max_ms);
        loop {
            while let Some(event) = self.events.try_recv() {
                self.handle_core_event(event);
            }
            if self.in_flight == 0 || Instant::now() >= deadline {
                break;
            }
            if let Some(event) = self.events.recv_timeout(Duration::from_millis(10)) {
                self.handle_core_event(event);
            }
        }
        self.tick();
    }

    /// Script-only wait: keep draining events for the full duration.
    pub fn wait(&mut self, max_ms: u64) {
        let deadline = Instant::now() + Duration::from_millis(max_ms);
        while Instant::now() < deadline {
            while let Some(event) = self.events.try_recv() {
                self.handle_core_event(event);
            }
            if let Some(event) = self.events.recv_timeout(Duration::from_millis(10)) {
                self.handle_core_event(event);
            }
            self.tick();
        }
    }

    /// Feed text as individual key presses (used by `--script type`).
    pub fn type_text(&mut self, text: &str) {
        for character in text.chars() {
            self.handle_key(Key::Char(character));
        }
    }

    pub fn session_focus(&self) -> &'static str {
        if !self.terminal_focus {
            "NORMAL"
        } else {
            "INPUT"
        }
    }
}

/// Subsequence fuzzy match.
pub fn fuzzy(query: &str, candidate: &str) -> bool {
    let mut chars = candidate.chars();
    for character in query.chars() {
        if character == ' ' {
            continue;
        }
        loop {
            match chars.next() {
                Some(candidate) if candidate == character => break,
                Some(_) => continue,
                None => return false,
            }
        }
    }
    true
}

fn key_from_help(label: &str) -> Option<Key> {
    match label {
        "Ctrl-P / :" => Some(Key::Ctrl('p')),
        "Ctrl-," => Some(Key::Ctrl(',')),
        "?" => Some(Key::Char('?')),
        "Ctrl-Q" => Some(Key::Ctrl('q')),
        "Ctrl-O" => Some(Key::Ctrl('o')),
        "Ctrl-G" => Some(Key::Ctrl('g')),
        "Ctrl-R" => Some(Key::Ctrl('r')),
        "Ctrl-B" => Some(Key::Ctrl('b')),
        "Ctrl-A" => Some(Key::Ctrl('a')),
        "Ctrl-F" => Some(Key::Ctrl('f')),
        "Ctrl-D / Ctrl-U" => Some(Key::Ctrl('d')),
        "Ctrl-W then |" => Some(Key::Ctrl('w')),
        "Ctrl-W then -" => Some(Key::Ctrl('w')),
        "Ctrl-W then o" => Some(Key::Ctrl('w')),
        "Ctrl-W then x" => Some(Key::Ctrl('w')),
        "Ctrl-W then z" => Some(Key::Ctrl('w')),
        "Ctrl-W then [" => Some(Key::Ctrl('w')),
        "Ctrl-W then q" => Some(Key::Ctrl('w')),
        "Ctrl-W then n" => Some(Key::Ctrl('w')),
        "Ctrl-C" => Some(Key::Ctrl('c')),
        "Alt-Enter" => Some(Key::Alt('\r')),
        "/" => Some(Key::Char('/')),
        "n" => Some(Key::Char('n')),
        "n / p" => Some(Key::Char('n')),
        "a" => Some(Key::Char('a')),
        "e" => Some(Key::Char('e')),
        "i" => Some(Key::Char('i')),
        "v" => Some(Key::Char('v')),
        "J / K" => Some(Key::Char('J')),
        "gg / G" => Some(Key::Char('G')),
        "Space" => Some(Key::Char(' ')),
        "[ / ]" => Some(Key::Char(']')),
        "y / n" => Some(Key::Char('y')),
        "y" => Some(Key::Char('y')),
        "1..5" => Some(Key::Char('1')),
        _ => None,
    }
}

impl TerminalWorkspace {
    pub fn close_all(&mut self) {
        self.panes.clear();
        self.focused.clear();
        self.tree = crate::split_tree::SplitNode::leaf("");
    }
}
