//! Application state machine: focus, screens, overlays and key dispatch.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use stacks_core::{
    CardDetail, CardSnapshot, CardStatus, CardSummary, DeliveryStep, DeliveryWorkflow, Project,
    WorkGroup, WorkflowAction, WorkflowActionPresentation, WorktreeStatus,
    diff::{DiffFile, GitReviewContext, ParsedDiff},
    pi::{self, NativeLaunch},
    pty::{PtyEvent, PtySink},
    release::{ReleaseAction, ReleaseSetup, ReleaseState},
    settings::{self, TuiPreferences},
};

use crate::{
    core_bridge::{self, Store},
    event::{CoreEvent, EventBus, EventSender},
    keys::{KEYMAP, Key},
    screens::terminal::{SavedWorkspace, TerminalWorkspace},
    split_tree::SplitDirection,
    theme::{self, ColorDepth, Theme},
    widgets::{TextArea, TextInput},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Board,
    Detail,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DetailTab {
    Overview,
    Agent,
    Diff,
    Terminal,
    Server,
    Console,
}

impl DetailTab {
    pub const ALL: [Self; 6] = [
        Self::Overview,
        Self::Agent,
        Self::Diff,
        Self::Terminal,
        Self::Server,
        Self::Console,
    ];

    pub fn index(self) -> usize {
        Self::ALL.iter().position(|tab| *tab == self).unwrap_or(0)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Overview => "Overview",
            Self::Agent => "Agent",
            Self::Diff => "Diff",
            Self::Terminal => "Terminal",
            Self::Server => "Server",
            Self::Console => "Console",
        }
    }

    pub fn thread(self) -> &'static str {
        if self == Self::Agent {
            "work"
        } else {
            "planning"
        }
    }

    pub fn is_pi(self) -> bool {
        matches!(self, Self::Agent)
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Terminal | Self::Server | Self::Console)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProjectTab {
    Notes,
    Agent,
    Diff,
    Terminal,
    Release,
    Server,
    Console,
}

impl ProjectTab {
    pub const ALL: [Self; 7] = [
        Self::Notes,
        Self::Agent,
        Self::Diff,
        Self::Terminal,
        Self::Release,
        Self::Server,
        Self::Console,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Notes => "Notes",
            Self::Agent => "Agent",
            Self::Diff => "Diff",
            Self::Terminal => "Terminal",
            Self::Release => "Release",
            Self::Server => "Server",
            Self::Console => "Console",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Agent | Self::Terminal | Self::Server | Self::Console
        )
    }
}

pub struct ReleaseWorkspaceState {
    pub version: TextInput,
    pub editing: bool,
    pub setup: Option<ReleaseSetup>,
    pub latest: Option<String>,
    pub latest_error: Option<String>,
    pub state: Option<ReleaseState>,
    pub state_error: Option<String>,
    pub loading: bool,
    pub error: Option<String>,
    pub terminal: TerminalWorkspace,
    pub last_action: Option<(ReleaseAction, String)>,
}

impl ReleaseWorkspaceState {
    fn new(owner: &str) -> Self {
        Self {
            version: TextInput::default(),
            editing: false,
            setup: None,
            latest: None,
            latest_error: None,
            state: None,
            state_error: None,
            loading: false,
            error: None,
            terminal: TerminalWorkspace::new(format!("{owner}:release")),
            last_action: None,
        }
    }
}

pub struct ProjectWorkspaceState {
    pub project_id: String,
    pub tab: ProjectTab,
    pub notes: TextArea,
    pub notes_editing: bool,
    pub notes_dirty: bool,
    pub notes_scroll: u16,
    pub agent: TerminalWorkspace,
    pub terminal: TerminalWorkspace,
    pub server: TerminalWorkspace,
    pub console: TerminalWorkspace,
    pub release: ReleaseWorkspaceState,
}

impl ProjectWorkspaceState {
    fn new(project_id: String, notes: String, owner: &str) -> Self {
        Self {
            project_id,
            tab: ProjectTab::Notes,
            notes: TextArea::new(notes),
            notes_editing: false,
            notes_dirty: false,
            notes_scroll: 0,
            agent: TerminalWorkspace::new(format!("{owner}-agent")),
            terminal: TerminalWorkspace::new(format!("{owner}-terminal")),
            server: TerminalWorkspace::new(format!("{owner}-server")),
            console: TerminalWorkspace::new(format!("{owner}-console")),
            release: ReleaseWorkspaceState::new(owner),
        }
    }
}

pub struct CardSessions {
    pub terminals: TerminalWorkspace,
    pub work: TerminalWorkspace,
    pub server: TerminalWorkspace,
    pub console: TerminalWorkspace,
    pub terminal_focus: bool,
    pub detail_tab: DetailTab,
    pub detail_scroll: u16,
    pub diff: DiffState,
}

impl CardSessions {
    fn new(card_id: &str) -> Self {
        let owner = format!("card:{card_id}");
        Self {
            terminals: TerminalWorkspace::new(format!("{owner}:terminal")),
            work: TerminalWorkspace::new(format!("{owner}:agent")),
            server: TerminalWorkspace::new(format!("{owner}:server")),
            console: TerminalWorkspace::new(format!("{owner}:console")),
            terminal_focus: false,
            detail_tab: DetailTab::Overview,
            detail_scroll: 0,
            diff: DiffState::default(),
        }
    }

    fn close_all(&mut self) {
        self.terminals.close_all();
        self.work.close_all();
        self.server.close_all();
        self.console.close_all();
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
    NewProject,
    EditProject,
    SuperthreadConfig,
    ProviderBoards,
    EditCard,
    FinishRefinement,
    Filter,
    GlobalTerminal,
    DiffComment,
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
    pub projects: Vec<(String, String)>,
    pub project_index: usize,
    pub title: TextInput,
    pub content: TextArea,
    pub focus: usize,
}

#[derive(Debug, Clone)]
pub struct NewProjectState {
    pub path: TextInput,
    pub name: TextInput,
    pub focus: usize,
}

#[derive(Debug, Clone)]
pub struct EditProjectState {
    pub project_id: String,
    pub name: TextInput,
    pub path: TextInput,
    pub target_branch: TextInput,
    pub start_work: TextInput,
    pub server: TextInput,
    pub console: TextInput,
    pub release_config: TextInput,
    pub releases_enabled: bool,
    pub focus: usize,
}

#[derive(Debug, Clone)]
pub struct SuperthreadConfigState {
    pub project_id: String,
    pub enabled: bool,
    pub spaces: TextInput,
    pub token_env: TextInput,
    pub workspace_slug: TextInput,
    pub board_id: TextInput,
    pub incoming: TextInput,
    pub default_incoming: TextInput,
    pub in_progress: TextInput,
    pub done: TextInput,
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
    pub provider: String,
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
    pub release: Option<ReleaseRun>,
    pub project_delete: Option<String>,
    pub relaunch: bool,
}

#[derive(Debug, Clone)]
pub struct ReleaseRun {
    pub project_id: String,
    pub version: String,
    pub action: ReleaseAction,
    pub setup: ReleaseSetup,
}

impl ReleaseRun {
    fn action_label(&self) -> &'static str {
        release_action_label(self.action)
    }
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

#[derive(Debug, Clone)]
pub struct DiffComment {
    pub path: String,
    pub line: Option<u32>,
    pub body: String,
}

pub struct DiffCommentEditor {
    pub path: Option<String>,
    pub line: Option<u32>,
    pub input: TextArea,
}

#[derive(Debug, Default)]
pub struct DiffState {
    pub files: Vec<DiffFile>,
    pub selected: usize,
    pub reviewed: HashSet<String>,
    pub overall_comment: String,
    pub comments: Vec<DiffComment>,
    pub collapsed_dirs: HashSet<String>,
    pub context: Option<GitReviewContext>,
    pub parsed: Option<ParsedDiff>,
    pub path: Option<String>,
    pub scroll: u16,
    pub hunk: usize,
    pub line: usize,
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
    pub new_project: Option<NewProjectState>,
    pub edit_project: Option<EditProjectState>,
    pub superthread_config: Option<SuperthreadConfigState>,
    pub provider_boards: Vec<core_bridge::DiscoveredBoard>,
    pub provider_board_cursor: usize,
    pub pending_agent_layout: Option<SavedWorkspace>,
    pub new_card_draft: Option<(String, String, String)>,
    pub edit_card: Option<EditCardState>,
    pub refinement: Option<RefinementState>,
    pub filter_input: TextInput,
    pub diff_comment: Option<DiffCommentEditor>,
    pub palette_query: TextInput,
    pub palette_items: Vec<PaletteItem>,
    pub palette_cursor: usize,
    pub project_query: TextInput,
    pub project_picker_cursor: usize,
    pub usage: BTreeMap<String, u64>,

    pub diff: DiffState,
    pub diff_owner: Option<String>,
    pub selected_git: Option<WorktreeStatus>,
    pub selected_git_error: Option<String>,
    pub selected_git_card: Option<String>,
    pub selected_git_loading: bool,
    pub terminals: TerminalWorkspace,
    pub work: TerminalWorkspace,
    pub server: TerminalWorkspace,
    pub console: TerminalWorkspace,
    pub project: Option<ProjectWorkspaceState>,
    pub project_sessions: HashMap<String, ProjectWorkspaceState>,
    pub card_sessions: HashMap<String, CardSessions>,
    pub pending_project_open: Option<String>,
    pub relaunch: bool,
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
    pub last_background_refresh: Instant,
    pub last_pr_refresh: Instant,
    pub last_provider_refresh: Instant,
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
            new_project: None,
            edit_project: None,
            superthread_config: None,
            provider_boards: Vec::new(),
            provider_board_cursor: 0,
            pending_agent_layout: None,
            new_card_draft: None,
            edit_card: None,
            refinement: None,
            filter_input: TextInput::default(),
            diff_comment: None,
            palette_query: TextInput::default(),
            palette_items: Vec::new(),
            palette_cursor: 0,
            project_query: TextInput::default(),
            project_picker_cursor: 0,
            usage: settings.command_usage_counts.clone().unwrap_or_default(),
            diff: DiffState::default(),
            diff_owner: None,
            selected_git: None,
            selected_git_error: None,
            selected_git_card: None,
            selected_git_loading: false,
            terminals: TerminalWorkspace::new("card"),
            work: TerminalWorkspace::new("card-work"),
            server: TerminalWorkspace::new("card-server"),
            console: TerminalWorkspace::new("card-console"),
            project: None,
            project_sessions: HashMap::new(),
            card_sessions: HashMap::new(),
            pending_project_open: None,
            relaunch: false,
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
            last_background_refresh: Instant::now(),
            last_pr_refresh: Instant::now(),
            last_provider_refresh: Instant::now(),
            cols: 120,
            rows: 40,
            headless,
        };
        app.apply_workspace_preferences();
        app.recompute_rows();
        app.board_cursor = app.first_card_cursor().unwrap_or(0);
        app.sync_selected_git();
        app
    }

    pub fn refresh_board(&mut self) {
        self.loading_board = true;
        self.selected_git_card = None;
        self.in_flight += 1;
        core_bridge::load_board(Arc::clone(&self.store), self.sender.clone());
    }

    pub fn open_detail(&mut self, card_id: String) {
        // Scope is already visible in the board panel title; it is not card
        // context and must not follow the user into card detail.
        if self.message.starts_with("Project filter:") || self.message.starts_with("Scope:") {
            self.message.clear();
        }
        let same = self.screen == Screen::Detail
            && self.selected_card.as_deref() == Some(card_id.as_str());
        if !same {
            self.stash_card_sessions();
            self.restore_card_sessions(&card_id);
        }
        self.selected_card = Some(card_id.clone());
        self.screen = Screen::Detail;
        self.detail = None;
        if let Some(index) = self
            .board_rows
            .iter()
            .position(|row| row.card_id.as_deref() == Some(card_id.as_str()))
        {
            self.board_cursor = index;
            self.sync_selected_git();
        }
        self.load_detail(card_id);
    }

    fn load_detail(&mut self, card_id: String) {
        self.detail_loading = true;
        self.in_flight += 1;
        core_bridge::load_detail(Arc::clone(&self.store), card_id, self.sender.clone());
    }

    pub fn close_detail(&mut self) {
        self.stash_card_sessions();
        self.screen = Screen::Board;
        self.detail = None;
        self.actions.clear();
        self.overlay = None;
        self.detail_scroll = 0;
        self.pending = None;
        self.diff_owner = None;
        self.terminal_focus = false;
    }

    fn stash_card_sessions(&mut self) {
        let Some(card_id) = self.selected_card.clone() else {
            return;
        };
        let has_work = self.screen == Screen::Detail
            || !self.terminals.is_empty()
            || !self.work.is_empty()
            || !self.server.is_empty()
            || !self.console.is_empty();
        if !has_work {
            return;
        }
        let sessions = CardSessions {
            terminals: std::mem::replace(&mut self.terminals, TerminalWorkspace::new("card")),
            work: std::mem::replace(&mut self.work, TerminalWorkspace::new("card-work")),
            server: std::mem::replace(&mut self.server, TerminalWorkspace::new("card-server")),
            console: std::mem::replace(&mut self.console, TerminalWorkspace::new("card-console")),
            terminal_focus: self.terminal_focus,
            detail_tab: self.detail_tab,
            detail_scroll: self.detail_scroll,
            diff: std::mem::take(&mut self.diff),
        };
        self.card_sessions.insert(card_id, sessions);
        self.terminal_focus = false;
    }

    fn restore_card_sessions(&mut self, card_id: &str) {
        let sessions = self
            .card_sessions
            .remove(card_id)
            .unwrap_or_else(|| CardSessions::new(card_id));
        self.terminals = sessions.terminals;
        self.work = sessions.work;
        self.server = sessions.server;
        self.console = sessions.console;
        self.terminal_focus = sessions.terminal_focus;
        self.detail_tab = sessions.detail_tab;
        self.detail_scroll = sessions.detail_scroll;
        self.diff = sessions.diff;
        self.diff_owner = Some(card_id.to_string());
        self.apply_workspace_preferences();
    }

    fn stop_card_sessions_for(&mut self, card_id: &str) {
        if self.selected_card.as_deref() == Some(card_id) {
            self.terminals.close_all();
            self.work.close_all();
            self.server.close_all();
            self.console.close_all();
            self.terminal_focus = false;
        }
        if let Some(mut sessions) = self.card_sessions.remove(card_id) {
            sessions.close_all();
        }
    }

    fn project_workspace_mut_by_id(
        &mut self,
        project_id: &str,
    ) -> Option<&mut ProjectWorkspaceState> {
        if self
            .project
            .as_ref()
            .is_some_and(|state| state.project_id == project_id)
        {
            self.project.as_mut()
        } else {
            self.project_sessions.get_mut(project_id)
        }
    }

    pub fn recompute_rows(&mut self) {
        let Some(board) = self.board.as_ref() else {
            self.board_rows.clear();
            self.board_cursor = 0;
            return;
        };
        let previous_card = self.selected_board_card().map(|card| card.id.clone());
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
            let ordered = order_group_cards(&cards);
            let mut hidden: HashSet<String> = HashSet::new();
            for (card_index, depth) in ordered {
                let card = &cards[card_index];
                if let Some(parent) = card.parent.as_ref() {
                    if hidden.contains(&parent.id)
                        || (!filtering && self.collapsed_parents.contains(&parent.id))
                    {
                        hidden.insert(card.id.clone());
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
                    depth,
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
        if let Some(card_id) = previous_card {
            if let Some(index) = self
                .board_rows
                .iter()
                .position(|row| row.card_id.as_deref() == Some(card_id.as_str()))
            {
                self.board_cursor = index;
            } else if let Some(index) = self.first_card_cursor() {
                self.board_cursor = index;
            }
        }
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

    fn sync_selected_git(&mut self) {
        let Some(card) = self.selected_board_card().cloned() else {
            self.selected_git = None;
            self.selected_git_error = None;
            self.selected_git_card = None;
            self.selected_git_loading = false;
            return;
        };
        if self.selected_git_card.as_deref() == Some(card.id.as_str()) {
            return;
        }
        self.selected_git_card = Some(card.id.clone());
        self.selected_git = None;
        self.selected_git_error = None;
        let Some(board) = self.board.as_ref() else {
            self.selected_git_loading = false;
            return;
        };
        let Some(environment) = card.environment.as_ref() else {
            self.selected_git_loading = false;
            return;
        };
        let target = environment
            .target_branch
            .clone()
            .or_else(|| {
                card.project(&board.projects)
                    .map(|project| project.target_branch.clone())
            })
            .unwrap_or_else(|| "main".into());
        self.selected_git_loading = true;
        self.in_flight += 1;
        core_bridge::load_worktree_status(
            card.id.clone(),
            environment.worktree_path.clone(),
            target,
            self.sender.clone(),
        );
    }

    pub fn save_ui_state(&self) {
        if self.headless {
            return;
        }
        let (screen, project_id, card_id, detail_tab, project_tab) = match self.screen {
            Screen::Board => ("board", None, None, None, None),
            Screen::Detail => (
                "card",
                self.detail
                    .as_ref()
                    .and_then(|detail| detail.card.project_id.clone()),
                self.selected_card.clone(),
                Some(self.detail_tab.index()),
                None,
            ),
            Screen::Project => (
                "project",
                self.project.as_ref().map(|state| state.project_id.clone()),
                None,
                None,
                self.project
                    .as_ref()
                    .map(|state| state.tab.label().to_string()),
            ),
        };
        let (terminal_tab, terminal_layout) =
            if self.screen == Screen::Detail && self.detail_tab.is_terminal() {
                (
                    Some(self.detail_tab.label().to_string()),
                    match self.detail_tab {
                        DetailTab::Terminal => self.terminals.snapshot(),
                        DetailTab::Server => self.server.snapshot(),
                        DetailTab::Console => self.console.snapshot(),
                        _ => None,
                    }
                    .and_then(|layout| serde_json::to_string(&layout).ok()),
                )
            } else if self.screen == Screen::Project
                && self
                    .project
                    .as_ref()
                    .is_some_and(|state| state.tab.is_terminal())
            {
                (
                    self.project
                        .as_ref()
                        .map(|state| state.tab.label().to_string()),
                    self.project
                        .as_ref()
                        .and_then(|state| match state.tab {
                            ProjectTab::Terminal => state.terminal.snapshot(),
                            ProjectTab::Server => state.server.snapshot(),
                            ProjectTab::Console => state.console.snapshot(),
                            _ => None,
                        })
                        .and_then(|layout| serde_json::to_string(&layout).ok()),
                )
            } else {
                (None, None)
            };
        let state = settings::TuiUiState {
            screen: screen.into(),
            project_id,
            card_id,
            detail_tab,
            project_tab,
            terminal_tab,
            terminal_layout,
        };
        let _ = settings::save_ui_state(&state);
    }

    fn card_agent_launch(&self) -> Result<NativeLaunch, String> {
        let detail = self
            .detail
            .as_ref()
            .ok_or_else(|| "Card detail is not loaded".to_string())?;
        let project = detail
            .card
            .project(
                self.board
                    .as_ref()
                    .map(|board| board.projects.as_slice())
                    .unwrap_or(&[]),
            )
            .cloned()
            .ok_or_else(|| "The card project was not found".to_string())?;
        pi::native_launch(
            &project,
            Some((detail.card.id.as_str(), "work")),
            pi::project_trusted(&project.path),
            &self.automation_socket,
        )
    }

    fn project_agent_launch(&self) -> Result<NativeLaunch, String> {
        let state = self
            .project
            .as_ref()
            .ok_or_else(|| "Project workspace is not open".to_string())?;
        let project = self
            .board
            .as_ref()
            .and_then(|board| {
                board
                    .projects
                    .iter()
                    .find(|project| project.id == state.project_id)
            })
            .ok_or_else(|| "The project was not found".to_string())?;
        pi::native_launch_project(
            project,
            pi::project_trusted(&project.path),
            &self.automation_socket,
        )
    }

    fn restore_terminal_layout(&mut self, state: &settings::TuiUiState) {
        let Some(tab) = state.terminal_tab.as_deref() else {
            return;
        };
        let current = match self.screen {
            Screen::Detail => self.detail_tab.label(),
            Screen::Project => self
                .project
                .as_ref()
                .map(|state| state.tab.label())
                .unwrap_or_default(),
            Screen::Board => return,
        };
        if current != tab {
            return;
        }
        let Some(encoded) = state.terminal_layout.as_deref() else {
            return;
        };
        let Ok(layout) = serde_json::from_str::<SavedWorkspace>(encoded) else {
            return;
        };
        let agent_launch = if current == "Agent" {
            if self.screen == Screen::Detail && self.detail.is_none() {
                self.pending_agent_layout = Some(layout);
                return;
            }
            let launch = if self.screen == Screen::Detail {
                self.card_agent_launch()
            } else {
                self.project_agent_launch()
            };
            match launch {
                Ok(launch) => Some(launch),
                Err(error) => {
                    self.error = Some(format!("Could not restore Agent layout: {error}"));
                    return;
                }
            }
        } else {
            None
        };
        let cols = self.cols.saturating_sub(4).max(20);
        let rows = self.rows.saturating_sub(8).max(5);
        let sink = self.pty_sink();
        match self
            .active_workspace_mut()
            .restore(layout, cols, rows, sink, agent_launch.as_ref())
        {
            Ok(()) => self.terminal_focus = true,
            Err(error) => self.error = Some(format!("Could not restore terminal layout: {error}")),
        }
    }

    pub fn restore_ui_state(&mut self) {
        if self.headless {
            return;
        }
        let state = settings::load_ui_state();
        match state.screen.as_str() {
            "card" => {
                let Some(card_id) = state.card_id.clone() else {
                    return;
                };
                if !self
                    .board
                    .as_ref()
                    .is_some_and(|board| board.cards.iter().any(|card| card.id == card_id))
                {
                    return;
                }
                self.open_detail(card_id);
                if let Some(tab) = state
                    .detail_tab
                    .and_then(|index| DetailTab::ALL.get(index).copied())
                {
                    self.detail_tab = tab;
                }
                self.restore_terminal_layout(&state);
            }
            "project" => {
                let Some(project_id) = state.project_id.clone() else {
                    return;
                };
                if !self.board.as_ref().is_some_and(|board| {
                    board
                        .projects
                        .iter()
                        .any(|project| project.id == project_id)
                }) {
                    return;
                }
                self.open_project_workspace(project_id);
                if let Some(label) = state.project_tab.as_deref() {
                    if let Some(tab) = self
                        .project_tabs()
                        .into_iter()
                        .find(|tab| tab.label() == label)
                    {
                        self.select_project_tab(tab);
                    }
                }
                self.restore_terminal_layout(&state);
            }
            _ => {}
        }
    }

    pub fn apply_preferences(&mut self) {
        let settings = settings::load();
        self.usage = settings.command_usage_counts.clone().unwrap_or_default();
        self.preferences = settings.tui_preferences();
        self.theme = theme::theme(self.depth, self.preferences.accent.as_deref());
        self.apply_workspace_preferences();
    }

    fn apply_workspace_preferences(&mut self) {
        let scrollback = self.preferences.terminal_scrollback as usize;
        for workspace in self.workspaces_mut() {
            workspace.scrollback = scrollback;
        }
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
                        self.sync_selected_git();
                        if let Some(project_id) = self.pending_project_open.take() {
                            self.open_project_workspace(project_id);
                        }
                    }
                    Err(error) => self.error = Some(error),
                }
            }
            CoreEvent::ProjectCreated(result) => {
                self.in_flight = self.in_flight.saturating_sub(1);
                match result {
                    Ok(project_id) => {
                        self.message = "Project added".into();
                        self.pending_project_open = Some(project_id);
                        self.refresh_board();
                    }
                    Err(error) => self.error = Some(error),
                }
            }
            CoreEvent::SuperthreadSynced { manual, result } => {
                self.in_flight = self.in_flight.saturating_sub(1);
                match result {
                    Ok(updated) => {
                        if manual {
                            self.message = format!("Superthread sync: {updated} card(s)");
                        }
                        if updated > 0 {
                            self.refresh_board();
                        }
                    }
                    Err(error) if manual => {
                        self.error = Some(format!("Superthread sync failed: {error}"))
                    }
                    Err(_) => {}
                }
            }
            CoreEvent::ProviderDiscovered(result) => {
                self.in_flight = self.in_flight.saturating_sub(1);
                match result {
                    Ok(boards) => {
                        self.provider_boards = boards;
                        self.provider_board_cursor = 0;
                        self.overlay = Some(Overlay::ProviderBoards);
                        self.message =
                            format!("Choose a board ({} found)", self.provider_boards.len());
                    }
                    Err(error) => self.error = Some(format!("Discovery failed: {error}")),
                }
            }
            CoreEvent::SuperthreadConfigured { project_id, result } => {
                self.in_flight = self.in_flight.saturating_sub(1);
                match result {
                    Ok(()) => {
                        self.project_sessions.remove(&project_id);
                        if self
                            .project
                            .as_ref()
                            .is_some_and(|state| state.project_id == project_id)
                        {
                            self.project = None;
                            if self.screen == Screen::Project {
                                self.screen = Screen::Board;
                            }
                        }
                        self.message = "Superthread configuration saved".into();
                        self.error = None;
                        self.refresh_board();
                    }
                    Err(error) => {
                        self.error = Some(format!("Superthread configuration failed: {error}"))
                    }
                }
            }
            CoreEvent::ProviderCardSynced(result) => {
                self.in_flight = self.in_flight.saturating_sub(1);
                match result {
                    Ok(true) => {
                        self.message = "Superthread card moved".into();
                        self.refresh_board();
                    }
                    Ok(false) => {}
                    Err(error) => self.error = Some(format!("Superthread update failed: {error}")),
                }
            }
            CoreEvent::PullRequestsSynced(result) => {
                self.in_flight = self.in_flight.saturating_sub(1);
                if let Ok(updated) = result {
                    if updated > 0 {
                        self.refresh_board();
                    }
                }
            }
            CoreEvent::ProjectDeleted { project_id, result } => {
                self.in_flight = self.in_flight.saturating_sub(1);
                match result {
                    Ok(()) => {
                        self.project_sessions.remove(&project_id);
                        if self
                            .project
                            .as_ref()
                            .is_some_and(|state| state.project_id == project_id)
                        {
                            self.project = None;
                            if self.screen == Screen::Project {
                                self.screen = Screen::Board;
                            }
                        }
                        if self.project_scope.as_deref() == Some(project_id.as_str()) {
                            self.project_scope = None;
                        }
                        self.message = "Project deleted".into();
                        self.error = None;
                        self.refresh_board();
                    }
                    Err(error) => self.error = Some(error),
                }
            }
            CoreEvent::ProjectUpdated(result) => {
                self.in_flight = self.in_flight.saturating_sub(1);
                match result {
                    Ok(()) => {
                        self.message = "Project updated".into();
                        self.error = None;
                        self.refresh_board();
                    }
                    Err(error) => self.error = Some(error),
                }
            }
            CoreEvent::ReleaseInfo { project_id, result } => {
                self.in_flight = self.in_flight.saturating_sub(1);
                let Some(state) = self.project_workspace_mut_by_id(&project_id) else {
                    return;
                };
                state.release.loading = false;
                match result {
                    Ok(info) => {
                        state.release.latest = info.latest;
                        state.release.latest_error = info.latest_error;
                        state.release.state = info.state;
                        state.release.state_error = info.state_error;
                        state.release.setup = Some(info.setup);
                        if state.release.version.value.trim().is_empty() {
                            let suggestion = state
                                .release
                                .state
                                .as_ref()
                                .and_then(|release| release.version.clone())
                                .or_else(|| {
                                    state.release.latest.as_deref().and_then(next_patch_version)
                                });
                            if let Some(version) = suggestion {
                                state.release.version = TextInput::new(version);
                            }
                        }
                        state.release.error = None;
                    }
                    Err(error) => state.release.error = Some(error),
                }
            }
            CoreEvent::ReleasePrepared {
                project_id,
                version,
                action,
                result,
            } => {
                self.in_flight = self.in_flight.saturating_sub(1);
                let cols = self.cols.saturating_sub(4).max(20);
                let rows = self.rows.saturating_sub(8).max(5);
                let sink = self.pty_sink();
                let Some(state) = self.project_workspace_mut_by_id(&project_id) else {
                    return;
                };
                match result {
                    Ok((setup, command)) => {
                        state.release.terminal.close_all();
                        state.release.setup = Some(setup.clone());
                        state.release.last_action = Some((action, version.clone()));
                        match state.release.terminal.open_managed(
                            &setup.cwd,
                            &command,
                            cols,
                            rows,
                            &[],
                            sink,
                        ) {
                            Ok(_) => {
                                self.message =
                                    format!("{} {} running", release_action_label(action), version);
                                self.error = None;
                            }
                            Err(error) => state.release.error = Some(error),
                        }
                    }
                    Err(error) => state.release.error = Some(error),
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
                            if let Some(layout) = self.pending_agent_layout.take() {
                                match self.card_agent_launch() {
                                    Ok(launch) => {
                                        let cols = self.cols.saturating_sub(4).max(20);
                                        let rows = self.rows.saturating_sub(8).max(5);
                                        let sink = self.pty_sink();
                                        match self.work.restore(
                                            layout,
                                            cols,
                                            rows,
                                            sink,
                                            Some(&launch),
                                        ) {
                                            Ok(()) => self.terminal_focus = true,
                                            Err(error) => {
                                                self.error = Some(format!(
                                                    "Could not restore Agent layout: {error}"
                                                ))
                                            }
                                        }
                                    }
                                    Err(error) => {
                                        self.error =
                                            Some(format!("Could not restore Agent layout: {error}"))
                                    }
                                }
                            } else {
                                self.ensure_pi_pane(self.detail_tab);
                            }
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
                        self.in_flight += 1;
                        core_bridge::sync_superthread_card_status(
                            Arc::clone(&self.store),
                            card_id.clone(),
                            self.sender.clone(),
                        );
                        if matches!(
                            action,
                            WorkflowAction::Close
                                | WorkflowAction::Delete
                                | WorkflowAction::MergePr
                                | WorkflowAction::MergeLocal
                        ) {
                            self.stop_card_sessions_for(&card_id);
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
                if self.active_diff_owner().as_deref() != Some(card_id.as_str()) {
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
                        self.diff.line = 0;
                        if !self.diff.files.is_empty() {
                            self.open_diff_file(0);
                        }
                        self.error = None;
                    }
                    Err(error) => self.error = Some(error),
                }
            }
            CoreEvent::FileDiff {
                owner,
                path,
                result,
            } => {
                self.in_flight = self.in_flight.saturating_sub(1);
                if self.active_diff_owner().as_deref() != Some(owner.as_str())
                    || self
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
                if !self.headless && self.selected_card.as_deref() != Some(card_id.as_str()) {
                    use std::io::Write;
                    print!("\x07");
                    let _ = std::io::stdout().flush();
                }
                self.message = message;
                self.refresh_board();
                if self.selected_card.as_deref() == Some(card_id.as_str()) {
                    self.load_detail(card_id);
                }
            }
            CoreEvent::WorktreeStatus { card_id, result } => {
                self.in_flight = self.in_flight.saturating_sub(1);
                if self.selected_git_card.as_deref() != Some(card_id.as_str()) {
                    return;
                }
                self.selected_git_loading = false;
                match result {
                    Ok(status) => {
                        self.selected_git = Some(status);
                        self.selected_git_error = None;
                    }
                    Err(error) => {
                        self.selected_git = None;
                        self.selected_git_error = Some(error);
                    }
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
        let mut workspaces = vec![
            &mut self.terminals,
            &mut self.work,
            &mut self.server,
            &mut self.console,
        ];
        if let Some(project) = self.project.as_mut() {
            workspaces.push(&mut project.agent);
            workspaces.push(&mut project.terminal);
            workspaces.push(&mut project.server);
            workspaces.push(&mut project.console);
            workspaces.push(&mut project.release.terminal);
        }
        for project in self.project_sessions.values_mut() {
            workspaces.push(&mut project.agent);
            workspaces.push(&mut project.terminal);
            workspaces.push(&mut project.server);
            workspaces.push(&mut project.console);
            workspaces.push(&mut project.release.terminal);
        }
        for sessions in self.card_sessions.values_mut() {
            workspaces.push(&mut sessions.terminals);
            workspaces.push(&mut sessions.work);
            workspaces.push(&mut sessions.server);
            workspaces.push(&mut sessions.console);
        }
        for tab in &mut self.global_tabs {
            workspaces.push(&mut tab.workspace);
        }
        workspaces
    }

    // ---- key dispatch ------------------------------------------------

    pub fn handle_key(&mut self, key: Key) {
        self.dispatch_key(key);
        self.sync_selected_git();
    }

    fn dispatch_key(&mut self, key: Key) {
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
                    self.handle_pane_prefix(key.clone());
                    return;
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
                Screen::Project => self.handle_project_key(key),
            },
        }
    }

    pub fn handle_paste(&mut self, text: String) {
        self.handle_key(Key::Paste(text));
    }

    fn terminal_owns_keyboard(&self) -> bool {
        if self.overlay.is_some() || !self.terminal_focus {
            return false;
        }
        let relevant = match self.screen {
            Screen::Detail => self.detail_tab.is_pi() || self.detail_tab.is_terminal(),
            Screen::Project => self
                .project
                .as_ref()
                .is_some_and(|state| state.tab.is_terminal()),
            Screen::Board => false,
        };
        relevant && !self.active_workspace().is_empty()
    }

    fn active_workspace(&self) -> &TerminalWorkspace {
        if self.screen == Screen::Project {
            if let Some(state) = self.project.as_ref() {
                return match state.tab {
                    ProjectTab::Agent => &state.agent,
                    ProjectTab::Terminal => &state.terminal,
                    ProjectTab::Server => &state.server,
                    ProjectTab::Console => &state.console,
                    ProjectTab::Notes | ProjectTab::Diff | ProjectTab::Release => &state.terminal,
                };
            }
        }
        match (self.screen, self.detail_tab) {
            (Screen::Detail, DetailTab::Terminal) => &self.terminals,
            (Screen::Detail, DetailTab::Agent) => &self.work,
            _ => self
                .global_tabs
                .get(self.global_active)
                .map(|tab| &tab.workspace)
                .unwrap_or(&self.terminals),
        }
    }

    pub fn active_workspace_mut(&mut self) -> &mut TerminalWorkspace {
        if self.screen == Screen::Project {
            if let Some(state) = self.project.as_mut() {
                return match state.tab {
                    ProjectTab::Agent => &mut state.agent,
                    ProjectTab::Terminal => &mut state.terminal,
                    ProjectTab::Server => &mut state.server,
                    ProjectTab::Console => &mut state.console,
                    ProjectTab::Notes | ProjectTab::Diff | ProjectTab::Release => {
                        &mut state.terminal
                    }
                };
            }
        }
        match (self.screen, self.detail_tab) {
            (Screen::Detail, DetailTab::Terminal) => &mut self.terminals,
            (Screen::Detail, DetailTab::Agent) => &mut self.work,
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
                    self.diff.line = 0;
                }
                DetailTab::Terminal | DetailTab::Agent | DetailTab::Server | DetailTab::Console => {
                    let workspace = self.active_workspace_mut();
                    if let Some(pane) = workspace.focused_pane_mut() {
                        pane.screen.scroll(usize::MAX / 2);
                    }
                }
                DetailTab::Overview => self.detail_scroll = 0,
            },
            Screen::Project => {
                if self
                    .project
                    .as_ref()
                    .is_some_and(|state| state.tab == ProjectTab::Diff)
                {
                    self.diff.scroll = 0;
                    self.diff.hunk = 0;
                } else if self
                    .project
                    .as_ref()
                    .is_some_and(|state| state.tab.is_terminal())
                {
                    let workspace = self.active_workspace_mut();
                    if let Some(pane) = workspace.focused_pane_mut() {
                        pane.screen.scroll(usize::MAX / 2);
                    }
                }
            }
        }
    }

    fn open_project_from_context(&mut self) {
        let project_id = if self.focus == Focus::Sidebar {
            let index = self.sidebar_cursor;
            self.board.as_ref().and_then(|board| {
                if index == 0 {
                    self.project_scope.clone()
                } else {
                    board
                        .projects
                        .get(index - 1)
                        .map(|project| project.id.clone())
                }
            })
        } else {
            self.project_scope.clone().or_else(|| {
                self.selected_board_card()
                    .and_then(|card| card.project_id.clone())
            })
        }
        .or_else(|| {
            self.board
                .as_ref()
                .and_then(|board| board.projects.first().map(|project| project.id.clone()))
        });
        match project_id {
            Some(project_id) => self.open_project_workspace(project_id),
            None => self.message = "No project available for a project workspace".into(),
        }
    }

    pub fn project_tabs(&self) -> Vec<ProjectTab> {
        let mut tabs = vec![
            ProjectTab::Notes,
            ProjectTab::Agent,
            ProjectTab::Diff,
            ProjectTab::Terminal,
        ];
        let Some(state) = self.project.as_ref() else {
            return tabs;
        };
        let Some(project) = self.board.as_ref().and_then(|board| {
            board
                .projects
                .iter()
                .find(|project| project.id == state.project_id)
        }) else {
            return tabs;
        };
        if project.releases_enabled {
            tabs.push(ProjectTab::Release);
        }
        if project
            .server_command
            .as_deref()
            .is_some_and(|command| !command.trim().is_empty())
        {
            tabs.push(ProjectTab::Server);
        }
        if project
            .console_command
            .as_deref()
            .is_some_and(|command| !command.trim().is_empty())
        {
            tabs.push(ProjectTab::Console);
        }
        tabs
    }

    pub fn project_tab_index(&self) -> usize {
        self.project
            .as_ref()
            .map(|state| {
                self.project_tabs()
                    .iter()
                    .position(|tab| *tab == state.tab)
                    .unwrap_or(0)
            })
            .unwrap_or(0)
    }

    fn open_project_workspace(&mut self, project_id: String) {
        let Some(project) = self
            .board
            .as_ref()
            .and_then(|board| {
                board
                    .projects
                    .iter()
                    .find(|project| project.id == project_id)
            })
            .cloned()
        else {
            self.message = "Project was not found".into();
            return;
        };
        if self.project.as_ref().is_some_and(|state| state.notes_dirty) {
            self.save_project_notes();
        }
        self.stash_card_sessions();
        let same = self
            .project
            .as_ref()
            .is_some_and(|state| state.project_id == project_id);
        if !same {
            if let Some(active) = self.project.take() {
                self.project_sessions
                    .insert(active.project_id.clone(), active);
            }
            self.project = Some(
                self.project_sessions
                    .remove(&project.id)
                    .unwrap_or_else(|| {
                        ProjectWorkspaceState::new(
                            project.id.clone(),
                            project.notes.clone(),
                            &format!("project:{}", project.id),
                        )
                    }),
            );
        }
        self.project_scope = Some(project.id);
        self.screen = Screen::Project;
        self.terminal_focus = false;
        self.message = String::new();
        self.apply_workspace_preferences();
        if let Some(tab) = self.project.as_ref().map(|state| state.tab) {
            self.select_project_tab(tab);
        }
    }

    fn select_project_tab(&mut self, tab: ProjectTab) {
        if self
            .project
            .as_ref()
            .is_some_and(|state| state.tab == ProjectTab::Notes && state.notes_dirty)
        {
            self.save_project_notes();
        }
        let Some(state) = self.project.as_mut() else {
            return;
        };
        state.tab = tab;
        state.notes_editing = false;
        self.terminal_focus = false;
        match tab {
            ProjectTab::Notes => {}
            ProjectTab::Agent => self.ensure_project_agent(),
            ProjectTab::Diff => self.refresh_project_diff(),
            ProjectTab::Terminal => self.ensure_project_terminal(),
            ProjectTab::Release => self.load_release_info(),
            ProjectTab::Server | ProjectTab::Console => self.ensure_project_service(tab),
        }
    }

    fn ensure_project_agent(&mut self) {
        let Some(project) = self
            .project
            .as_ref()
            .and_then(|state| {
                self.board.as_ref().and_then(|board| {
                    board
                        .projects
                        .iter()
                        .find(|project| project.id == state.project_id)
                })
            })
            .cloned()
        else {
            return;
        };
        if self
            .project
            .as_ref()
            .is_some_and(|state| !state.agent.is_empty())
        {
            return;
        }
        let trusted = pi::project_trusted(&project.path);
        let launch = match pi::native_launch_project(&project, trusted, &self.automation_socket) {
            Ok(launch) => launch,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        let cols = self.cols.saturating_sub(4).max(20);
        let rows = self.rows.saturating_sub(6).max(5);
        let sink = self.pty_sink();
        let Some(state) = self.project.as_mut() else {
            return;
        };
        match state
            .agent
            .open_program(&project.path, &launch, cols, rows, sink)
        {
            Ok(_) => {
                self.terminal_focus = true;
                self.error = None;
            }
            Err(error) => self.error = Some(error),
        }
    }

    fn ensure_project_terminal(&mut self) {
        let Some(project) = self
            .project
            .as_ref()
            .and_then(|state| {
                self.board.as_ref().and_then(|board| {
                    board
                        .projects
                        .iter()
                        .find(|project| project.id == state.project_id)
                })
            })
            .cloned()
        else {
            return;
        };
        if self
            .project
            .as_ref()
            .is_some_and(|state| !state.terminal.is_empty())
        {
            return;
        }
        let cols = self.cols.saturating_sub(4).max(20);
        let rows = self.rows.saturating_sub(6).max(5);
        let sink = self.pty_sink();
        let Some(state) = self.project.as_mut() else {
            return;
        };
        match state
            .terminal
            .open_pane(&project.path, None, cols, rows, &[], sink)
        {
            Ok(_) => {
                self.terminal_focus = true;
                self.error = None;
            }
            Err(error) => self.error = Some(error),
        }
    }

    fn ensure_project_service(&mut self, tab: ProjectTab) {
        let Some(project) = self
            .project
            .as_ref()
            .and_then(|state| {
                self.board.as_ref().and_then(|board| {
                    board
                        .projects
                        .iter()
                        .find(|project| project.id == state.project_id)
                })
            })
            .cloned()
        else {
            return;
        };
        let command = match tab {
            ProjectTab::Server => project.server_command.clone(),
            ProjectTab::Console => project.console_command.clone(),
            _ => None,
        };
        let Some(command) = command.filter(|command| !command.trim().is_empty()) else {
            self.error = Some("This service is not configured for the project".into());
            return;
        };
        let cols = self.cols.saturating_sub(4).max(20);
        let rows = self.rows.saturating_sub(6).max(5);
        let sink = self.pty_sink();
        let Some(state) = self.project.as_mut() else {
            return;
        };
        let workspace = match tab {
            ProjectTab::Server => &mut state.server,
            ProjectTab::Console => &mut state.console,
            _ => return,
        };
        if !workspace.is_empty() {
            return;
        }
        match workspace.open_managed(&project.path, &command, cols, rows, &[], sink) {
            Ok(_) => {
                self.terminal_focus = true;
                self.error = None;
            }
            Err(error) => self.error = Some(error),
        }
    }

    fn load_release_info(&mut self) {
        let Some(state) = self.project.as_ref() else {
            return;
        };
        if state.release.loading {
            return;
        }
        let project_id = state.project_id.clone();
        let version = state.release.version.value.trim().to_string();
        if let Some(state) = self.project.as_mut() {
            state.release.loading = true;
            state.release.error = None;
        }
        self.in_flight += 1;
        core_bridge::load_release_info(
            Arc::clone(&self.store),
            project_id,
            version,
            self.sender.clone(),
        );
    }

    fn release_draft_ready(&self) -> bool {
        let Some(state) = self.project.as_ref() else {
            return false;
        };
        let version = state.release.version.value.trim();
        state.release.state.as_ref().is_some_and(|release| {
            release.version.as_deref() == Some(version) && release.draft_ready
        })
    }

    fn open_release_confirm(&mut self, action: ReleaseAction) {
        let Some(state) = self.project.as_ref() else {
            return;
        };
        let Some(setup) = state.release.setup.clone() else {
            self.message = "Release setup is still loading".into();
            return;
        };
        let version = state.release.version.value.trim().to_string();
        if version.is_empty() {
            self.message = "Enter a release version first".into();
            return;
        }
        if state
            .release
            .terminal
            .panes
            .values()
            .any(|pane| pane.alive())
        {
            self.message = "A release command is already running".into();
            return;
        }
        if action == ReleaseAction::BuildAndTest && !setup.can_build_and_test {
            self.message = "Build and test is not configured for this project".into();
            return;
        }
        if action == ReleaseAction::Publish && !setup.can_publish {
            self.message = "Publishing is not configured for this project".into();
            return;
        }
        if action != ReleaseAction::Release && !self.release_draft_ready() {
            self.message = "Build and publish require a ready draft for this version".into();
            return;
        }
        let label = release_action_label(action);
        let detail = match action {
            ReleaseAction::Release => format!(
                "Run the configured release command for {version} in {}.",
                setup.cwd
            ),
            ReleaseAction::BuildAndTest => {
                format!("Build and test the signed draft for {version}. This does not publish.")
            }
            ReleaseAction::Publish => {
                format!("Publish {version} as the latest release. This affects updater users.")
            }
        };
        self.open_confirm(ConfirmAction {
            title: format!("{label} {version}?"),
            detail,
            primary_label: label.into(),
            destructive: action == ReleaseAction::Publish,
            workflow: None,
            release: Some(ReleaseRun {
                project_id: state.project_id.clone(),
                version,
                action,
                setup,
            }),
            project_delete: None,
            relaunch: false,
        });
    }

    fn release_build_completed(&self) -> bool {
        self.project.as_ref().is_some_and(|state| {
            state
                .release
                .last_action
                .as_ref()
                .is_some_and(|(action, _)| *action == ReleaseAction::BuildAndTest)
                && state
                    .release
                    .terminal
                    .panes
                    .values()
                    .any(|pane| pane.exited == Some(Some(0)))
        })
    }

    fn start_restart_to_test(&mut self) {
        if !self.release_build_completed() {
            self.message = "Build & test must complete successfully first".into();
            return;
        }
        self.open_confirm(ConfirmAction {
            title: "Restart Stacks TUI to test?".into(),
            detail: "Terminals and agents will stop, then the TUI will relaunch with the installed build.".into(),
            primary_label: "Restart".into(),
            destructive: true,
            workflow: None,
            release: None,
            project_delete: None,
            relaunch: true,
        });
    }

    fn handle_release_key(&mut self, key: Key) {
        let Some(state) = self.project.as_ref() else {
            return;
        };
        if state.release.editing {
            match key {
                Key::Esc => {
                    if let Some(state) = self.project.as_mut() {
                        state.release.editing = false;
                    }
                }
                Key::Enter | Key::Ctrl('s') => {
                    if let Some(state) = self.project.as_mut() {
                        state.release.editing = false;
                    }
                    self.load_release_info();
                }
                _ => {
                    if let Some(state) = self.project.as_mut() {
                        state.release.version.handle(&key);
                    }
                }
            }
            return;
        }
        match key {
            Key::Esc => {
                self.screen = Screen::Board;
                self.terminal_focus = false;
            }
            Key::Char('e') => {
                if let Some(state) = self.project.as_mut() {
                    state.release.editing = true;
                }
            }
            Key::Char('r') => self.open_release_confirm(ReleaseAction::Release),
            Key::Char('b') => self.open_release_confirm(ReleaseAction::BuildAndTest),
            Key::Char('p') => self.open_release_confirm(ReleaseAction::Publish),
            Key::Char('R') => self.load_release_info(),
            Key::Char('t') => self.start_restart_to_test(),
            Key::Tab => self.cycle_project_tab(false),
            Key::BackTab => self.cycle_project_tab(true),
            _ => {}
        }
    }

    fn handle_project_key(&mut self, key: Key) {
        let Some(state) = self.project.as_ref() else {
            self.screen = Screen::Board;
            return;
        };
        if !(state.tab == ProjectTab::Notes && state.notes_editing) {
            if key == Key::Char('S') {
                self.sync_superthread_from_context();
                return;
            }
            if key == Key::Char('P') {
                self.start_superthread_config();
                return;
            }
        }
        if state.tab == ProjectTab::Release {
            self.handle_release_key(key);
            return;
        }
        if state.tab == ProjectTab::Diff {
            self.handle_diff_key(key);
            return;
        }
        if state.tab == ProjectTab::Notes {
            if state.notes_editing {
                match key {
                    Key::Ctrl('s') => self.save_project_notes(),
                    Key::Esc => {
                        if let Some(state) = self.project.as_mut() {
                            state.notes_editing = false;
                        }
                    }
                    _ => {
                        if let Some(state) = self.project.as_mut() {
                            if state.notes.handle(&key) {
                                state.notes_dirty = true;
                            }
                        }
                    }
                }
                return;
            }
            match key {
                Key::Char('e') => {
                    if let Some(state) = self.project.as_mut() {
                        state.notes_editing = true;
                    }
                }
                Key::Esc => {
                    if state.notes_dirty {
                        self.save_project_notes();
                    }
                    self.screen = Screen::Board;
                }
                Key::Char('j') | Key::Down => {
                    if let Some(state) = self.project.as_mut() {
                        state.notes_scroll = state.notes_scroll.saturating_add(1);
                    }
                }
                Key::Char('k') | Key::Up => {
                    if let Some(state) = self.project.as_mut() {
                        state.notes_scroll = state.notes_scroll.saturating_sub(1);
                    }
                }
                Key::Enter | Key::Char('i') => {
                    if let Some(state) = self.project.as_mut() {
                        state.notes_editing = true;
                    }
                }
                Key::Char(character @ '1'..='5') => {
                    let index = character as usize - '1' as usize;
                    if let Some(tab) = self.project_tabs().get(index).copied() {
                        self.select_project_tab(tab);
                    }
                }
                Key::Tab | Key::BackTab => self.cycle_project_tab(key == Key::BackTab),
                _ => {}
            }
            return;
        }
        match key {
            Key::Esc => self.screen = Screen::Board,
            Key::Char('i') | Key::Enter => self.terminal_focus = true,
            Key::Char(character @ '1'..='5') => {
                let index = character as usize - '1' as usize;
                if let Some(tab) = self.project_tabs().get(index).copied() {
                    self.select_project_tab(tab);
                }
            }
            Key::Tab => self.cycle_project_tab(false),
            Key::BackTab => self.cycle_project_tab(true),
            Key::Char('j') | Key::Down => self.active_workspace_mut().scroll_focused(-1),
            Key::Char('k') | Key::Up => self.active_workspace_mut().scroll_focused(1),
            Key::PageDown | Key::Ctrl('d') => self.active_workspace_mut().scroll_focused(-10),
            Key::PageUp | Key::Ctrl('u') => self.active_workspace_mut().scroll_focused(10),
            Key::Char('g') => self.pending = Some(Pending::G),
            Key::Char('G') => {
                let workspace = self.active_workspace_mut();
                if let Some(pane) = workspace.focused_pane_mut() {
                    pane.screen.scroll(0);
                }
            }
            _ => {}
        }
    }

    fn cycle_project_tab(&mut self, backwards: bool) {
        let tabs = self.project_tabs();
        if tabs.is_empty() {
            return;
        }
        let current = self.project_tab_index();
        let next = if backwards {
            (current + tabs.len() - 1) % tabs.len()
        } else {
            (current + 1) % tabs.len()
        };
        self.select_project_tab(tabs[next]);
    }

    fn save_project_notes(&mut self) {
        let Some(state) = self.project.as_ref() else {
            return;
        };
        let project_id = state.project_id.clone();
        let notes = state.notes.value.clone();
        match self.store.save_project_notes(&project_id, &notes) {
            Ok(()) => {
                if let Some(board) = self.board.as_mut() {
                    if let Some(project) = board
                        .projects
                        .iter_mut()
                        .find(|project| project.id == project_id)
                    {
                        project.notes = notes;
                    }
                }
                if let Some(state) = self.project.as_mut() {
                    state.notes_editing = false;
                    state.notes_dirty = false;
                }
                self.message = "Project notes saved".into();
                self.error = None;
            }
            Err(error) => self.error = Some(error.to_string()),
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
            Key::Char('n') if self.focus == Focus::Sidebar => self.start_new_project(),
            Key::Char('e') if self.focus == Focus::Sidebar => self.start_edit_project(),
            Key::Char('D') if self.focus == Focus::Sidebar => self.start_delete_project(),
            Key::Char('S') if self.focus == Focus::Sidebar => self.sync_superthread_from_context(),
            Key::Char('S') => self.sync_superthread_from_context(),
            Key::Char('P') if self.focus == Focus::Sidebar => self.start_superthread_config(),
            Key::Char('n') => self.start_new_card(),
            Key::Char('w') => self.open_project_from_context(),
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
                    self.message = String::new();
                    return;
                }
                if self.detail_tab.is_terminal() && self.terminal_focus {
                    self.terminal_focus = false;
                    self.message = String::new();
                    return;
                }
                self.close_detail();
            }
            Key::Char(character @ '1'..='6') => {
                let index = character as usize - '1' as usize;
                let tabs = self.visible_detail_tabs();
                if let Some(tab) = tabs.get(index) {
                    self.select_tab(*tab);
                }
            }
            Key::Tab => {
                let tabs = self.visible_detail_tabs();
                let next = (self.detail_tab_index() + 1) % tabs.len().max(1);
                if let Some(tab) = tabs.get(next) {
                    self.select_tab(*tab);
                }
            }
            Key::BackTab => {
                let tabs = self.visible_detail_tabs();
                let next =
                    (self.detail_tab_index() + tabs.len().saturating_sub(1)) % tabs.len().max(1);
                if let Some(tab) = tabs.get(next) {
                    self.select_tab(*tab);
                }
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
                } else if self.detail_tab.is_pi() || self.detail_tab.is_terminal() {
                    let workspace = self.active_workspace_mut();
                    if let Some(pane) = workspace.focused_pane_mut() {
                        pane.screen.scroll(0);
                    }
                } else {
                    self.detail_scroll = u16::MAX / 2;
                }
            }
            Key::Char('i') | Key::Enter
                if self.detail_tab.is_pi() || self.detail_tab.is_terminal() =>
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
                DetailTab::Terminal | DetailTab::Server | DetailTab::Console => {
                    self.handle_terminal_key(key);
                }
                DetailTab::Agent => {
                    if self.handle_terminal_key(key) {
                        return;
                    }
                }
                DetailTab::Overview => {}
            },
        }
    }

    pub fn visible_detail_tabs(&self) -> Vec<DetailTab> {
        let mut tabs = vec![
            DetailTab::Overview,
            DetailTab::Agent,
            DetailTab::Diff,
            DetailTab::Terminal,
        ];
        let Some(detail) = self.detail.as_ref() else {
            return tabs;
        };
        if detail.card.environment.is_none() {
            return tabs;
        }
        let Some(project) = self.detail_project() else {
            return tabs;
        };
        if project
            .server_command
            .as_deref()
            .is_some_and(|command| !command.trim().is_empty())
        {
            tabs.push(DetailTab::Server);
        }
        if project
            .console_command
            .as_deref()
            .is_some_and(|command| !command.trim().is_empty())
        {
            tabs.push(DetailTab::Console);
        }
        tabs
    }

    fn ensure_service(&mut self, tab: DetailTab) {
        let (command, cwd) = {
            let Some(detail) = self.detail.as_ref() else {
                return;
            };
            let Some(project) = self.detail_project() else {
                self.error = Some("The card has no project for this service".into());
                return;
            };
            let command = match tab {
                DetailTab::Server => project.server_command.clone(),
                DetailTab::Console => project.console_command.clone(),
                _ => None,
            };
            let Some(command) = command.filter(|command| !command.trim().is_empty()) else {
                self.error = Some("This service is not configured for the project".into());
                return;
            };
            let Some(environment) = detail.card.environment.as_ref() else {
                self.error = Some("The card has no worktree for this service".into());
                return;
            };
            (command, environment.worktree_path.clone())
        };
        let cols = self.cols.saturating_sub(4).max(20);
        let rows = self.rows.saturating_sub(8).max(5);
        let card_id = self
            .detail
            .as_ref()
            .map(|detail| detail.card.id.clone())
            .unwrap_or_default();
        let env = [("STACKS_CARD_ID", card_id.as_str()), ("STACKS_TUI", "1")];
        let sink = self.pty_sink();
        let workspace = match tab {
            DetailTab::Server => &mut self.server,
            DetailTab::Console => &mut self.console,
            _ => return,
        };
        if !workspace.is_empty() {
            return;
        }
        match workspace.open_managed(&cwd, &command, cols, rows, &env, sink) {
            Ok(_) => {
                self.message = format!("{} started", tab.label());
                self.error = None;
            }
            Err(error) => self.error = Some(error),
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
            DetailTab::Agent => {
                self.ensure_pi_pane(tab);
                self.terminal_focus = true;
            }
            DetailTab::Server | DetailTab::Console => {
                self.ensure_service(tab);
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
            DetailTab::Terminal | DetailTab::Agent | DetailTab::Server | DetailTab::Console => {
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

    fn open_diff_comment(&mut self, overall: bool) {
        let path = if overall {
            None
        } else {
            match self.diff.files.get(self.diff.selected) {
                Some(file) => Some(file.path.clone()),
                None => {
                    self.message = "Select a changed file before commenting".into();
                    return;
                }
            }
        };
        let existing = match path.as_deref() {
            Some(path) => self
                .diff
                .comments
                .iter()
                .find(|comment| comment.path == path && comment.line.is_none())
                .map(|comment| comment.body.clone())
                .unwrap_or_default(),
            None => self.diff.overall_comment.clone(),
        };
        self.diff_comment = Some(DiffCommentEditor {
            path,
            line: None,
            input: TextArea::new(existing),
        });
        self.overlay = Some(Overlay::DiffComment);
    }

    fn open_diff_line_comment(&mut self) {
        let Some(parsed) = self.diff.parsed.as_ref() else {
            self.message = "Open a file diff before commenting on a line".into();
            return;
        };
        let Some(line) = parsed.lines.get(self.diff.line) else {
            self.message = "Select a code line first".into();
            return;
        };
        if matches!(
            line.kind,
            stacks_core::diff::DiffLineKind::Hunk
                | stacks_core::diff::DiffLineKind::Header
                | stacks_core::diff::DiffLineKind::Meta
        ) {
            self.message = "Select an added, removed, or context line".into();
            return;
        }
        let Some(number) = line.new_line.or(line.old_line) else {
            self.message = "This line has no line number".into();
            return;
        };
        let Some(path) = self.diff.path.clone() else {
            self.message = "No file is selected".into();
            return;
        };
        let existing = self
            .diff
            .comments
            .iter()
            .find(|comment| comment.path == path && comment.line == Some(number))
            .map(|comment| comment.body.clone())
            .unwrap_or_default();
        self.diff_comment = Some(DiffCommentEditor {
            path: Some(path),
            line: Some(number),
            input: TextArea::new(existing),
        });
        self.overlay = Some(Overlay::DiffComment);
    }

    fn handle_diff_comment_key(&mut self, key: Key) {
        let Some(editor) = self.diff_comment.as_mut() else {
            self.overlay = None;
            return;
        };
        match key {
            Key::Esc => {
                self.overlay = None;
                self.diff_comment = None;
            }
            Key::Ctrl('s') => {
                let body = editor.input.value.trim().to_string();
                if let Some(path) = editor.path.clone() {
                    let line = editor.line;
                    if body.is_empty() {
                        self.diff
                            .comments
                            .retain(|comment| !(comment.path == path && comment.line == line));
                    } else if let Some(comment) = self
                        .diff
                        .comments
                        .iter_mut()
                        .find(|comment| comment.path == path && comment.line == line)
                    {
                        comment.body = body;
                    } else {
                        self.diff.comments.push(DiffComment { path, line, body });
                    }
                } else {
                    self.diff.overall_comment = body;
                }
                self.overlay = None;
                self.diff_comment = None;
                self.message = "Diff feedback saved".into();
            }
            _ => {
                editor.input.handle(&key);
            }
        }
    }

    fn submit_diff_feedback(&mut self) {
        let mut lines = vec![
            "Please address the following feedback".to_string(),
            String::new(),
        ];
        if !self.diff.overall_comment.trim().is_empty() {
            lines.push(self.diff.overall_comment.trim().to_string());
            lines.push(String::new());
        }
        for (index, comment) in self
            .diff
            .comments
            .iter()
            .filter(|comment| !comment.body.trim().is_empty())
            .enumerate()
        {
            let location = match comment.line {
                Some(line) => format!("{}:{}", comment.path, line),
                None => comment.path.clone(),
            };
            lines.push(format!("{}. [git diff] {}", index + 1, location));
            lines.push(format!("   {}", comment.body.trim()));
            lines.push(String::new());
        }
        let prompt = lines.join("\n").trim().to_string();
        if prompt == "Please address the following feedback" {
            self.message = "Add a comment or overall feedback before submitting".into();
            return;
        }
        let flattened = prompt.replace('\r', "").replace('\n', " ");
        let result = if self.screen == Screen::Project {
            self.select_project_tab(ProjectTab::Agent);
            self.project
                .as_mut()
                .map(|state| state.agent.write(format!("{flattened}\r").as_bytes()))
        } else {
            self.select_tab(DetailTab::Agent);
            Some(self.work.write(format!("{flattened}\r").as_bytes()))
        };
        match result {
            Some(Ok(())) => {
                self.diff.comments.clear();
                self.diff.overall_comment.clear();
                self.diff.reviewed.clear();
                self.message = "Diff feedback sent to Agent".into();
                self.terminal_focus = true;
            }
            Some(Err(error)) => {
                self.error = Some(format!("Could not send feedback to Agent: {error}"))
            }
            None => self.error = Some("Project Agent is not available".into()),
        }
    }

    fn handle_diff_key(&mut self, key: Key) {
        match key {
            Key::Char('h') => self.toggle_diff_directory(Some(true)),
            Key::Char('l') => self.toggle_diff_directory(Some(false)),
            Key::Enter => self.toggle_diff_directory(None),
            Key::Char('c') => self.open_diff_comment(false),
            Key::Char('C') => self.open_diff_comment(true),
            Key::Char('L') => self.open_diff_line_comment(),
            Key::Char('J') => self.move_diff_line(1),
            Key::Char('K') => self.move_diff_line(-1),
            Key::Char('s') => self.submit_diff_feedback(),
            Key::Char('r') => {
                if self.screen == Screen::Project {
                    self.refresh_project_diff();
                } else {
                    self.refresh_diff();
                }
            }
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
            Key::Esc => {
                if self.screen == Screen::Project {
                    self.screen = Screen::Board;
                    self.terminal_focus = false;
                } else {
                    self.close_detail();
                }
            }
            Key::Char('j') | Key::Down => self.diff.scroll = self.diff.scroll.saturating_add(1),
            Key::Char('k') | Key::Up => self.diff.scroll = self.diff.scroll.saturating_sub(1),
            _ => {}
        }
    }

    fn move_diff_line(&mut self, delta: i32) {
        let Some(parsed) = self.diff.parsed.as_ref() else {
            return;
        };
        if parsed.lines.is_empty() {
            return;
        }
        let next = (self.diff.line as i32 + delta)
            .clamp(0, parsed.lines.len().saturating_sub(1) as i32) as usize;
        self.diff.line = next;
        let visible = self.rows.saturating_sub(10).max(1) as usize;
        if next < self.diff.scroll as usize {
            self.diff.scroll = next as u16;
        } else if next >= self.diff.scroll as usize + visible {
            self.diff.scroll = (next + 1 - visible) as u16;
        }
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
        self.diff.line = 0;
        self.diff.parsed = None;
        self.diff.path = None;
        let Some(file) = self.diff.files.get(index) else {
            return;
        };
        let Some((worktree, target)) = self.diff_context() else {
            return;
        };
        let Some(owner) = self.active_diff_owner() else {
            return;
        };
        self.in_flight += 1;
        core_bridge::load_file_diff(
            worktree,
            target,
            owner,
            file.path.clone(),
            self.sender.clone(),
        );
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
        self.diff.line = parsed.hunk_starts[next];
        self.diff.scroll = parsed.hunk_starts[next] as u16;
    }

    pub fn active_diff_owner(&self) -> Option<String> {
        match self.screen {
            Screen::Detail if self.detail_tab == DetailTab::Diff => self.selected_card.clone(),
            Screen::Project
                if self
                    .project
                    .as_ref()
                    .is_some_and(|state| state.tab == ProjectTab::Diff) =>
            {
                self.project
                    .as_ref()
                    .map(|state| format!("project:{}", state.project_id))
            }
            _ => None,
        }
    }

    fn prepare_diff_owner(&mut self, owner: &str) {
        if self.diff_owner.as_deref() != Some(owner) {
            self.diff = DiffState::default();
            self.diff_owner = Some(owner.to_string());
        }
    }

    fn diff_context(&self) -> Option<(String, String)> {
        if self.screen == Screen::Project {
            let state = self.project.as_ref()?;
            let project = self
                .board
                .as_ref()?
                .projects
                .iter()
                .find(|project| project.id == state.project_id)?;
            return Some((project.path.clone(), project.target_branch.clone()));
        }
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
        self.prepare_diff_owner(&card_id);
        self.in_flight += 1;
        core_bridge::load_diff_files(
            Arc::clone(&self.store),
            card_id,
            worktree,
            target,
            self.sender.clone(),
        );
    }

    fn refresh_project_diff(&mut self) {
        let Some(state) = self.project.as_ref() else {
            return;
        };
        let owner = format!("project:{}", state.project_id);
        let Some((worktree, target)) = self.diff_context() else {
            self.error = Some("The project has no context for a diff".into());
            return;
        };
        self.prepare_diff_owner(&owner);
        self.in_flight += 1;
        core_bridge::load_diff_files(
            Arc::clone(&self.store),
            owner,
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
        let cwd = if tab == DetailTab::Agent {
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
                self.message = String::new();
                self.error = None;
            }
            Err(error) => self.error = Some(error),
        }
    }

    fn pi_workspace(&self, _tab: DetailTab) -> &TerminalWorkspace {
        &self.work
    }

    fn pi_workspace_mut(&mut self, _tab: DetailTab) -> &mut TerminalWorkspace {
        &mut self.work
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
        if key == Key::Ctrl('w') {
            self.terminal_focus = false;
            self.message = String::new();
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
            if key == Key::Ctrl('w') {
                self.global_terminal_focus = false;
                self.message = String::new();
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
        let selected = self.board.as_ref().and_then(|board| {
            (self.project_picker_cursor > 0)
                .then(|| board.projects.get(self.project_picker_cursor - 1))
                .flatten()
                .map(|project| project.id.clone())
        });
        self.overlay = None;
        if self.screen == Screen::Project {
            match selected {
                Some(project_id) => self.open_project_workspace(project_id),
                None => {
                    self.project_scope = None;
                    self.screen = Screen::Board;
                    self.terminal_focus = false;
                }
            }
            return;
        }
        self.project_scope = selected;
        self.recompute_rows();
    }

    fn start_superthread_config(&mut self) {
        let project = if self.screen == Screen::Project {
            self.project
                .as_ref()
                .and_then(|state| {
                    self.board.as_ref().and_then(|board| {
                        board
                            .projects
                            .iter()
                            .find(|project| project.id == state.project_id)
                    })
                })
                .cloned()
        } else {
            self.sidebar_project()
        };
        let Some(project) = project else {
            self.message = "Select a project to configure".into();
            return;
        };
        match self.store.superthread_project_config(&project.id) {
            Ok(config) => {
                self.superthread_config = Some(SuperthreadConfigState {
                    project_id: project.id,
                    enabled: config.enabled,
                    spaces: TextInput::new(config.spaces),
                    token_env: TextInput::new(config.api_token_env_var),
                    workspace_slug: TextInput::new(config.workspace_slug.unwrap_or_default()),
                    board_id: TextInput::new(config.board_id),
                    incoming: TextInput::new(config.incoming_column_ids.join(", ")),
                    default_incoming: TextInput::new(config.default_incoming_column_id),
                    in_progress: TextInput::new(config.in_progress_column_id),
                    done: TextInput::new(config.done_column_id),
                    focus: 0,
                });
                self.overlay = Some(Overlay::SuperthreadConfig);
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    fn discover_provider_boards(&mut self) {
        let Some(state) = self.superthread_config.as_ref() else {
            return;
        };
        if state.spaces.value.trim().is_empty() {
            self.message = "Enter the Superthread space before discovering".into();
            return;
        }
        self.in_flight += 1;
        self.message = "Discovering Superthread boards…".into();
        core_bridge::discover_superthread_boards(
            state.spaces.value.trim().to_string(),
            state.token_env.value.trim().to_string(),
            self.sender.clone(),
        );
    }

    fn handle_provider_boards_key(&mut self, key: Key) {
        match key {
            Key::Esc => self.overlay = Some(Overlay::SuperthreadConfig),
            Key::Char('j') | Key::Down => {
                self.provider_board_cursor = (self.provider_board_cursor + 1)
                    .min(self.provider_boards.len().saturating_sub(1));
            }
            Key::Char('k') | Key::Up => {
                self.provider_board_cursor = self.provider_board_cursor.saturating_sub(1);
            }
            Key::Enter => self.choose_provider_board(),
            _ => {}
        }
    }

    fn choose_provider_board(&mut self) {
        let Some(board) = self.provider_boards.get(self.provider_board_cursor) else {
            return;
        };
        let incoming = board
            .lists
            .iter()
            .filter(|list| list.behavior != "started" && list.behavior != "closed")
            .map(|list| list.id.clone())
            .collect::<Vec<_>>();
        let in_progress = board
            .lists
            .iter()
            .find(|list| list.behavior == "started")
            .map(|list| list.id.clone())
            .unwrap_or_default();
        let done = board
            .lists
            .iter()
            .find(|list| list.behavior == "closed")
            .map(|list| list.id.clone())
            .unwrap_or_default();
        let default_incoming = incoming.first().cloned().unwrap_or_default();
        let board_id = board.id.clone();
        let incoming = incoming.join(", ");
        if let Some(state) = self.superthread_config.as_mut() {
            state.board_id = TextInput::new(board_id);
            state.incoming = TextInput::new(incoming);
            state.default_incoming = TextInput::new(default_incoming);
            state.in_progress = TextInput::new(in_progress);
            state.done = TextInput::new(done);
        }
        self.overlay = Some(Overlay::SuperthreadConfig);
        self.provider_boards.clear();
    }

    fn submit_superthread_config(&mut self) {
        let Some(state) = self.superthread_config.as_ref() else {
            return;
        };
        let config = stacks_core::store::SuperthreadProjectConfig {
            enabled: state.enabled,
            spaces: state.spaces.value.trim().to_string(),
            api_token_env_var: state.token_env.value.trim().to_string(),
            workspace_slug: Some(state.workspace_slug.value.trim().to_string())
                .filter(|value| !value.is_empty()),
            board_id: state.board_id.value.trim().to_string(),
            incoming_column_ids: state
                .incoming
                .value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect(),
            default_incoming_column_id: state.default_incoming.value.trim().to_string(),
            in_progress_column_id: state.in_progress.value.trim().to_string(),
            done_column_id: state.done.value.trim().to_string(),
        };
        let project_id = state.project_id.clone();
        self.superthread_config = None;
        self.overlay = None;
        self.in_flight += 1;
        self.message = "Validating Superthread mapping…".into();
        core_bridge::configure_superthread_project(
            Arc::clone(&self.store),
            project_id,
            config,
            self.sender.clone(),
        );
    }

    fn handle_superthread_config_key(&mut self, key: Key) {
        const FIELDS: usize = 9;
        let Some(state) = self.superthread_config.as_mut() else {
            return;
        };
        match key {
            Key::Esc => {
                self.superthread_config = None;
                self.overlay = None;
            }
            Key::Ctrl('s') => self.submit_superthread_config(),
            Key::Ctrl('d') => self.discover_provider_boards(),
            Key::Tab => state.focus = (state.focus + 1) % FIELDS,
            Key::BackTab => state.focus = (state.focus + FIELDS - 1) % FIELDS,
            Key::Enter if state.focus == 0 => state.enabled = !state.enabled,
            Key::Enter if state.focus + 1 < FIELDS => state.focus += 1,
            Key::Enter => self.submit_superthread_config(),
            _ => match state.focus {
                1 => {
                    state.spaces.handle(&key);
                }
                2 => {
                    state.token_env.handle(&key);
                }
                3 => {
                    state.workspace_slug.handle(&key);
                }
                4 => {
                    state.board_id.handle(&key);
                }
                5 => {
                    state.incoming.handle(&key);
                }
                6 => {
                    state.default_incoming.handle(&key);
                }
                7 => {
                    state.in_progress.handle(&key);
                }
                8 => {
                    state.done.handle(&key);
                }
                _ => {
                    if key == Key::Char(' ') {
                        state.enabled = !state.enabled;
                    }
                }
            },
        }
    }

    fn sync_superthread_from_context(&mut self) {
        let project = if self.screen == Screen::Project {
            self.project
                .as_ref()
                .and_then(|state| {
                    self.board.as_ref().and_then(|board| {
                        board
                            .projects
                            .iter()
                            .find(|project| project.id == state.project_id)
                    })
                })
                .cloned()
        } else if self.focus == Focus::Board {
            self.selected_project().cloned().or_else(|| {
                self.selected_board_card()
                    .and_then(|card| {
                        self.board.as_ref().and_then(|board| {
                            board.projects.iter().find(|project| {
                                Some(project.id.as_str()) == card.project_id.as_deref()
                            })
                        })
                    })
                    .cloned()
            })
        } else {
            self.sidebar_project()
        };
        let Some(project) = project else {
            self.message = "Select a Superthread project to sync".into();
            return;
        };
        if project.kanban_source.as_deref() != Some("superthread") {
            self.message = "This project is not configured for Superthread".into();
            return;
        }
        self.in_flight += 1;
        self.message = "Syncing Superthread cards…".into();
        core_bridge::sync_superthread_project(
            Arc::clone(&self.store),
            project.id,
            true,
            self.sender.clone(),
        );
    }

    fn background_superthread_projects(&mut self) {
        let projects = self
            .board
            .as_ref()
            .map(|board| {
                board
                    .projects
                    .iter()
                    .filter(|project| project.kanban_source.as_deref() == Some("superthread"))
                    .map(|project| project.id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for project_id in projects {
            self.in_flight += 1;
            core_bridge::sync_superthread_project(
                Arc::clone(&self.store),
                project_id,
                false,
                self.sender.clone(),
            );
        }
    }

    fn sidebar_project(&self) -> Option<Project> {
        if self.focus == Focus::Sidebar && self.sidebar_cursor > 0 {
            self.board
                .as_ref()
                .and_then(|board| board.projects.get(self.sidebar_cursor - 1))
                .cloned()
        } else {
            self.selected_project().cloned()
        }
    }

    fn start_delete_project(&mut self) {
        let Some(project) = self.sidebar_project() else {
            self.message = "Select a project to delete".into();
            return;
        };
        self.open_confirm(ConfirmAction {
            title: format!("Delete {}?", project.name),
            detail: "This removes the project and its completed cards after active cards and worktrees are cleaned up. This cannot be undone.".into(),
            primary_label: "Delete".into(),
            destructive: true,
            workflow: None,
            release: None,
            project_delete: Some(project.id),
            relaunch: false,
        });
    }

    fn start_edit_project(&mut self) {
        let Some(project) = self.sidebar_project() else {
            self.message = "Select a project to edit".into();
            return;
        };
        self.edit_project = Some(EditProjectState {
            project_id: project.id.clone(),
            name: TextInput::new(project.name),
            path: TextInput::new(project.path),
            target_branch: TextInput::new(project.target_branch),
            start_work: TextInput::new(project.start_work_command.unwrap_or_default()),
            server: TextInput::new(project.server_command.unwrap_or_default()),
            console: TextInput::new(project.console_command.unwrap_or_default()),
            release_config: TextInput::new(project.release_config_path),
            releases_enabled: project.releases_enabled,
            focus: 0,
        });
        self.overlay = Some(Overlay::EditProject);
    }

    fn submit_edit_project(&mut self) {
        let Some(state) = self.edit_project.as_ref() else {
            return;
        };
        let update = stacks_core::store::ProjectSettingsUpdate {
            name: state.name.value.trim().to_string(),
            path: state.path.value.trim().to_string(),
            target_branch: state.target_branch.value.trim().to_string(),
            start_work_command: Some(state.start_work.value.trim().to_string()),
            server_command: Some(state.server.value.trim().to_string()),
            console_command: Some(state.console.value.trim().to_string()),
            releases_enabled: state.releases_enabled,
            release_config_path: state.release_config.value.trim().to_string(),
        };
        let project_id = state.project_id.clone();
        self.edit_project = None;
        self.overlay = None;
        self.in_flight += 1;
        self.message = "Saving project settings…".into();
        self.project_sessions.remove(&project_id);
        if self
            .project
            .as_ref()
            .is_some_and(|state| state.project_id == project_id)
        {
            self.project = None;
            if self.screen == Screen::Project {
                self.screen = Screen::Board;
            }
        }
        core_bridge::update_project(
            Arc::clone(&self.store),
            project_id,
            update,
            self.sender.clone(),
        );
    }

    fn handle_edit_project_key(&mut self, key: Key) {
        const FIELDS: usize = 8;
        let Some(state) = self.edit_project.as_mut() else {
            return;
        };
        match key {
            Key::Esc => {
                self.edit_project = None;
                self.overlay = None;
            }
            Key::Ctrl('s') => self.submit_edit_project(),
            Key::Tab => state.focus = (state.focus + 1) % FIELDS,
            Key::BackTab => state.focus = (state.focus + FIELDS - 1) % FIELDS,
            Key::Enter if state.focus == 7 => {
                state.releases_enabled = !state.releases_enabled;
            }
            Key::Enter if state.focus + 1 < FIELDS => {
                state.focus += 1;
            }
            Key::Enter => self.submit_edit_project(),
            _ => match state.focus {
                0 => {
                    state.name.handle(&key);
                }
                1 => {
                    state.path.handle(&key);
                }
                2 => {
                    state.target_branch.handle(&key);
                }
                3 => {
                    state.start_work.handle(&key);
                }
                4 => {
                    state.server.handle(&key);
                }
                5 => {
                    state.console.handle(&key);
                }
                6 => {
                    state.release_config.handle(&key);
                }
                7 => {
                    if key == Key::Char(' ') {
                        state.releases_enabled = !state.releases_enabled;
                    }
                }
                _ => {}
            },
        }
    }

    fn start_new_project(&mut self) {
        self.new_project = Some(NewProjectState {
            path: TextInput::default(),
            name: TextInput::default(),
            focus: 0,
        });
        self.overlay = Some(Overlay::NewProject);
    }

    fn submit_new_project(&mut self) {
        let Some(state) = self.new_project.as_ref() else {
            return;
        };
        let path = state.path.value.trim().to_string();
        if path.is_empty() {
            self.message = "Project directory is required".into();
            return;
        }
        let name = if state.name.value.trim().is_empty() {
            std::path::Path::new(&path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Project")
                .to_string()
        } else {
            state.name.value.trim().to_string()
        };
        self.new_project = None;
        self.overlay = None;
        self.in_flight += 1;
        self.message = format!("Adding project {name}…");
        core_bridge::create_project(Arc::clone(&self.store), name, path, self.sender.clone());
    }

    fn handle_new_project_key(&mut self, key: Key) {
        let Some(state) = self.new_project.as_mut() else {
            return;
        };
        match key {
            Key::Esc => {
                self.new_project = None;
                self.overlay = None;
            }
            Key::Tab => state.focus = 1 - state.focus,
            Key::Ctrl('s') => self.submit_new_project(),
            Key::Enter if state.focus == 0 => state.focus = 1,
            Key::Enter => self.submit_new_project(),
            _ => {
                if state.focus == 0 {
                    state.path.handle(&key);
                } else {
                    state.name.handle(&key);
                }
            }
        }
    }

    fn start_new_card(&mut self) {
        let Some(board) = self.board.as_ref() else {
            return;
        };
        if board.projects.is_empty() {
            self.error = Some("Add a project before creating a card".into());
            return;
        }
        let projects = board
            .projects
            .iter()
            .map(|project| {
                let kind = if project.kanban_source.as_deref() == Some("superthread") {
                    "superthread"
                } else {
                    "local"
                };
                (project.id.clone(), format!("{} · {kind}", project.name))
            })
            .collect::<Vec<_>>();
        let preferred = self
            .project_scope
            .as_deref()
            .or_else(|| {
                self.detail
                    .as_ref()
                    .and_then(|detail| detail.card.project_id.as_deref())
            })
            .or_else(|| {
                board
                    .projects
                    .iter()
                    .find(|project| project.kanban_source.as_deref() != Some("superthread"))
                    .map(|project| project.id.as_str())
            });
        let project_index = preferred
            .and_then(|id| projects.iter().position(|(project_id, _)| project_id == id))
            .unwrap_or(0);
        let project_id = projects[project_index].0.clone();
        let (title, content) = self
            .new_card_draft
            .take()
            .map(|(_, title, content)| (title, content))
            .unwrap_or_default();
        self.new_card = Some(NewCardState {
            project_id,
            projects,
            project_index,
            title: TextInput::new(title),
            content: TextArea::new(content),
            focus: 1,
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
            provider: detail.card.provider.clone(),
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
        if state.provider == "superthread" {
            core_bridge::finish_superthread_refinement(
                Arc::clone(&self.store),
                state.card_id,
                state.revision,
                state.content.value,
                self.sender.clone(),
            );
        } else {
            core_bridge::finish_refinement(
                Arc::clone(&self.store),
                state.card_id,
                state.revision,
                state.content.value,
                self.sender.clone(),
            );
        }
    }

    fn open_confirm(&mut self, action: ConfirmAction) {
        let delay = Duration::from_millis(self.preferences.confirmation_delay_ms);
        self.confirm = Some(Confirm::new(action, delay));
    }

    fn request_quit(&mut self) {
        if self.project.as_ref().is_some_and(|state| state.notes_dirty) {
            self.save_project_notes();
        }
        let busy = self.is_busy();
        if !busy || !self.preferences.confirm_close {
            self.quit = true;
            return;
        }
        self.open_confirm(ConfirmAction {
            title: "Quit Stacks TUI?".into(),
            detail: "Terminals and native Pi sessions started here will be stopped.".into(),
            primary_label: "Quit".into(),
            destructive: true,
            workflow: None,
            release: None,
            project_delete: None,
            relaunch: false,
        });
    }

    fn handle_confirm_key(&mut self, key: Key) {
        let Some(confirm) = self.confirm.as_mut() else {
            return;
        };
        match key {
            Key::Esc | Key::Char('n') | Key::Char('2') => {
                self.confirm = None;
                self.message = "Cancelled".into();
            }
            Key::Tab | Key::BackTab => confirm.toggle_focus(),
            Key::Char('1') | Key::Char('y') | Key::Enter => {
                // Numbered primary shortcut. The confirmation delay still
                // applies; focusing primary early must not bypass it.
                confirm.focus_primary = true;
                match confirm.outcome() {
                    ConfirmOutcome::Pending => {
                        self.message =
                            format!("Waiting for confirmation ({})", confirm.countdown());
                    }
                    ConfirmOutcome::Cancelled => {
                        self.confirm = None;
                        self.message = "Cancelled".into();
                    }
                    ConfirmOutcome::Confirmed => {
                        let action = self.confirm.take().unwrap().into_action();
                        self.run_confirm(action);
                    }
                }
            }
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
        } else if let Some(release) = action.release {
            self.in_flight += 1;
            self.message = format!("Preparing {} {}…", release.action_label(), release.version);
            core_bridge::prepare_release(
                Arc::clone(&self.store),
                release.project_id,
                release.version,
                release.action,
                release.setup,
                self.sender.clone(),
            );
        } else if let Some(project_id) = action.project_delete {
            self.in_flight += 1;
            self.message = "Deleting project…".into();
            core_bridge::delete_project(Arc::clone(&self.store), project_id, self.sender.clone());
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
                release: None,
                project_delete: None,
                relaunch: false,
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
            Overlay::NewProject => {
                self.handle_new_project_key(key);
                true
            }
            Overlay::EditProject => {
                self.handle_edit_project_key(key);
                true
            }
            Overlay::SuperthreadConfig => {
                self.handle_superthread_config_key(key);
                true
            }
            Overlay::ProviderBoards => {
                self.handle_provider_boards_key(key);
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
            Overlay::DiffComment => {
                self.handle_diff_comment_key(key);
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
        const FIELDS: usize = 8;
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
            1 => self.preferences.hide_done = !self.preferences.hide_done,
            2 => self.preferences.copy_on_select = !self.preferences.copy_on_select,
            3 => {
                let steps = [1_000, 2_000, 5_000, 10_000, 20_000, 50_000];
                let current = self.preferences.terminal_scrollback;
                let index = steps.iter().position(|step| *step == current).unwrap_or(3);
                let next = (index as i32 + delta).clamp(0, steps.len() as i32 - 1) as usize;
                self.preferences.terminal_scrollback = steps[next];
            }
            4 => self.preferences.confirm_close = !self.preferences.confirm_close,
            5 => self.preferences.confirm_delete = !self.preferences.confirm_delete,
            6 => {
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
            7 => {
                let current = self.preferences.terminal_font_size.unwrap_or(14) as i32;
                self.preferences.terminal_font_size = Some((current + delta).clamp(8, 32) as u32);
            }
            _ => {}
        }
        self.hide_done = self.preferences.hide_done;
        self.theme = theme::theme(self.depth, self.preferences.accent.as_deref());
        self.save_preferences();
        self.apply_workspace_preferences();
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
            Key::Tab => state.focus = (state.focus + 1) % 3,
            Key::BackTab => state.focus = (state.focus + 2) % 3,
            Key::Left | Key::Char('h') if state.focus == 0 => {
                state.project_index = state
                    .project_index
                    .saturating_sub(1)
                    .min(state.projects.len().saturating_sub(1));
                state.project_id = state.projects[state.project_index].0.clone();
            }
            Key::Right | Key::Char('l') if state.focus == 0 => {
                state.project_index =
                    (state.project_index + 1).min(state.projects.len().saturating_sub(1));
                state.project_id = state.projects[state.project_index].0.clone();
            }
            Key::Enter if state.focus < 2 => state.focus += 1,
            Key::Enter => self.submit_new_card(),
            Key::Ctrl('s') => self.submit_new_card(),
            _ => match state.focus {
                1 => {
                    state.title.handle(&key);
                }
                2 => {
                    state.content.handle(&key);
                }
                _ => {}
            },
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
            || self.work.panes.values().any(|pane| pane.alive())
            || self.terminals.panes.values().any(|pane| pane.alive())
            || self.server.panes.values().any(|pane| pane.alive())
            || self.console.panes.values().any(|pane| pane.alive())
            || self.project.as_ref().is_some_and(|state| {
                [
                    &state.agent,
                    &state.terminal,
                    &state.server,
                    &state.console,
                    &state.release.terminal,
                ]
                .iter()
                .any(|workspace| workspace.panes.values().any(|pane| pane.alive()))
            })
            || self.project_sessions.values().any(|state| {
                [
                    &state.agent,
                    &state.terminal,
                    &state.server,
                    &state.console,
                    &state.release.terminal,
                ]
                .iter()
                .any(|workspace| workspace.panes.values().any(|pane| pane.alive()))
            })
            || self.card_sessions.values().any(|sessions| {
                [
                    &sessions.terminals,
                    &sessions.work,
                    &sessions.server,
                    &sessions.console,
                ]
                .iter()
                .any(|workspace| workspace.panes.values().any(|pane| pane.alive()))
            })
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
        self.visible_detail_tabs()
            .iter()
            .position(|tab| *tab == self.detail_tab)
            .unwrap_or(0)
    }

    /// Drive time-based UI (confirmation focus) from the render loop.
    pub fn tick(&mut self) {
        if let Some(confirm) = self.confirm.as_mut() {
            if confirm.ready() && !confirm.focus_primary {
                confirm.focus_primary = true;
            }
        }
        if !self.headless
            && self.confirm.is_none()
            && self.overlay.is_none()
            && self.in_flight == 0
            && self.last_background_refresh.elapsed() >= Duration::from_secs(15)
        {
            self.last_background_refresh = Instant::now();
            self.selected_git_card = None;
            self.refresh_board();
            if self.screen == Screen::Detail {
                if let Some(card_id) = self.selected_card.clone() {
                    self.load_detail(card_id);
                }
            }
        }
        if !self.headless
            && self.confirm.is_none()
            && self.overlay.is_none()
            && self.in_flight == 0
            && self.last_pr_refresh.elapsed() >= Duration::from_secs(60)
        {
            self.last_pr_refresh = Instant::now();
            let projects = self
                .board
                .as_ref()
                .map(|board| {
                    board
                        .projects
                        .iter()
                        .filter(|project| {
                            project.delivery_workflow == DeliveryWorkflow::GithubPullRequest
                        })
                        .map(|project| (project.id.clone(), project.path.clone()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for (project_id, path) in projects {
                self.in_flight += 1;
                core_bridge::sync_project_pull_requests(
                    Arc::clone(&self.store),
                    project_id,
                    path,
                    self.sender.clone(),
                );
            }
        }
        if !self.headless
            && self.confirm.is_none()
            && self.overlay.is_none()
            && self.in_flight == 0
            && self.last_provider_refresh.elapsed() >= Duration::from_secs(300)
        {
            self.last_provider_refresh = Instant::now();
            self.background_superthread_projects();
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
}

fn release_action_label(action: ReleaseAction) -> &'static str {
    match action {
        ReleaseAction::Release => "Release",
        ReleaseAction::BuildAndTest => "Build & test",
        ReleaseAction::Publish => "Publish",
    }
}

fn next_patch_version(latest: &str) -> Option<String> {
    let raw = latest.trim().trim_start_matches('v');
    let mut parts = raw.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    Some(format!("{major}.{minor}.{}", patch + 1))
}

/// Flatten a group into parent-first hierarchy order. A card is indented only
/// when its parent is present in the same group; otherwise it is a root (for
/// example when the parent has a different effective status or is filtered out).
fn order_group_cards(cards: &[CardSummary]) -> Vec<(usize, usize)> {
    let ids: HashSet<&str> = cards.iter().map(|card| card.id.as_str()).collect();
    let mut children: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut roots = Vec::new();
    for (index, card) in cards.iter().enumerate() {
        match card
            .parent
            .as_ref()
            .filter(|parent| ids.contains(parent.id.as_str()))
        {
            Some(parent) => children.entry(parent.id.as_str()).or_default().push(index),
            None => roots.push(index),
        }
    }
    let key = |index: usize| {
        let card = &cards[index];
        (card.sort_order, card.created_at, card.id.clone())
    };
    roots.sort_by_key(|index| key(*index));
    for list in children.values_mut() {
        list.sort_by_key(|index| key(*index));
    }
    let mut ordered = Vec::new();
    let mut visited = HashSet::new();
    fn walk(
        index: usize,
        depth: usize,
        cards: &[CardSummary],
        children: &HashMap<&str, Vec<usize>>,
        visited: &mut HashSet<usize>,
        ordered: &mut Vec<(usize, usize)>,
    ) {
        if !visited.insert(index) {
            return;
        }
        ordered.push((index, depth));
        if let Some(list) = children.get(cards[index].id.as_str()) {
            for child in list {
                walk(*child, depth + 1, cards, children, visited, ordered);
            }
        }
    }
    for root in roots {
        walk(root, 0, cards, &children, &mut visited, &mut ordered);
    }
    // Defensive fallback for malformed cycles: show every remaining card as a
    // root rather than dropping it.
    for index in 0..cards.len() {
        if !visited.contains(&index) {
            walk(index, 0, cards, &children, &mut visited, &mut ordered);
        }
    }
    ordered
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
        self.maximized = false;
    }
}
