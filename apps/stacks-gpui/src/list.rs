//! Native LIST surface for the card #322 product-surface spike.
//!
//! This renders the surviving Stacks LIST from the real `workflow.sqlite3`
//! through `stacks-cards`. It deliberately does not reimplement workflow
//! transitions, GitHub/Superthread sync, done cleanup or card detail. Those
//! remain seams to the shipped Tauri app.

use std::{
    collections::HashMap,
    path::Path,
    time::{Duration, Instant},
};

use ghostty_vt::key::Action as KeyAction;
use gpui::{
    AnyElement, ClipboardItem, Context, FocusHandle, IntoElement, KeyDownEvent, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Render, ScrollStrategy,
    SharedString, UniformListScrollHandle, Window, canvas, div, prelude::*, px, relative, rgb,
    uniform_list,
};
use gpui_kit::component::{
    Disableable, Sizable,
    button::{Button, ButtonCustomVariant, ButtonVariant, ButtonVariants},
    spinner::Spinner,
    tag::{Tag, TagVariant},
    text::TextView,
};
use stacks_cards::{
    CardDetail, CardSnapshot, CardStatus, CardStore, CardSummary, DeliveryStep, GitStatus, Project,
    PullRequestIndicator, WorkGroup, delivery_step, group_cards, read_git_status, work_group,
};
use stacks_terminal::{
    keymap::{ghostty_key, ghostty_mods, is_text_input_key},
    pty::{Pty, PtyEvent},
    split_tree::{SplitDirection, SplitNode},
    terminal_model::{SearchInfo, TerminalModel},
    terminal_surface::{PreparedFrame, TerminalMetrics, prepare_frame},
};

use crate::{
    agent::{
        AgentConfig, AgentLifecycle, AgentView, card_pi_session_dir, extension_path,
        pi_sessions_dir, project_trusted, safe_session_key,
    },
    release::{self, ReleaseAction, ReleaseSetup, ReleaseState},
    shell::process_start,
};

const ROW_HEIGHT: f32 = 60.0;

#[derive(Clone, Debug)]
enum FlatRow {
    Header { group: WorkGroup, count: usize },
    Empty { group: WorkGroup },
    Card { index: usize },
}

#[derive(Clone, Debug)]
struct CardDrag {
    card_id: String,
    title: String,
    external_id: String,
}

struct CardDragPreview {
    title: String,
    external_id: String,
}

impl Render for CardDragPreview {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .w(px(440.0))
            .px_3()
            .py_2()
            .rounded_md()
            .bg(rgb(0x1b2633))
            .border_1()
            .border_color(rgb(0x3b5e7d))
            .shadow_lg()
            .child(
                div()
                    .text_xs()
                    .text_color(rgb(0x8ea3b8))
                    .child(format!("#{}", self.external_id)),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(rgb(0xe3edf6))
                    .truncate()
                    .child(self.title.clone()),
            )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProjectWorkspaceTab {
    Agent,
    Notes,
    Diff,
    Terminal,
    Release,
    Server,
    Console,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum TerminalOwner {
    Project(String),
    Card(String),
}

#[derive(Clone)]
struct ProjectTerminalState {
    layout: SplitNode,
    focused: String,
    maximized: Option<String>,
}

#[derive(Clone)]
struct ReleaseViewState {
    version: String,
    latest: String,
    setup: Option<ReleaseSetup>,
    state: Option<ReleaseState>,
    error: Option<String>,
    loading: bool,
    current_action: Option<ReleaseAction>,
    confirm_action: Option<ReleaseAction>,
    generation: u64,
}

impl Default for ReleaseViewState {
    fn default() -> Self {
        Self {
            version: String::new(),
            latest: "Loading…".into(),
            setup: None,
            state: None,
            error: None,
            loading: false,
            current_action: None,
            confirm_action: None,
            generation: 0,
        }
    }
}

struct ProjectWorkspaceState {
    project: Project,
    tab: ProjectWorkspaceTab,
    git: Option<GitStatus>,
    terminal: ProjectTerminalState,
    release: ReleaseViewState,
}

const APPROVE_AND_COMMIT_PROMPT: &str = "Review the completed work and Git diff. Stage and commit only the intended changes, using a descriptive message. Do not discard or overwrite unexpected changes to clean the worktree. If the worktree is already clean, verify the work is committed; do not create an empty commit. Report anything that prevents committing the intended work.";

trait StacksButtonPadding: Sized {
    fn padded(self) -> Self;
}

impl StacksButtonPadding for Button {
    fn padded(self) -> Self {
        self.h_auto().px_3().py_1p5()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DetailTab {
    Description,
    Agent,
    Diff,
    Terminal,
    Server,
    Console,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum ServiceKind {
    Server,
    Console,
    Terminal,
}

impl ServiceKind {
    fn label(self) -> &'static str {
        match self {
            Self::Server => "Server",
            Self::Console => "Console",
            Self::Terminal => "Terminal",
        }
    }
}

struct ServiceState {
    model: TerminalModel,
    metrics: TerminalMetrics,
    pty: Option<Pty>,
    generation: Option<String>,
    running: bool,
    error: Option<String>,
    selection_anchor: Option<(u16, u16)>,
    selecting: bool,
    search_open: bool,
    search_query: String,
    search_info: SearchInfo,
}

struct WorkflowConfirmation {
    card_id: String,
    action: stacks_cards::WorkflowAction,
    expected_revision: i64,
    title: String,
    detail: String,
    started: Instant,
    cancel_focus: FocusHandle,
    confirm_focus: FocusHandle,
}

#[derive(Clone)]
struct DetailState {
    card_id: String,
    summary: CardSummary,
    tab: DetailTab,
    history_expanded: bool,
    terminal: Option<ProjectTerminalState>,
    loading: bool,
    detail: Option<CardDetail>,
    error: Option<String>,
}

pub struct ListView {
    focus_handle: FocusHandle,
    store: CardStore,
    snapshot: Option<CardSnapshot>,
    project_filter: Option<String>,
    collapsed: [bool; 4],
    visible_cards: Vec<CardSummary>,
    rows: Vec<FlatRow>,
    card_order: Vec<String>,
    row_for_card: HashMap<String, usize>,
    keyboard_focused: Option<String>,
    scroll: UniformListScrollHandle,
    loading: bool,
    refreshing: bool,
    reordering: bool,
    workflow_action_pending: bool,
    pending_ship: Option<String>,
    deployment_pid: Option<u32>,
    deployment_card: Option<String>,
    workflow_confirmation: Option<WorkflowConfirmation>,
    workflow_confirmation_task: Option<gpui::Task<()>>,
    error: Option<String>,
    notice: Option<(String, Instant)>,
    detail: Option<DetailState>,
    project_workspace: Option<ProjectWorkspaceState>,
    project_agent: Option<gpui::Entity<AgentView>>,
    card_agent: Option<gpui::Entity<AgentView>>,
    git_statuses: HashMap<String, GitStatus>,
    services: HashMap<(String, ServiceKind), ServiceState>,
    git_generation: u64,
    git_in_flight: bool,
    #[cfg_attr(test, allow(dead_code))]
    poll_in_flight: bool,
    detail_generation: u64,
    detail_opened_at: Option<Instant>,
    detail_load_ms: Option<f64>,
    detail_metric_reported: bool,
    auto_open_done: bool,
    load_started: Instant,
    load_ms: Option<f64>,
    flatten_us: Option<f64>,
    metric_reported: bool,
    visible_range: std::ops::Range<usize>,
    _load_task: Option<gpui::Task<()>>,
}

impl ListView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let mut view = Self::empty(cx);
        view.reload(cx);
        #[cfg(not(test))]
        view.start_live_refresh(cx);
        view
    }

    fn empty(cx: &mut Context<Self>) -> Self {
        #[cfg(test)]
        {
            gpui_kit::init(cx);
            crate::theme::install(cx);
        }
        Self {
            focus_handle: cx.focus_handle(),
            store: CardStore::default_store(),
            snapshot: None,
            project_filter: None,
            collapsed: [false, false, false, true],
            visible_cards: Vec::new(),
            rows: Vec::new(),
            card_order: Vec::new(),
            row_for_card: HashMap::new(),
            keyboard_focused: None,
            scroll: UniformListScrollHandle::new(),
            loading: true,
            refreshing: false,
            reordering: false,
            workflow_action_pending: false,
            pending_ship: None,
            deployment_pid: None,
            deployment_card: None,
            workflow_confirmation: None,
            workflow_confirmation_task: None,
            error: None,
            notice: None,
            detail: None,
            project_workspace: None,
            project_agent: None,
            card_agent: None,
            git_statuses: HashMap::new(),
            services: HashMap::new(),
            git_generation: 0,
            git_in_flight: false,
            poll_in_flight: false,
            detail_generation: 0,
            detail_opened_at: None,
            detail_load_ms: None,
            detail_metric_reported: false,
            auto_open_done: false,
            load_started: Instant::now(),
            load_ms: None,
            flatten_us: None,
            metric_reported: false,
            visible_range: 0..0,
            _load_task: None,
        }
    }

    #[cfg(test)]
    fn with_snapshot(cx: &mut Context<Self>, snapshot: CardSnapshot, store: CardStore) -> Self {
        let mut view = Self::empty(cx);
        view.store = store;
        view.snapshot = Some(snapshot);
        view.loading = false;
        view.refreshing = false;
        view.rebuild_rows();
        view.keyboard_focused = view.card_order.first().cloned();
        view
    }

    pub fn focus_handle(&self) -> FocusHandle {
        self.focus_handle.clone()
    }

    pub fn reload_from_shell(&mut self, cx: &mut Context<Self>) {
        self.reload(cx);
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        if self.refreshing {
            return;
        }
        self.refreshing = true;
        self.loading = self.snapshot.is_none();
        self.error = None;
        self.load_started = Instant::now();
        let store = self.store.clone();
        let task = cx.background_executor().spawn(async move {
            let started = Instant::now();
            let result = store.load_snapshot();
            (result, started.elapsed().as_secs_f64() * 1000.0)
        });
        self._load_task = Some(cx.spawn(async move |this, cx| {
            let (result, duration_ms) = task.await;
            let _ = this.update(cx, |view, cx| {
                view.refreshing = false;
                view.loading = false;
                view.load_ms = Some(duration_ms);
                match result {
                    Ok(snapshot) => {
                        view.apply_snapshot(snapshot, cx);
                        if !view.auto_open_done
                            && let Ok(target) = std::env::var("STACKS_GPUI_OPEN_CARD")
                            && let Some(card) = view.snapshot.as_ref().and_then(|snapshot| {
                                snapshot
                                    .cards
                                    .iter()
                                    .find(|card| card.id == target || card.external_id == target)
                            })
                        {
                            let card_id = card.id.clone();
                            view.auto_open_done = true;
                            view.open_card(card_id, cx);
                        }
                    }
                    Err(error) => {
                        view.error = Some(format!("{error:#}"));
                        if view.snapshot.is_some() {
                            view.notice =
                                Some((format!("Refresh failed: {error}"), Instant::now()));
                        }
                    }
                }
                cx.notify();
            });
        }));
    }

    fn apply_snapshot(&mut self, snapshot: CardSnapshot, cx: &mut Context<Self>) {
        if self
            .project_filter
            .as_deref()
            .is_some_and(|id| !snapshot.projects.iter().any(|project| project.id == id))
        {
            self.project_filter = None;
        }
        let environment_card_ids = snapshot
            .cards
            .iter()
            .filter(|card| card.environment.is_some())
            .map(|card| card.id.clone())
            .collect::<std::collections::HashSet<_>>();
        self.git_statuses
            .retain(|card_id, _| environment_card_ids.contains(card_id));
        self.snapshot = Some(snapshot);
        self.error = None;
        self.rebuild_rows();
        if self
            .keyboard_focused
            .as_deref()
            .is_none_or(|id| !self.row_for_card.contains_key(id))
        {
            self.keyboard_focused = self.card_order.first().cloned();
        }
        self.load_git_statuses(cx);
        cx.notify();
    }

    fn load_git_statuses(&mut self, cx: &mut Context<Self>) {
        if self.git_in_flight {
            return;
        }
        let Some(snapshot) = self.snapshot.as_ref() else {
            return;
        };
        let paths = snapshot
            .cards
            .iter()
            .filter_map(|card| {
                card.environment
                    .as_ref()
                    .map(|environment| (card.id.clone(), environment.worktree_path.clone()))
            })
            .collect::<Vec<_>>();
        if paths.is_empty() {
            return;
        }
        self.git_generation += 1;
        let generation = self.git_generation;
        self.git_in_flight = true;
        let task = cx.background_executor().spawn(async move {
            paths
                .into_iter()
                .filter_map(|(card_id, path)| {
                    read_git_status(Path::new(&path)).map(|status| (card_id, status))
                })
                .collect::<HashMap<_, _>>()
        });
        cx.spawn(async move |this, cx| {
            let statuses = task.await;
            let _ = this.update(cx, |view, cx| {
                view.git_in_flight = false;
                if view.git_generation == generation {
                    if std::env::var_os("STACKS_GPUI_TRACE_GIT").is_some() {
                        eprintln!("STACKS_GPUI_GIT statuses={statuses:?}");
                    }
                    view.git_statuses = statuses;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    #[cfg_attr(test, allow(dead_code))]
    fn start_live_refresh(&mut self, cx: &mut Context<Self>) {
        let store = self.store.clone();
        cx.spawn(async move |this, cx| {
            let interval = std::env::var("STACKS_GPUI_POLL_MS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(2_000)
                .clamp(500, 10_000);
            let mut tick = 0_u64;
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(interval))
                    .await;
                tick += 1;
                let should_poll = this
                    .update(cx, |view, _| {
                        if view.refreshing || view.reordering || view.poll_in_flight {
                            false
                        } else {
                            view.poll_in_flight = true;
                            true
                        }
                    })
                    .unwrap_or(false);
                if !should_poll {
                    if tick % 3 == 0 {
                        let _ = this.update(cx, |view, cx| view.load_git_statuses(cx));
                    }
                    continue;
                }
                let poll_store = store.clone();
                let snapshot = cx
                    .background_executor()
                    .spawn(async move { poll_store.load_snapshot() })
                    .await;
                let _ = this.update(cx, |view, cx| {
                    view.poll_in_flight = false;
                    if let Ok(snapshot) = snapshot
                        && view
                            .snapshot
                            .as_ref()
                            .is_none_or(|current| snapshot_changed(current, &snapshot))
                    {
                        if std::env::var_os("STACKS_GPUI_TRACE_POLL").is_some() {
                            eprintln!("STACKS_GPUI_POLL changed cards={}", snapshot.cards.len());
                        }
                        view.apply_snapshot(snapshot, cx);
                    }
                });
                if tick % 3 == 0 {
                    let _ = this.update(cx, |view, cx| view.load_git_statuses(cx));
                }
            }
        })
        .detach();
    }

    fn rebuild_rows(&mut self) {
        let started = Instant::now();
        let Some(snapshot) = self.snapshot.as_ref() else {
            self.visible_cards.clear();
            self.rows.clear();
            self.card_order.clear();
            self.row_for_card.clear();
            return;
        };
        let flattened = flatten_rows(snapshot, self.project_filter.as_deref(), self.collapsed);
        self.visible_cards = flattened.visible_cards;
        self.rows = flattened.rows;
        self.card_order = flattened.card_order;
        self.row_for_card = flattened.row_for_card;
        self.flatten_us = Some(started.elapsed().as_secs_f64() * 1_000_000.0);
    }

    pub fn palette_projects(&self) -> Vec<(Option<String>, String)> {
        let mut projects = vec![(None, "ALL PROJECTS".to_string())];
        if let Some(snapshot) = self.snapshot.as_ref() {
            projects.extend(
                projects_alphabetically(&snapshot.projects)
                    .into_iter()
                    .map(|project| (Some(project.id.clone()), project.name.clone())),
            );
        }
        projects
    }

    pub fn palette_cards(&self) -> Vec<(String, String, String)> {
        self.snapshot
            .as_ref()
            .map(|snapshot| {
                snapshot
                    .cards
                    .iter()
                    .map(|card| {
                        (
                            card.id.clone(),
                            card.external_id.clone(),
                            card.title.clone(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn open_project_workspace_from_shell(
        &mut self,
        project_id: String,
        cx: &mut Context<Self>,
    ) {
        self.open_project_workspace(project_id, cx);
    }

    pub fn set_project_filter_from_shell(
        &mut self,
        project_id: Option<String>,
        cx: &mut Context<Self>,
    ) {
        self.set_project_filter(project_id, cx);
    }

    pub fn open_card_from_shell(&mut self, card_id: String, cx: &mut Context<Self>) {
        self.open_card(card_id, cx);
    }

    fn filter_project_by_index(&mut self, index: usize, cx: &mut Context<Self>) {
        if index == 0 {
            self.set_project_filter(None, cx);
            return;
        }
        let Some(snapshot) = self.snapshot.as_ref() else {
            return;
        };
        let Some(project) = projects_alphabetically(&snapshot.projects)
            .get(index - 1)
            .map(|project| project.id.clone())
        else {
            return;
        };
        self.set_project_filter(Some(project), cx);
    }

    fn set_project_filter(&mut self, project_id: Option<String>, cx: &mut Context<Self>) {
        if self.project_filter == project_id {
            return;
        }
        self.project_filter = project_id;
        self.keyboard_focused = None;
        self.rebuild_rows();
        self.keyboard_focused = self.card_order.first().cloned();
        self.scroll.scroll_to_item(0, ScrollStrategy::Top);
        cx.notify();
    }

    fn toggle_group(&mut self, group: WorkGroup, cx: &mut Context<Self>) {
        let index = group_index(group);
        self.collapsed[index] = !self.collapsed[index];
        self.rebuild_rows();
        cx.notify();
    }

    fn focus_card(&mut self, card_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if !self.row_for_card.contains_key(card_id) {
            return;
        }
        self.keyboard_focused = Some(card_id.to_string());
        self.focus_handle.focus(window, cx);
        if let Some(row) = self.row_for_card.get(card_id).copied() {
            self.scroll.scroll_to_item(row, ScrollStrategy::Center);
        }
        cx.notify();
    }

    fn navigate(&mut self, delta: isize, window: &mut Window, cx: &mut Context<Self>) {
        if self.card_order.is_empty() {
            return;
        }
        let current = self
            .keyboard_focused
            .as_deref()
            .and_then(|id| self.card_order.iter().position(|entry| entry == id))
            .unwrap_or(0) as isize;
        let next = (current + delta).clamp(0, self.card_order.len() as isize - 1);
        let card_id = self.card_order[next as usize].clone();
        self.focus_card(&card_id, window, cx);
    }

    fn open_focused(&mut self, cx: &mut Context<Self>) {
        let Some(card_id) = self.keyboard_focused.clone() else {
            return;
        };
        self.open_card(card_id, cx);
    }

    fn open_card(&mut self, card_id: String, cx: &mut Context<Self>) {
        let Some(card) = self
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.cards.iter().find(|card| card.id == card_id))
            .cloned()
        else {
            return;
        };
        self.detail_generation += 1;
        let generation = self.detail_generation;
        self.detail_opened_at = Some(Instant::now());
        self.detail_load_ms = None;
        self.detail_metric_reported = false;
        self.detail = Some(DetailState {
            card_id: card_id.clone(),
            summary: card.clone(),
            tab: DetailTab::Description,
            history_expanded: false,
            terminal: None,
            loading: true,
            detail: None,
            error: None,
        });
        let store = self.store.clone();
        let task = cx.background_executor().spawn(async move {
            let started = Instant::now();
            let result = store.load_detail(&card_id);
            (result, started.elapsed().as_secs_f64() * 1000.0)
        });
        cx.spawn(async move |this, cx| {
            let (result, load_ms) = task.await;
            let _ = this.update(cx, |view, cx| {
                if view.detail_generation != generation {
                    return;
                }
                view.detail_load_ms = Some(load_ms);
                let Some(state) = view.detail.as_mut() else {
                    return;
                };
                state.loading = false;
                match result {
                    Ok(detail) => state.detail = Some(detail),
                    Err(error) => state.error = Some(format!("{error:#}")),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn open_project_workspace(&mut self, project_id: String, cx: &mut Context<Self>) {
        let Some(project) = self
            .snapshot
            .as_ref()
            .and_then(|snapshot| {
                snapshot
                    .projects
                    .iter()
                    .find(|project| project.id == project_id)
            })
            .cloned()
        else {
            return;
        };
        let card_id = self.detail.as_ref().map(|state| state.card_id.clone());
        let terminal_panes = self
            .detail
            .as_ref()
            .and_then(|state| state.terminal.as_ref())
            .map(|terminal| terminal.layout.leaves())
            .unwrap_or_default();
        if let Some(card_id) = card_id {
            self.stop_card_services(&card_id);
            for pane_id in terminal_panes {
                self.stop_owner_services(&card_terminal_owner_id(&card_id, &pane_id));
            }
        }
        self.detail = None;
        let pane_id = new_project_terminal_pane_id();
        let owner_id = project_terminal_owner_id(&project.id, &pane_id);
        #[cfg(test)]
        let _ = &owner_id;
        #[cfg(not(test))]
        self.start_service(
            owner_id,
            ServiceKind::Terminal,
            project.path.clone(),
            None,
            cx,
        );
        self.project_workspace = Some(ProjectWorkspaceState {
            project: project.clone(),
            tab: ProjectWorkspaceTab::Terminal,
            git: None,
            terminal: ProjectTerminalState {
                layout: SplitNode::leaf(pane_id.clone()),
                focused: pane_id,
                maximized: None,
            },
            release: ReleaseViewState::default(),
        });
        let path = project.path.clone();
        let workspace_project_id = project.id.clone();
        let task = cx
            .background_executor()
            .spawn(async move { read_git_status(Path::new(&path)) });
        cx.spawn(async move |this, cx| {
            let git = task.await;
            let _ = this.update(cx, |view, cx| {
                if view
                    .project_workspace
                    .as_ref()
                    .is_some_and(|workspace| workspace.project.id == workspace_project_id)
                {
                    if let Some(workspace) = view.project_workspace.as_mut() {
                        workspace.git = git;
                    }
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    fn close_project_workspace(&mut self, cx: &mut Context<Self>) {
        let services = self.project_workspace.as_ref().map(|workspace| {
            (
                workspace.project.id.clone(),
                workspace.terminal.layout.leaves(),
            )
        });
        if let Some((project_id, pane_ids)) = services {
            self.stop_owner_services(&project_owner_id(&project_id));
            self.stop_owner_services(&project_release_owner_id(&project_id));
            for pane_id in pane_ids {
                self.stop_owner_services(&project_terminal_owner_id(&project_id, &pane_id));
            }
        }
        self.project_workspace = None;
        self.project_agent = None;
        cx.notify();
    }

    fn set_project_workspace_tab(&mut self, tab: ProjectWorkspaceTab, cx: &mut Context<Self>) {
        let Some(workspace) = self.project_workspace.as_mut() else {
            return;
        };
        if !project_workspace_tab_visible(&workspace.project, tab) {
            return;
        }
        workspace.tab = tab;
        if tab == ProjectWorkspaceTab::Agent {
            self.ensure_project_agent(cx);
        } else if tab == ProjectWorkspaceTab::Release {
            self.load_project_release(cx);
        }
        cx.notify();
    }

    fn render_project_workspace(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let Some(workspace) = self.project_workspace.as_ref() else {
            return div().into_any_element();
        };
        let project = &workspace.project;
        let owner_id = project_owner_id(&project.id);
        let accent = project_accent(project.color_id.as_deref());
        let git = match workspace.git.as_ref() {
            Some(GitStatus::Ok(counts)) => format!(
                "Git +{} ~{} -{}",
                counts.created, counts.changed, counts.deleted
            ),
            Some(GitStatus::Error { .. }) => "Git status unavailable".into(),
            None => project.path.clone(),
        };
        let tabs = [
            (ProjectWorkspaceTab::Agent, "Agent"),
            (ProjectWorkspaceTab::Notes, "Notes"),
            (ProjectWorkspaceTab::Diff, "Diff"),
            (ProjectWorkspaceTab::Terminal, "Terminal"),
            (ProjectWorkspaceTab::Release, "Releases"),
            (ProjectWorkspaceTab::Server, "Server"),
            (ProjectWorkspaceTab::Console, "Console"),
        ]
        .into_iter()
        .filter(|(tab, _)| project_workspace_tab_visible(project, *tab))
        .map(|(tab, label)| {
            let active = workspace.tab == tab;
            div()
                .id(SharedString::from(format!("project-tab-{label}")))
                .flex()
                .items_center()
                .h_full()
                .px_3()
                .cursor_pointer()
                .text_xs()
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(if active {
                    rgb(crate::theme::TEXT_STRONG)
                } else {
                    rgb(crate::theme::TEXT_MUTED)
                })
                .border_b_2()
                .border_color(if active {
                    accent
                } else {
                    gpui::rgba(0x00000000).into()
                })
                .hover(|style| style.bg(rgb(crate::theme::SURFACE_RAISED)))
                .on_click(cx.listener(move |view, _, _, cx| {
                    cx.stop_propagation();
                    view.set_project_workspace_tab(tab, cx);
                }))
                .child(label.to_uppercase())
        })
        .collect::<Vec<_>>();

        let body = match workspace.tab {
            ProjectWorkspaceTab::Terminal => self.render_terminal_workspace(
                &TerminalOwner::Project(project.id.clone()),
                &project.path,
                &workspace.terminal,
                cx,
            ),
            ProjectWorkspaceTab::Server => self.render_service_panel(
                owner_id,
                ServiceKind::Server,
                project.server_command.clone(),
                project.path.clone(),
                cx,
            ),
            ProjectWorkspaceTab::Console => self.render_service_panel(
                owner_id,
                ServiceKind::Console,
                project.console_command.clone(),
                project.path.clone(),
                cx,
            ),
            ProjectWorkspaceTab::Agent => self
                .project_agent
                .as_ref()
                .map(|agent| agent.clone().into_any_element())
                .unwrap_or_else(|| {
                    self.render_project_placeholder("Agent", "Starting the native Pi agent…", cx)
                }),
            ProjectWorkspaceTab::Notes => {
                let notes = project.notes.trim();
                div()
                    .id("project-notes")
                    .size_full()
                    .overflow_y_scroll()
                    .child(div().max_w(px(860.0)).mx_auto().px_6().py_5().child(
                        if notes.is_empty() {
                            div()
                                .text_sm()
                                .text_color(rgb(crate::theme::TEXT_MUTED))
                                .child("No project notes.")
                                .into_any_element()
                        } else {
                            TextView::markdown(
                                SharedString::from(format!("project-notes-{}", project.id)),
                                project.notes.clone(),
                            )
                            .selectable(true)
                            .into_any_element()
                        },
                    ))
                    .into_any_element()
            }
            ProjectWorkspaceTab::Diff => self.render_project_placeholder(
                "Diff",
                "The native project diff view is not ported yet.",
                cx,
            ),
            ProjectWorkspaceTab::Release => self.render_release_tab(workspace, cx),
        };

        div()
            .absolute()
            .top(px(0.0))
            .left(px(0.0))
            .right(px(0.0))
            .bottom(px(0.0))
            .occlude()
            .flex()
            .flex_col()
            .bg(rgb(crate::theme::CANVAS))
            .child(
                div()
                    .relative()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .px_5()
                    .pt_4()
                    .pb_3()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .pr(px(36.0))
                            .child(
                                div()
                                    .text_xs()
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .text_color(rgb(crate::theme::TEXT_FAINT))
                                    .child("PROJECT WORKSPACE"),
                            )
                            .child(
                                Tag::custom(accent.opacity(0.18), accent, accent.opacity(0.45))
                                    .px_3()
                                    .child(project.name.clone()),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(rgb(crate::theme::TEXT_MUTED))
                                    .child(git),
                            ),
                    )
                    .child(
                        div()
                            .pr(px(36.0))
                            .text_2xl()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(rgb(crate::theme::TEXT_STRONG))
                            .child(project.name.clone()),
                    )
                    .child(
                        div().absolute().top(px(12.0)).right(px(12.0)).child(
                            Button::new("project-workspace-close")
                                .small()
                                .padded()
                                .label("X")
                                .on_click(cx.listener(|view, _, _, cx| {
                                    view.close_project_workspace(cx);
                                })),
                        ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .h(px(42.0))
                    .px_4()
                    .flex_shrink_0()
                    .border_b_1()
                    .border_color(rgb(crate::theme::BORDER))
                    .children(tabs),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .when(workspace.tab == ProjectWorkspaceTab::Agent, |this| {
                        this.pt(px(12.0))
                    })
                    .child(body),
            )
            .into_any_element()
    }

    fn load_project_release(&mut self, cx: &mut Context<Self>) {
        let Some(workspace) = self.project_workspace.as_ref() else {
            return;
        };
        if workspace.release.loading {
            return;
        }
        let project = workspace.project.clone();
        let project_id = project.id.clone();
        if let Some(workspace) = self.project_workspace.as_mut() {
            workspace.release.generation += 1;
            workspace.release.loading = true;
            workspace.release.error = None;
            workspace.release.latest = "Loading…".into();
        }
        let generation = self
            .project_workspace
            .as_ref()
            .map(|workspace| workspace.release.generation)
            .unwrap_or(0);
        let task = cx.background_executor().spawn(async move {
            let setup = release::load_setup(&project);
            let latest = if setup.is_ok() {
                release::latest(&project).unwrap_or_else(|error| format!("Unavailable — {error}"))
            } else {
                "Unavailable".into()
            };
            let state = if setup.is_ok() {
                release::state(&project, "").ok().flatten()
            } else {
                None
            };
            (setup, latest, state)
        });
        cx.spawn(async move |this, cx| {
            let (setup, latest, state) = task.await;
            let _ = this.update(cx, |view, cx| {
                let Some(workspace) = view.project_workspace.as_mut() else {
                    return;
                };
                if workspace.project.id != project_id || workspace.release.generation != generation
                {
                    return;
                }
                workspace.release.loading = false;
                workspace.release.latest = latest.clone();
                match setup {
                    Ok(setup) => {
                        workspace.release.setup = Some(setup);
                        workspace.release.error = None;
                        if workspace.release.version.trim().is_empty() {
                            workspace.release.version = state
                                .as_ref()
                                .and_then(|state| state.version.clone())
                                .and_then(|version| release::normalize_version(&version))
                                .or_else(|| release::next_patch_version(&latest))
                                .unwrap_or_default();
                        }
                        workspace.release.state = state;
                    }
                    Err(error) => {
                        workspace.release.setup = None;
                        workspace.release.error = Some(format!("{error:#}"));
                    }
                }
                cx.notify();
                view.schedule_release_state(cx);
            });
        })
        .detach();
    }

    fn schedule_release_state(&mut self, cx: &mut Context<Self>) {
        let Some(workspace) = self.project_workspace.as_ref() else {
            return;
        };
        let project = workspace.project.clone();
        let project_id = project.id.clone();
        let version = workspace.release.version.trim().to_string();
        if version.is_empty() {
            if let Some(workspace) = self.project_workspace.as_mut() {
                workspace.release.state = None;
            }
            return;
        }
        if let Some(workspace) = self.project_workspace.as_mut() {
            workspace.release.generation += 1;
        }
        let generation = self
            .project_workspace
            .as_ref()
            .map(|workspace| workspace.release.generation)
            .unwrap_or(0);
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(250))
                .await;
            let task = cx
                .background_executor()
                .spawn(async move { release::state(&project, &version) });
            let result = task.await;
            let _ = this.update(cx, |view, cx| {
                let Some(workspace) = view.project_workspace.as_mut() else {
                    return;
                };
                if workspace.project.id != project_id || workspace.release.generation != generation
                {
                    return;
                }
                match result {
                    Ok(state) => {
                        workspace.release.state = state;
                        workspace.release.error = None;
                    }
                    Err(error) => {
                        workspace.release.error = Some(format!("{error:#}"));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn handle_release_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) -> bool {
        if event.keystroke.modifiers.platform
            || event.keystroke.modifiers.control
            || event.keystroke.modifiers.alt
        {
            return false;
        }
        match event.keystroke.key.as_str() {
            "backspace" => {
                if let Some(workspace) = self.project_workspace.as_mut() {
                    workspace.release.version.pop();
                }
                self.schedule_release_state(cx);
                cx.notify();
                true
            }
            _ => {
                if let Some(text) = event.keystroke.key_char.as_deref()
                    && !text.is_empty()
                    && !text.chars().any(char::is_control)
                {
                    if let Some(workspace) = self.project_workspace.as_mut() {
                        workspace.release.version.push_str(text);
                    }
                    self.schedule_release_state(cx);
                    cx.notify();
                    return true;
                }
                false
            }
        }
    }

    fn run_release_action(&mut self, action: ReleaseAction, cx: &mut Context<Self>) {
        if let Some(workspace) = self.project_workspace.as_mut() {
            workspace.release.confirm_action = None;
        }
        let Some(workspace) = self.project_workspace.as_ref() else {
            return;
        };
        if self.service_running(
            &project_release_owner_id(&workspace.project.id),
            ServiceKind::Terminal,
        ) {
            return;
        }
        let project = workspace.project.clone();
        let version = workspace.release.version.trim().to_string();
        if version.is_empty() || workspace.release.setup.is_none() {
            return;
        }
        match release::action_command(&project, &version, action) {
            Ok((command, setup)) => {
                let owner_id = project_release_owner_id(&project.id);
                self.stop_service(&owner_id, ServiceKind::Terminal, cx);
                self.start_service(
                    owner_id,
                    ServiceKind::Terminal,
                    setup.cwd,
                    Some(command),
                    cx,
                );
                if let Some(workspace) = self.project_workspace.as_mut() {
                    workspace.release.error = None;
                    workspace.release.current_action = Some(action);
                }
            }
            Err(error) => {
                if let Some(workspace) = self.project_workspace.as_mut() {
                    workspace.release.error = Some(format!("{error:#}"));
                }
            }
        }
        cx.notify();
    }

    fn render_release_tab(
        &self,
        workspace: &ProjectWorkspaceState,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let release = &workspace.release;
        let owner_id = project_release_owner_id(&workspace.project.id);
        let running = self.service_running(&owner_id, ServiceKind::Terminal);
        let version = release.version.trim();
        let draft_ready = release
            .state
            .as_ref()
            .is_some_and(|state| state.version.as_deref() == Some(version) && state.draft_ready);
        let published = release
            .state
            .as_ref()
            .is_some_and(|state| state.version.as_deref() == Some(version) && state.published);
        let disabled = release.setup.is_none() || version.is_empty() || running;
        let status = if running {
            "Running".to_string()
        } else if release.current_action.is_some() {
            "Finished".to_string()
        } else {
            "Ready".to_string()
        };

        let controls = div()
            .flex()
            .items_center()
            .gap_3()
            .px_5()
            .py_3()
            .border_b_1()
            .border_color(rgb(crate::theme::BORDER))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .text_xs()
                            .text_color(rgb(crate::theme::TEXT_MUTED))
                            .child("VERSION"),
                    )
                    .child(
                        div()
                            .id("release-version")
                            .min_w(px(140.0))
                            .px_3()
                            .py_1()
                            .rounded_md()
                            .bg(rgb(crate::theme::SURFACE_RAISED))
                            .border_1()
                            .border_color(rgb(crate::theme::FOCUS))
                            .font_family("Menlo")
                            .text_sm()
                            .text_color(if version.is_empty() {
                                rgb(crate::theme::TEXT_MUTED)
                            } else {
                                rgb(crate::theme::TEXT_STRONG)
                            })
                            .child(if version.is_empty() {
                                "type a version…".to_string()
                            } else {
                                format!("{version}▌")
                            }),
                    ),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(rgb(crate::theme::TEXT_MUTED))
                    .child(format!("Latest release: {}", release.latest)),
            )
            .child(div().flex_1())
            .child(
                div()
                    .text_xs()
                    .text_color(if running {
                        rgb(crate::theme::WARNING)
                    } else {
                        rgb(crate::theme::TEXT_MUTED)
                    })
                    .child(status),
            )
            .when(!draft_ready && !published, |this| {
                this.child(
                    Button::new("release-action")
                        .small()
                        .padded()
                        .label("RELEASE")
                        .disabled(disabled)
                        .on_click(cx.listener(|view, _, _, cx| {
                            if let Some(workspace) = view.project_workspace.as_mut() {
                                workspace.release.confirm_action = Some(ReleaseAction::Release);
                            }
                            cx.notify();
                        })),
                )
            })
            .when(draft_ready, |this| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(rgb(crate::theme::SUCCESS))
                        .child("Draft ready"),
                )
                .when(
                    release
                        .setup
                        .as_ref()
                        .is_some_and(|setup| setup.can_build_and_test),
                    |this| {
                        this.child(
                            Button::new("release-build-test")
                                .small()
                                .padded()
                                .label("BUILD & TEST")
                                .disabled(disabled)
                                .on_click(cx.listener(|view, _, _, cx| {
                                    if let Some(workspace) = view.project_workspace.as_mut() {
                                        workspace.release.confirm_action =
                                            Some(ReleaseAction::BuildAndTest);
                                    }
                                    cx.notify();
                                })),
                        )
                    },
                )
                .when(
                    release
                        .setup
                        .as_ref()
                        .is_some_and(|setup| setup.can_publish),
                    |this| {
                        this.child(
                            Button::new("release-publish")
                                .small()
                                .padded()
                                .primary()
                                .label("PUBLISH")
                                .disabled(disabled)
                                .on_click(cx.listener(|view, _, _, cx| {
                                    if let Some(workspace) = view.project_workspace.as_mut() {
                                        workspace.release.confirm_action =
                                            Some(ReleaseAction::Publish);
                                    }
                                    cx.notify();
                                })),
                        )
                    },
                )
            })
            .when(published, |this| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(rgb(crate::theme::SUCCESS))
                        .child("Published"),
                )
            })
            .child(
                Button::new("release-refresh")
                    .small()
                    .padded()
                    .label("REFRESH")
                    .disabled(running)
                    .on_click(cx.listener(|view, _, _, cx| {
                        view.load_project_release(cx);
                    })),
            );

        let output = if self
            .services
            .contains_key(&(owner_id.clone(), ServiceKind::Terminal))
        {
            self.render_service_panel(
                owner_id,
                ServiceKind::Terminal,
                None,
                workspace.project.path.clone(),
                cx,
            )
        } else {
            div()
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .text_sm()
                .text_color(rgb(crate::theme::TEXT_MUTED))
                .child(if release.loading {
                    "Loading release configuration…"
                } else if release.error.is_some() {
                    "Release output will appear here once started."
                } else {
                    "Run a release action to show output."
                })
                .into_any_element()
        };

        let confirmation = release.confirm_action.map(|action| {
            let version = version.to_string();
            (action, version)
        });
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(controls)
            .when_some(confirmation, |this, (action, version)| {
                let label = action.label();
                let warning = if action == ReleaseAction::Publish {
                    "Publish this verified draft as the latest release for updater users."
                } else {
                    "This may create commits, push tags, upload artifacts, or publish."
                };
                this.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_3()
                        .px_5()
                        .py_2()
                        .bg(rgb(0x2b2418))
                        .border_b_1()
                        .border_color(rgb(0x6b552a))
                        .child(
                            div()
                                .flex_1()
                                .text_xs()
                                .text_color(rgb(crate::theme::WARNING))
                                .child(format!("{label} {version}? {warning}")),
                        )
                        .child(
                            Button::new("release-confirm")
                                .small()
                                .padded()
                                .primary()
                                .label("CONFIRM")
                                .on_click(cx.listener(move |view, _, _, cx| {
                                    view.run_release_action(action, cx);
                                })),
                        )
                        .child(
                            Button::new("release-cancel")
                                .small()
                                .padded()
                                .label("CANCEL")
                                .on_click(cx.listener(|view, _, _, cx| {
                                    if let Some(workspace) = view.project_workspace.as_mut() {
                                        workspace.release.confirm_action = None;
                                    }
                                    cx.notify();
                                })),
                        ),
                )
            })
            .when_some(release.error.clone(), |this, error| {
                this.child(
                    div()
                        .px_5()
                        .py_2()
                        .bg(rgb(0x3a2530))
                        .text_xs()
                        .text_color(rgb(crate::theme::DANGER))
                        .child(error),
                )
            })
            .child(div().flex_1().min_h_0().child(output))
            .into_any_element()
    }

    fn render_terminal_workspace(
        &self,
        owner: &TerminalOwner,
        path: &str,
        terminal: &ProjectTerminalState,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let focused = terminal.focused.clone();
        if let Some(maximized) = terminal.maximized.as_ref()
            && terminal.layout.contains(maximized)
        {
            return self.render_terminal_node(
                owner,
                path,
                &SplitNode::leaf(maximized.clone()),
                &focused,
                cx,
            );
        }
        self.render_terminal_node(owner, path, &terminal.layout, &focused, cx)
    }

    fn render_terminal_node(
        &self,
        owner: &TerminalOwner,
        path: &str,
        node: &SplitNode,
        focused: &str,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        match node {
            SplitNode::Leaf { pane_id } => {
                let owner_id = terminal_owner_id(owner, pane_id);
                let click_owner = owner.clone();
                let click_pane = pane_id.clone();
                let is_focused = focused == pane_id;
                div()
                    .size_full()
                    .min_w_0()
                    .min_h_0()
                    .border_1()
                    .border_color(if is_focused {
                        rgb(crate::theme::FOCUS)
                    } else {
                        rgb(crate::theme::BORDER_SUBTLE)
                    })
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |view, _, window, cx| {
                            view.set_terminal_focus(&click_owner, &click_pane, window, cx);
                        }),
                    )
                    .child(self.render_service_panel(
                        owner_id,
                        ServiceKind::Terminal,
                        None,
                        path.to_string(),
                        cx,
                    ))
                    .into_any_element()
            }
            SplitNode::Split {
                direction,
                ratio,
                first,
                second,
                ..
            } => {
                let first = self.render_terminal_node(owner, path, first, focused, cx);
                let second = self.render_terminal_node(owner, path, second, focused, cx);
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

    fn render_card_terminal(
        &self,
        detail: &CardDetail,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let Some(terminal) = self
            .detail
            .as_ref()
            .and_then(|state| state.terminal.as_ref())
        else {
            return self.render_detail_placeholder(
                "Terminal",
                "The card terminal is still starting.",
                cx,
            );
        };
        let Some(path) = detail
            .card
            .environment
            .as_ref()
            .map(|environment| environment.worktree_path.clone())
        else {
            return self.render_detail_placeholder("Terminal", "This card has no environment.", cx);
        };
        self.render_terminal_workspace(
            &TerminalOwner::Card(detail.card.id.clone()),
            &path,
            terminal,
            cx,
        )
    }

    fn terminal_target(&self) -> Option<(TerminalOwner, String, ProjectTerminalState)> {
        if let Some(workspace) = self.project_workspace.as_ref()
            && workspace.tab == ProjectWorkspaceTab::Terminal
        {
            return Some((
                TerminalOwner::Project(workspace.project.id.clone()),
                workspace.project.path.clone(),
                workspace.terminal.clone(),
            ));
        }
        let detail = self.detail.as_ref()?;
        if detail.tab != DetailTab::Terminal {
            return None;
        }
        let terminal = detail.terminal.as_ref()?.clone();
        let path = detail
            .summary
            .environment
            .as_ref()
            .map(|environment| environment.worktree_path.clone())?;
        Some((TerminalOwner::Card(detail.card_id.clone()), path, terminal))
    }

    fn store_terminal_state(&mut self, owner: &TerminalOwner, terminal: ProjectTerminalState) {
        match owner {
            TerminalOwner::Project(project_id) => {
                if let Some(workspace) = self.project_workspace.as_mut()
                    && workspace.project.id == *project_id
                {
                    workspace.terminal = terminal;
                }
            }
            TerminalOwner::Card(card_id) => {
                if let Some(detail) = self.detail.as_mut()
                    && detail.card_id == *card_id
                {
                    detail.terminal = Some(terminal);
                }
            }
        }
    }

    fn set_terminal_focus(
        &mut self,
        owner: &TerminalOwner,
        pane_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some((_, _, mut terminal)) = self.terminal_target() {
            terminal.focused = pane_id.to_string();
            terminal.maximized = None;
            self.store_terminal_state(owner, terminal);
        }
        self.focus_handle.focus(window, cx);
        cx.notify();
    }

    fn split_active_terminal(&mut self, direction: SplitDirection, cx: &mut Context<Self>) {
        let Some((owner, path, terminal)) = self.terminal_target() else {
            return;
        };
        let focused = terminal.focused.clone();
        let pane_id = new_project_terminal_pane_id();
        let layout = terminal.layout.split(&focused, &pane_id, direction);
        self.store_terminal_state(
            &owner,
            ProjectTerminalState {
                layout,
                focused: pane_id.clone(),
                maximized: None,
            },
        );
        #[cfg(not(test))]
        self.start_service(
            terminal_owner_id(&owner, &pane_id),
            ServiceKind::Terminal,
            path,
            None,
            cx,
        );
        #[cfg(test)]
        let _ = (&owner, &path, &pane_id);
        cx.notify();
    }

    fn close_active_terminal_pane(&mut self, cx: &mut Context<Self>) {
        let Some((owner, _path, terminal)) = self.terminal_target() else {
            return;
        };
        if terminal.layout.leaves().len() <= 1 {
            return;
        }
        let focused = terminal.focused.clone();
        let Some(layout) = terminal.layout.remove(&focused) else {
            return;
        };
        let next_focus = layout.leaves().last().cloned().unwrap_or_default();
        self.store_terminal_state(
            &owner,
            ProjectTerminalState {
                layout,
                focused: next_focus,
                maximized: None,
            },
        );
        self.stop_owner_services(&terminal_owner_id(&owner, &focused));
        cx.notify();
    }

    fn toggle_active_terminal_maximize(&mut self, cx: &mut Context<Self>) {
        let Some((owner, _path, mut terminal)) = self.terminal_target() else {
            return;
        };
        let focused = terminal.focused.clone();
        terminal.maximized = if terminal.maximized.as_deref() == Some(&focused) {
            None
        } else {
            Some(focused)
        };
        self.store_terminal_state(&owner, terminal);
        cx.notify();
    }

    fn navigate_active_terminal(&mut self, direction: i8, cx: &mut Context<Self>) {
        let Some((owner, _path, mut terminal)) = self.terminal_target() else {
            return;
        };
        let focused = terminal.focused.clone();
        if let Some(next) = terminal.layout.relative_pane(&focused, direction) {
            terminal.focused = next.clone();
            if terminal.maximized.is_some() {
                terminal.maximized = Some(next);
            }
            self.store_terminal_state(&owner, terminal);
            cx.notify();
        }
    }

    fn render_project_placeholder(
        &self,
        label: &str,
        message: &str,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        div()
            .flex_1()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap_3()
            .p_6()
            .child(
                div()
                    .text_lg()
                    .text_color(rgb(crate::theme::TEXT_STRONG))
                    .child(format!("{label} is not ported yet")),
            )
            .child(
                div()
                    .max_w(px(520.0))
                    .text_sm()
                    .text_color(rgb(crate::theme::TEXT_MUTED))
                    .child(message.to_string()),
            )
            .child(
                Button::new(SharedString::from(format!("project-back-{label}")))
                    .small()
                    .padded()
                    .label("BACK TO TERMINAL")
                    .on_click(cx.listener(|view, _, _, cx| {
                        view.set_project_workspace_tab(ProjectWorkspaceTab::Terminal, cx);
                    })),
            )
            .into_any_element()
    }

    fn close_detail(&mut self, cx: &mut Context<Self>) {
        let card_id = self.detail.as_ref().map(|state| state.card_id.clone());
        let terminal_panes = self
            .detail
            .as_ref()
            .and_then(|state| state.terminal.as_ref())
            .map(|terminal| terminal.layout.leaves())
            .unwrap_or_default();
        if let Some(card_id) = card_id {
            self.stop_card_services(&card_id);
            for pane_id in terminal_panes {
                self.stop_owner_services(&card_terminal_owner_id(&card_id, &pane_id));
            }
        }
        self.detail = None;
        self.card_agent = None;
        self.detail_generation += 1;
        cx.notify();
    }

    fn set_detail_tab(&mut self, tab: DetailTab, cx: &mut Context<Self>) {
        let Some(state) = self.detail.as_mut() else {
            return;
        };
        let Some(projects) = self.snapshot.as_ref().map(|snapshot| &snapshot.projects) else {
            return;
        };
        if !detail_tab_enabled(&state.summary, projects, tab) {
            return;
        }
        state.tab = tab;
        if tab == DetailTab::Terminal {
            self.ensure_card_terminal(cx);
        } else if tab == DetailTab::Agent {
            self.ensure_card_agent(cx);
        }
        cx.notify();
    }

    fn request_workflow_confirmation(
        &mut self,
        card_id: String,
        action: stacks_cards::WorkflowAction,
        expected_revision: i64,
        title: String,
        detail: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let cancel_focus = cx.focus_handle();
        let confirm_focus = cx.focus_handle();
        cancel_focus.focus(window, cx);
        self.workflow_confirmation = Some(WorkflowConfirmation {
            card_id,
            action,
            expected_revision,
            title,
            detail,
            started: Instant::now(),
            cancel_focus,
            confirm_focus,
        });
        self.workflow_confirmation_task = Some(cx.spawn(async move |this, cx| {
            let mut confirm_focused = false;
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(100))
                    .await;
                let stop = this
                    .update_in(cx, |view, window, cx| {
                        let Some(confirmation) = view.workflow_confirmation.as_ref() else {
                            return true;
                        };
                        if !confirm_focused
                            && confirmation.started.elapsed() >= Duration::from_secs(2)
                        {
                            confirm_focused = true;
                            confirmation.confirm_focus.focus(window, cx);
                        }
                        cx.notify();
                        false
                    })
                    .unwrap_or(true);
                if stop {
                    break;
                }
            }
        }));
        cx.notify();
    }

    fn render_workflow_confirmation(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let Some(confirmation) = self.workflow_confirmation.as_ref() else {
            return div().into_any_element();
        };
        let elapsed = confirmation.started.elapsed();
        let remaining = 2_i64.saturating_sub(elapsed.as_secs() as i64);
        let ready = elapsed >= Duration::from_secs(2);
        let card_id = confirmation.card_id.clone();
        let action = confirmation.action;
        let expected_revision = confirmation.expected_revision;
        div()
            .absolute()
            .top(px(0.0))
            .left(px(0.0))
            .right(px(0.0))
            .bottom(px(0.0))
            .occlude()
            .flex()
            .items_center()
            .justify_center()
            .bg(gpui::rgba(0x000000b8))
            .child(
                div()
                    .w(px(430.0))
                    .max_w(relative(0.9))
                    .p_5()
                    .rounded_lg()
                    .bg(rgb(crate::theme::SURFACE))
                    .border_1()
                    .border_color(rgb(crate::theme::BORDER))
                    .shadow_lg()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(rgb(crate::theme::TEXT_STRONG))
                            .child(confirmation.title.clone()),
                    )
                    .child(
                        div()
                            .mt_3()
                            .text_sm()
                            .text_color(rgb(crate::theme::TEXT_MUTED))
                            .child(confirmation.detail.clone()),
                    )
                    .child(
                        div()
                            .mt_5()
                            .flex()
                            .justify_end()
                            .gap_2()
                            .child(
                                Button::new("workflow-confirm-cancel")
                                    .small()
                                    .padded()
                                    .label("CANCEL")
                                    .track_focus(&confirmation.cancel_focus)
                                    .on_click(cx.listener(|view, _, _, cx| {
                                        view.workflow_confirmation = None;
                                        view.workflow_confirmation_task = None;
                                        cx.notify();
                                    })),
                            )
                            .child(
                                Button::new("workflow-confirm-action")
                                    .small()
                                    .padded()
                                    .danger()
                                    .w(px(150.0))
                                    .disabled(!ready)
                                    .label(if ready {
                                        "CONFIRM".to_string()
                                    } else {
                                        format!("CONFIRM ({remaining}s)")
                                    })
                                    .track_focus(&confirmation.confirm_focus)
                                    .on_click(cx.listener(move |view, _, _, cx| {
                                        let Some(confirmation) = view.workflow_confirmation.take()
                                        else {
                                            return;
                                        };
                                        view.workflow_confirmation_task = None;
                                        view.apply_workflow_action(
                                            card_id.clone(),
                                            action,
                                            expected_revision,
                                            cx,
                                        );
                                        let _ = confirmation;
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
            .into_any_element()
    }

    fn start_scripted_deployment(&mut self, card_id: String, cx: &mut Context<Self>) {
        if self.deployment_pid.is_some() {
            self.notice = Some(("A deployment is already running".into(), Instant::now()));
            cx.notify();
            return;
        }
        let deployment = match self.store.begin_scripted_deploy(&card_id) {
            Ok(deployment) => deployment,
            Err(error) => {
                self.notice = Some((format!("Could not deploy: {error:#}"), Instant::now()));
                cx.notify();
                return;
            }
        };
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut command = std::process::Command::new(&shell);
        command
            .args(["-lic", "eval -- \"$STACKS_DEPLOY_COMMAND\""])
            .current_dir(&deployment.cwd)
            .env("STACKS_DEPLOY_COMMAND", &deployment.command)
            .env("STACKS_CARD_ID", &deployment.card_id)
            .env("STACKS_PROJECT_ID", &deployment.project_id)
            .env("STACKS_PROJECT_PATH", &deployment.cwd)
            .env("STACKS_TARGET_BRANCH", &deployment.target_branch)
            .env("STACKS_SOURCE_REVISION", &deployment.source_revision)
            .env("STACKS_MERGE_REVISION", &deployment.merge_revision)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let _ = self.store.finish_scripted_deploy(
                    &card_id,
                    false,
                    Some(format!("Could not start deployment command: {error}")),
                );
                self.notice = Some((
                    format!("Could not start deployment: {error}"),
                    Instant::now(),
                ));
                cx.notify();
                return;
            }
        };
        let pid = child.id();
        self.deployment_pid = Some(pid);
        self.deployment_card = Some(card_id.clone());
        if let Ok(snapshot) = self.store.load_snapshot() {
            self.apply_snapshot(snapshot, cx);
        }
        self.open_card(card_id, cx);
        self.reload(cx);
        self.notice = Some(("Deployment running".into(), Instant::now()));
        let (sender, receiver) = async_channel::bounded(1);
        std::thread::spawn(move || {
            let output = child.wait_with_output();
            let (success, error) = match output {
                Ok(output) => (
                    output.status.success(),
                    (!output.status.success())
                        .then(|| String::from_utf8_lossy(&output.stderr).trim().to_string()),
                ),
                Err(error) => (false, Some(error.to_string())),
            };
            let _ = sender.send_blocking((pid, success, error));
        });
        cx.spawn(async move |this, cx| {
            if let Ok((pid, success, error)) = receiver.recv().await {
                let _ = this.update(cx, |view, cx| {
                    view.finish_scripted_deployment(pid, success, error, cx)
                });
            }
        })
        .detach();
        cx.notify();
    }

    fn finish_scripted_deployment(
        &mut self,
        pid: u32,
        success: bool,
        error: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if self.deployment_pid != Some(pid) {
            return;
        }
        self.deployment_pid = None;
        let Some(card_id) = self.deployment_card.take() else {
            return;
        };
        if let Err(error) = self
            .store
            .finish_scripted_deploy(&card_id, success, error.clone())
        {
            self.notice = Some((
                format!("Could not record deployment result: {error:#}"),
                Instant::now(),
            ));
        } else {
            self.notice = Some((
                if success {
                    "Deployment completed".into()
                } else {
                    format!(
                        "Deployment failed{}",
                        error
                            .as_deref()
                            .map(|error| format!(": {error}"))
                            .unwrap_or_default()
                    )
                },
                Instant::now(),
            ));
        }
        if let Ok(snapshot) = self.store.load_snapshot() {
            self.apply_snapshot(snapshot, cx);
        }
        self.open_card(card_id, cx);
        self.reload(cx);
        cx.notify();
    }

    fn cancel_scripted_deployment(&mut self, card_id: String, cx: &mut Context<Self>) {
        let Some(pid) = self.deployment_pid.take() else {
            self.notice = Some((
                "No supervised deployment is running in this window".into(),
                Instant::now(),
            ));
            cx.notify();
            return;
        };
        self.deployment_card = None;
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .status();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(750));
            let _ = std::process::Command::new("kill")
                .args(["-KILL", &format!("-{pid}")])
                .status();
        });
        if let Err(error) = self.store.cancel_scripted_deploy(&card_id) {
            self.notice = Some((
                format!("Could not cancel deployment: {error:#}"),
                Instant::now(),
            ));
        } else {
            self.notice = Some(("Deployment cancelled".into(), Instant::now()));
        }
        if let Ok(snapshot) = self.store.load_snapshot() {
            self.apply_snapshot(snapshot, cx);
        }
        self.open_card(card_id, cx);
        self.reload(cx);
        cx.notify();
    }

    fn apply_workflow_action(
        &mut self,
        card_id: String,
        action: stacks_cards::WorkflowAction,
        expected_revision: i64,
        cx: &mut Context<Self>,
    ) {
        if action == stacks_cards::WorkflowAction::OpenPr {
            let url = self
                .detail
                .as_ref()
                .and_then(|state| state.summary.pull_request.as_ref())
                .map(|pull_request| pull_request.url.clone());
            if let Some(url) = url
                && let Err(error) = std::process::Command::new("open").arg(&url).spawn()
            {
                self.notice = Some((
                    format!("Could not open pull request: {error}"),
                    Instant::now(),
                ));
            }
            return;
        }
        if action == stacks_cards::WorkflowAction::MergeTarget {
            if self.workflow_action_pending {
                return;
            }
            self.workflow_action_pending = true;
            cx.notify();
            let result = self.store.merge_target_into_card(&card_id);
            self.workflow_action_pending = false;
            match result {
                Ok(()) => {
                    if let Ok(snapshot) = self.store.load_snapshot() {
                        self.apply_snapshot(snapshot, cx);
                    }
                    let tab = self
                        .detail
                        .as_ref()
                        .map(|state| state.tab)
                        .unwrap_or(DetailTab::Agent);
                    self.open_card(card_id, cx);
                    self.set_detail_tab(tab, cx);
                    self.reload(cx);
                    self.notice = Some(("Merged target into card worktree".into(), Instant::now()));
                }
                Err(error) => {
                    self.notice = Some((format!("Target merge failed: {error:#}"), Instant::now()));
                }
            }
            cx.notify();
            return;
        }
        if matches!(
            action,
            stacks_cards::WorkflowAction::Deploy
                | stacks_cards::WorkflowAction::RetryDeploy
                | stacks_cards::WorkflowAction::RunDeploymentAgain
        ) {
            self.start_scripted_deployment(card_id, cx);
            return;
        }
        if action == stacks_cards::WorkflowAction::CancelDeployment {
            self.cancel_scripted_deployment(card_id, cx);
            return;
        }
        if matches!(
            action,
            stacks_cards::WorkflowAction::Push
                | stacks_cards::WorkflowAction::RetryPush
                | stacks_cards::WorkflowAction::ConfirmDeployed
        ) {
            if self.workflow_action_pending {
                return;
            }
            self.workflow_action_pending = true;
            cx.notify();
            let result = match action {
                stacks_cards::WorkflowAction::Push | stacks_cards::WorkflowAction::RetryPush => {
                    self.store.push_scripted_card(&card_id)
                }
                _ => self.store.confirm_scripted_deployed(&card_id),
            };
            self.workflow_action_pending = false;
            match result {
                Ok(()) => {
                    if let Ok(snapshot) = self.store.load_snapshot() {
                        self.apply_snapshot(snapshot, cx);
                    }
                    let tab = self
                        .detail
                        .as_ref()
                        .map(|state| state.tab)
                        .unwrap_or(DetailTab::Description);
                    self.open_card(card_id, cx);
                    self.set_detail_tab(tab, cx);
                    self.reload(cx);
                    self.notice = Some((
                        match action {
                            stacks_cards::WorkflowAction::Push
                            | stacks_cards::WorkflowAction::RetryPush => {
                                "Target branch pushed and verified"
                            }
                            _ => "Deployment outcome confirmed",
                        }
                        .into(),
                        Instant::now(),
                    ));
                }
                Err(error) => {
                    self.notice = Some((
                        format!("Scripted delivery failed: {error:#}"),
                        Instant::now(),
                    ));
                }
            }
            cx.notify();
            return;
        }
        if matches!(
            action,
            stacks_cards::WorkflowAction::CreatePr | stacks_cards::WorkflowAction::CreatePrWithFe
        ) {
            if self.workflow_action_pending {
                return;
            }
            self.workflow_action_pending = true;
            cx.notify();
            let result = self.store.create_pull_request(
                &card_id,
                action == stacks_cards::WorkflowAction::CreatePrWithFe,
            );
            self.workflow_action_pending = false;
            match result {
                Ok(()) => {
                    if let Ok(snapshot) = self.store.load_snapshot() {
                        self.apply_snapshot(snapshot, cx);
                    }
                    let tab = self
                        .detail
                        .as_ref()
                        .map(|state| state.tab)
                        .unwrap_or(DetailTab::Agent);
                    self.open_card(card_id, cx);
                    self.set_detail_tab(tab, cx);
                    self.reload(cx);
                    self.notice = Some(("Pull request created".into(), Instant::now()));
                }
                Err(error) => {
                    self.notice = Some((
                        format!("Could not create pull request: {error:#}"),
                        Instant::now(),
                    ));
                }
            }
            cx.notify();
            return;
        }
        if action == stacks_cards::WorkflowAction::MergePr {
            if self.workflow_action_pending {
                return;
            }
            self.workflow_action_pending = true;
            cx.notify();
            let result = self.store.merge_pull_request(&card_id);
            self.workflow_action_pending = false;
            match result {
                Ok(()) => {
                    if let Ok(snapshot) = self.store.load_snapshot() {
                        self.apply_snapshot(snapshot, cx);
                    }
                    let tab = self
                        .detail
                        .as_ref()
                        .map(|state| state.tab)
                        .unwrap_or(DetailTab::Agent);
                    self.open_card(card_id, cx);
                    self.set_detail_tab(tab, cx);
                    self.reload(cx);
                    self.notice = Some(("Pull request merged".into(), Instant::now()));
                }
                Err(error) => {
                    self.notice = Some((
                        format!("Could not merge pull request: {error:#}"),
                        Instant::now(),
                    ));
                }
            }
            cx.notify();
            return;
        }
        if action == stacks_cards::WorkflowAction::Cleanup {
            if self.workflow_action_pending {
                return;
            }
            self.workflow_action_pending = true;
            self.pending_ship = None;
            self.close_detail(cx);
            let result = self.store.cleanup_local_card(&card_id);
            self.workflow_action_pending = false;
            match result {
                Ok(()) => {
                    if let Ok(snapshot) = self.store.load_snapshot() {
                        self.apply_snapshot(snapshot, cx);
                    }
                    self.reload(cx);
                    self.notice = Some(("Card resources cleaned up".into(), Instant::now()));
                }
                Err(error) => {
                    self.open_card(card_id, cx);
                    self.notice = Some((format!("Cleanup failed: {error:#}"), Instant::now()));
                }
            }
            cx.notify();
            return;
        }
        if action == stacks_cards::WorkflowAction::MergeLocal {
            if self.workflow_action_pending {
                return;
            }
            self.workflow_action_pending = true;
            cx.notify();
            let result = self.store.merge_local_card(&card_id);
            self.workflow_action_pending = false;
            match result {
                Ok(()) => {
                    if let Ok(snapshot) = self.store.load_snapshot() {
                        self.apply_snapshot(snapshot, cx);
                    }
                    let tab = self
                        .detail
                        .as_ref()
                        .map(|state| state.tab)
                        .unwrap_or(DetailTab::Description);
                    self.open_card(card_id, cx);
                    self.set_detail_tab(tab, cx);
                    self.notice = Some(("Merged locally".into(), Instant::now()));
                }
                Err(error) => {
                    self.notice = Some((format!("Merge failed: {error:#}"), Instant::now()));
                }
            }
            cx.notify();
            return;
        }
        if action == stacks_cards::WorkflowAction::Ship {
            if self.workflow_action_pending || self.pending_ship.is_some() {
                return;
            }
            self.set_detail_tab(DetailTab::Agent, cx);
            let agent = self.card_agent.clone();
            let Some(agent) = agent else {
                self.notice = Some((
                    "The card work agent is not available".into(),
                    Instant::now(),
                ));
                cx.notify();
                return;
            };
            let ready = agent.read(cx).is_ready();
            if !ready {
                self.notice = Some((
                    "Wait for the card work agent to finish before approving".into(),
                    Instant::now(),
                ));
                cx.notify();
                return;
            }
            self.pending_ship = Some(card_id.clone());
            let _ = agent.update(cx, |agent, cx| {
                agent.prompt(APPROVE_AND_COMMIT_PROMPT.to_string(), cx);
            });
            self.notice = Some((
                "Asked the work agent to commit; approval will finalize when it settles".into(),
                Instant::now(),
            ));
            cx.notify();
            return;
        }
        if action == stacks_cards::WorkflowAction::StartWork {
            if self.workflow_action_pending {
                return;
            }
            self.workflow_action_pending = true;
            cx.notify();
            let result = self.store.start_local_work(&card_id, expected_revision);
            self.workflow_action_pending = false;
            match result {
                Ok(()) => {
                    if let Ok(snapshot) = self.store.load_snapshot() {
                        self.apply_snapshot(snapshot, cx);
                    }
                    self.open_card(card_id, cx);
                    self.set_detail_tab(DetailTab::Agent, cx);
                    self.notice = Some((
                        "Worktree created; work agent started".into(),
                        Instant::now(),
                    ));
                }
                Err(error) => {
                    self.notice =
                        Some((format!("Could not start work: {error:#}"), Instant::now()));
                }
            }
            cx.notify();
            return;
        }
        if self.workflow_action_pending {
            return;
        }
        if action == stacks_cards::WorkflowAction::RequestChanges
            && self.detail.as_ref().is_some_and(|state| {
                state.card_id == card_id && state.summary.status == CardStatus::NeedsHuman
            })
        {
            self.set_detail_tab(DetailTab::Agent, cx);
            return;
        }
        self.workflow_action_pending = true;
        cx.notify();
        let result = self
            .store
            .apply_local_action(&card_id, action, expected_revision);
        self.workflow_action_pending = false;
        match result {
            Ok(()) => {
                if action == stacks_cards::WorkflowAction::StopRefinement {
                    self.card_agent = None;
                }
                if action == stacks_cards::WorkflowAction::Close {
                    self.pending_ship = None;
                    self.close_detail(cx);
                    let mut cleanup_errors = Vec::new();
                    for thread in ["planning", "work"] {
                        let directory = card_pi_session_dir(&card_id, thread);
                        if directory.exists()
                            && let Err(error) = std::fs::remove_dir_all(&directory)
                        {
                            cleanup_errors
                                .push(format!("pi_session {}: {error}", directory.display()));
                        }
                    }
                    if let Err(error) = self
                        .store
                        .complete_local_runtime_cleanup(&card_id, &cleanup_errors)
                    {
                        cleanup_errors.push(format!("runtime_cleanup: {error:#}"));
                    }
                    self.reload(cx);
                    self.notice = Some((
                        if cleanup_errors.is_empty() {
                            "Card closed and runtime cleanup completed".into()
                        } else {
                            format!("Card closed; cleanup issue: {}", cleanup_errors[0])
                        },
                        Instant::now(),
                    ));
                    cx.notify();
                    return;
                }
                if action == stacks_cards::WorkflowAction::Delete {
                    self.pending_ship = None;
                    self.close_detail(cx);
                    self.reload(cx);
                    self.notice = Some(("Card deleted".into(), Instant::now()));
                    cx.notify();
                    return;
                }
                let tab = if matches!(
                    action,
                    stacks_cards::WorkflowAction::OpenRefinement
                        | stacks_cards::WorkflowAction::ReturnToRefinement
                        | stacks_cards::WorkflowAction::RequestChanges
                ) {
                    DetailTab::Agent
                } else {
                    self.detail
                        .as_ref()
                        .map(|state| state.tab)
                        .unwrap_or(DetailTab::Description)
                };
                self.open_card(card_id, cx);
                self.set_detail_tab(tab, cx);
                self.reload(cx);
                self.notice = Some((format!("{} completed", action.label()), Instant::now()));
            }
            Err(error) => {
                self.notice = Some((format!("Workflow action failed: {error:#}"), Instant::now()));
            }
        }
        cx.notify();
    }

    fn workflow_action_confirmation(
        card: &CardSummary,
        action: stacks_cards::WorkflowAction,
    ) -> Option<stacks_cards::WorkflowConfirmation> {
        match action {
            stacks_cards::WorkflowAction::Cleanup => Some(
                stacks_cards::WorkflowConfirmation {
                    title: "Clean up card resources?".into(),
                    detail: "Removes the merged worktree and local branch. This cannot be undone.".into(),
                },
            ),
            stacks_cards::WorkflowAction::MergePr => card
                .pull_request
                .as_ref()
                .map(|pr| stacks_cards::WorkflowConfirmation {
                    title: format!("Merge pull request #{}?", pr.number),
                    detail: "GitHub will merge this pull request using the configured merge strategy.".into(),
                }),
            stacks_cards::WorkflowAction::CreatePr
            | stacks_cards::WorkflowAction::CreatePrWithFe => {
                Some(stacks_cards::WorkflowConfirmation {
                    title: if action == stacks_cards::WorkflowAction::CreatePrWithFe {
                        "Create PR with FE?".into()
                    } else {
                        "Create pull request?".into()
                    },
                    detail: "Stacks will push the card branch and create a GitHub pull request against the target branch.".into(),
                })
            }
            _ => None,
        }
    }

    fn run_primary_workflow_action(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(state) = self.detail.as_ref() else {
            return false;
        };
        if !matches!(
            state.tab,
            DetailTab::Description | DetailTab::Agent | DetailTab::Diff
        ) {
            return false;
        }
        let Some(detail) = state.detail.as_ref() else {
            return false;
        };
        let actions =
            stacks_cards::present_actions(&detail.workflow_context, state.tab == DetailTab::Agent);
        let Some(action) = actions
            .iter()
            .find(|action| action.primary && action.disabled_reason.is_none())
            .cloned()
        else {
            return false;
        };
        let card = detail.card.clone();
        let project = card.project(
            self.snapshot
                .as_ref()
                .map(|snapshot| snapshot.projects.as_slice())
                .unwrap_or(&[]),
        );
        if !Self::native_workflow_action_supported(&card, project, action.action) {
            return false;
        }
        let confirmation = action
            .confirmation
            .clone()
            .or_else(|| Self::workflow_action_confirmation(&card, action.action));
        if let Some(confirmation) = confirmation {
            self.request_workflow_confirmation(
                card.id,
                action.action,
                card.workflow_revision,
                confirmation.title,
                confirmation.detail,
                window,
                cx,
            );
        } else {
            self.apply_workflow_action(card.id, action.action, card.workflow_revision, cx);
        }
        true
    }

    fn native_workflow_action_supported(
        card: &CardSummary,
        project: Option<&Project>,
        action: stacks_cards::WorkflowAction,
    ) -> bool {
        action == stacks_cards::WorkflowAction::OpenPr
            || action == stacks_cards::WorkflowAction::MergePr
            || action == stacks_cards::WorkflowAction::CreatePr
            || action == stacks_cards::WorkflowAction::CreatePrWithFe
            || card.provider == "local"
                && (matches!(
                    action,
                    stacks_cards::WorkflowAction::OpenRefinement
                        | stacks_cards::WorkflowAction::ReturnToRefinement
                        | stacks_cards::WorkflowAction::StopRefinement
                        | stacks_cards::WorkflowAction::RequestChanges
                        | stacks_cards::WorkflowAction::Ship
                        | stacks_cards::WorkflowAction::MergeLocal
                        | stacks_cards::WorkflowAction::MergeTarget
                        | stacks_cards::WorkflowAction::Cleanup
                        | stacks_cards::WorkflowAction::Push
                        | stacks_cards::WorkflowAction::RetryPush
                        | stacks_cards::WorkflowAction::Deploy
                        | stacks_cards::WorkflowAction::RetryDeploy
                        | stacks_cards::WorkflowAction::RunDeploymentAgain
                        | stacks_cards::WorkflowAction::ConfirmDeployed
                        | stacks_cards::WorkflowAction::CancelDeployment
                        | stacks_cards::WorkflowAction::Close
                        | stacks_cards::WorkflowAction::Delete
                ) || action == stacks_cards::WorkflowAction::StartWork
                    && project.is_some_and(|project| {
                        project
                            .start_work_command
                            .as_deref()
                            .is_none_or(|command| command.trim().is_empty())
                    }))
    }

    fn close_detail_or_clear(&mut self, cx: &mut Context<Self>) {
        if self.project_workspace.is_some() {
            self.close_project_workspace(cx);
        } else if self.detail.is_some() {
            self.close_detail(cx);
        } else {
            self.keyboard_focused = None;
            cx.notify();
        }
    }

    fn report_detail_metric(&mut self) {
        if self.detail_metric_reported {
            return;
        }
        let Some(state) = self.detail.as_ref() else {
            return;
        };
        let Some(detail) = state.detail.as_ref() else {
            return;
        };
        self.detail_metric_reported = true;
        if std::env::var_os("STACKS_GPUI_METRICS").is_some() {
            eprintln!(
                "STACKS_GPUI_METRIC detail_first_frame_ms={:.1} detail_load_ms={:.1} detail_content_chars={} detail_events={}",
                self.detail_opened_at
                    .map(|opened| opened.elapsed().as_secs_f64() * 1000.0)
                    .unwrap_or(-1.0),
                self.detail_load_ms.unwrap_or(-1.0),
                detail.content.chars().count(),
                detail.events.len(),
            );
        }
    }

    fn active_service_key(&self) -> Option<(String, ServiceKind)> {
        if let Some(workspace) = self.project_workspace.as_ref() {
            let kind = match workspace.tab {
                ProjectWorkspaceTab::Terminal => ServiceKind::Terminal,
                ProjectWorkspaceTab::Server => ServiceKind::Server,
                ProjectWorkspaceTab::Console => ServiceKind::Console,
                _ => return None,
            };
            let owner_id = if kind == ServiceKind::Terminal {
                project_terminal_owner_id(&workspace.project.id, &workspace.terminal.focused)
            } else {
                project_owner_id(&workspace.project.id)
            };
            return Some((owner_id, kind));
        }
        let state = self.detail.as_ref()?;
        let kind = match state.tab {
            DetailTab::Terminal => ServiceKind::Terminal,
            DetailTab::Server => ServiceKind::Server,
            DetailTab::Console => ServiceKind::Console,
            _ => return None,
        };
        if kind == ServiceKind::Terminal {
            let terminal = state.terminal.as_ref()?;
            return Some((
                card_terminal_owner_id(&state.card_id, &terminal.focused),
                kind,
            ));
        }
        Some((state.card_id.clone(), kind))
    }

    fn forward_service_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) -> bool {
        let Some(key) = self.active_service_key() else {
            return false;
        };
        let Some(service) = self.services.get_mut(&key) else {
            return false;
        };
        if !service.running || event.keystroke.modifiers.platform {
            return false;
        }
        let keystroke = &event.keystroke;
        if is_text_input_key(keystroke) {
            if let Some(text) = keystroke.key_char.as_deref()
                && !text.is_empty()
                && let Some(pty) = service.pty.as_mut()
            {
                let _ = pty.write(text.as_bytes());
                cx.notify();
                return true;
            }
        }
        let Some(ghostty_key) = ghostty_key(&keystroke.key) else {
            return false;
        };
        let mods = ghostty_mods(keystroke.modifiers);
        let action = if event.is_held {
            KeyAction::Repeat
        } else {
            KeyAction::Press
        };
        let utf8 = keystroke
            .key_char
            .as_deref()
            .filter(|text| !text.is_empty() && !text.chars().any(char::is_control));
        let unshifted = keystroke
            .key_char
            .as_deref()
            .and_then(|text| text.chars().next());
        let bytes = service
            .model
            .encode_key(ghostty_key, mods, action, utf8, unshifted, false)
            .ok();
        if let Some(bytes) = bytes
            && !bytes.is_empty()
            && let Some(pty) = service.pty.as_mut()
        {
            let _ = pty.write(&bytes);
            cx.notify();
            return true;
        }
        false
    }

    fn handle_terminal_navigation_key(
        &mut self,
        event: &KeyDownEvent,
        cx: &mut Context<Self>,
    ) -> bool {
        let keystroke = &event.keystroke;
        if !keystroke.modifiers.platform || (!keystroke.modifiers.shift && !keystroke.modifiers.alt)
        {
            return false;
        }
        match keystroke.key.as_str() {
            "[" | "{" => {
                self.navigate_active_terminal(-1, cx);
                true
            }
            "]" | "}" => {
                self.navigate_active_terminal(1, cx);
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
        if self.workflow_confirmation.is_some() {
            if event.keystroke.key == "escape" {
                self.workflow_confirmation = None;
                self.workflow_confirmation_task = None;
                cx.notify();
            }
            cx.stop_propagation();
            return;
        }
        if self.detail.is_some()
            && event.keystroke.modifiers.platform
            && !event.keystroke.modifiers.shift
            && !event.keystroke.modifiers.alt
            && !event.keystroke.modifiers.control
            && event.keystroke.key == "enter"
        {
            if let Some(agent) = self.card_agent.as_ref()
                && agent.read(cx).composer_focused(window, cx)
            {
                return;
            }
            if self.run_primary_workflow_action(window, cx) {
                cx.stop_propagation();
                return;
            }
        }
        if self.project_workspace.is_some() {
            if self.handle_terminal_navigation_key(event, cx) {
                cx.stop_propagation();
                return;
            }
            if self.active_service_search_open() {
                if self.handle_service_search_key(event, cx) {
                    cx.stop_propagation();
                }
                return;
            }
            if self
                .project_workspace
                .as_ref()
                .is_some_and(|workspace| workspace.tab == ProjectWorkspaceTab::Release)
                && self.handle_release_key(event, cx)
            {
                cx.stop_propagation();
                return;
            }
            if event.keystroke.key == "escape" {
                self.close_project_workspace(cx);
                cx.stop_propagation();
                return;
            }
            if self.forward_service_key(event, cx) {
                cx.stop_propagation();
            }
            return;
        }
        if self.detail.is_some() {
            if self.handle_terminal_navigation_key(event, cx) {
                cx.stop_propagation();
                return;
            }
            if self.active_service_search_open() {
                if self.handle_service_search_key(event, cx) {
                    cx.stop_propagation();
                }
                return;
            }
            if event.keystroke.key == "escape" {
                self.close_detail(cx);
                cx.stop_propagation();
                return;
            }
            if self.forward_service_key(event, cx) {
                cx.stop_propagation();
            }
            return;
        }
        if event.keystroke.modifiers.platform
            && !event.keystroke.modifiers.shift
            && !event.keystroke.modifiers.alt
            && !event.keystroke.modifiers.control
            && event.keystroke.key.len() == 1
            && event.keystroke.key.as_bytes()[0].is_ascii_digit()
        {
            let index = event.keystroke.key.parse::<usize>().unwrap_or(0);
            self.filter_project_by_index(index, cx);
            cx.stop_propagation();
            return;
        }
        let plain = !event.keystroke.modifiers.platform
            && !event.keystroke.modifiers.control
            && !event.keystroke.modifiers.alt;
        if !plain {
            return;
        }
        let handled = match event.keystroke.key.as_str() {
            "up" | "k" => {
                self.navigate(-1, window, cx);
                true
            }
            "down" | "j" => {
                self.navigate(1, window, cx);
                true
            }
            "home" => {
                if let Some(id) = self.card_order.first().cloned() {
                    self.focus_card(&id, window, cx);
                }
                true
            }
            "end" => {
                if let Some(id) = self.card_order.last().cloned() {
                    self.focus_card(&id, window, cx);
                }
                true
            }
            "enter" | " " => {
                self.open_focused(cx);
                true
            }
            "left" | "h" => {
                self.collapse_focused_group(true, cx);
                true
            }
            "right" | "l" => {
                self.collapse_focused_group(false, cx);
                true
            }
            "escape" => {
                self.keyboard_focused = None;
                cx.notify();
                true
            }
            _ => false,
        };
        if handled {
            cx.stop_propagation();
        }
    }

    fn collapse_focused_group(&mut self, collapse: bool, cx: &mut Context<Self>) {
        let Some(card_id) = self.keyboard_focused.as_deref() else {
            return;
        };
        let Some(card) = self
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.cards.iter().find(|card| card.id == card_id))
        else {
            return;
        };
        let Some(project_list) = self.snapshot.as_ref() else {
            return;
        };
        let group = stacks_cards::work_group(card, &project_list.projects);
        let index = group_index(group);
        if self.collapsed[index] != collapse {
            self.collapsed[index] = collapse;
            self.rebuild_rows();
            cx.notify();
        }
    }

    fn finish_reorder(&mut self, dragged_id: String, target_id: String, cx: &mut Context<Self>) {
        if dragged_id == target_id || self.reordering {
            return;
        }
        let Some(snapshot) = self.snapshot.clone() else {
            return;
        };
        if self
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.cards.iter().find(|card| card.id == dragged_id))
            .is_none_or(|card| card.status != CardStatus::NeedsRefinement)
            || self
                .snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.cards.iter().find(|card| card.id == target_id))
                .is_none_or(|card| card.status != CardStatus::NeedsRefinement)
        {
            return;
        }
        let expected = snapshot
            .cards
            .iter()
            .filter(|card| card.status == CardStatus::NeedsRefinement)
            .map(|card| card.id.clone())
            .collect::<Vec<_>>();
        let mut visible_order = self
            .visible_cards
            .iter()
            .filter(|card| card.status == CardStatus::NeedsRefinement)
            .map(|card| card.id.clone())
            .collect::<Vec<_>>();
        let Some(from) = visible_order.iter().position(|id| *id == dragged_id) else {
            return;
        };
        visible_order.remove(from);
        let Some(target) = visible_order.iter().position(|id| *id == target_id) else {
            return;
        };
        visible_order.insert(target, dragged_id.clone());
        let desired = self.store.filtered_backlog_order(&snapshot, &visible_order);
        if expected == desired {
            return;
        }

        // Optimistic presentation update: move the card in the canonical
        // snapshot vector. `group_cards` preserves this order.
        let mut optimistic = snapshot;
        let Some(card_position) = optimistic
            .cards
            .iter()
            .position(|card| card.id == dragged_id)
        else {
            return;
        };
        let card = optimistic.cards.remove(card_position);
        if let Some(target_position) = optimistic
            .cards
            .iter()
            .position(|entry| entry.id == target_id)
        {
            optimistic.cards.insert(target_position, card);
        } else {
            optimistic.cards.insert(card_position, card);
        }
        self.snapshot = Some(optimistic);
        self.reordering = true;
        self.rebuild_rows();
        cx.notify();

        let store = self.store.clone();
        let expected_for_store = expected.clone();
        let desired_for_store = desired.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(
                    async move { store.reorder_backlog(&expected_for_store, &desired_for_store) },
                )
                .await;
            let _ = this.update(cx, |view, cx| {
                view.reordering = false;
                if let Err(error) = result {
                    let message = format!("{error:#}");
                    view.notice = Some((
                        if message.contains(stacks_cards::REORDER_CONFLICT_CODE) {
                            "Backlog changed in Stacks; reloaded authoritative order".into()
                        } else {
                            format!("Backlog reorder failed: {message}")
                        },
                        Instant::now(),
                    ));
                    view.reload(cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn render_header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let snapshot = self.snapshot.as_ref();
        let chips = snapshot
            .map(|snapshot| {
                projects_alphabetically(&snapshot.projects)
                    .into_iter()
                    .map(|project| {
                        let selected = self.project_filter.as_deref() == Some(project.id.as_str());
                        (project, selected)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        div()
            .flex()
            .flex_col()
            .flex_shrink_0()
            .border_b_1()
            .border_color(rgb(0x222e3b))
            .bg(rgb(crate::theme::SURFACE))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_3()
                    .px_4()
                    .py_3()
                    .child({
                        let all = Button::new("filter-all")
                            .xsmall()
                            .px_3()
                            .label("ALL PROJECTS");
                        (if self.project_filter.is_none() {
                            all.primary()
                        } else {
                            all
                        })
                        .on_click(cx.listener(|view, _, _, cx| {
                            view.set_project_filter(None, cx);
                        }))
                    })
                    .children(chips.into_iter().map(|(project, selected)| {
                        let id = project.id.clone();
                        let button =
                            Button::new(SharedString::from(format!("filter-{}", project.id)))
                                .xsmall()
                                .px_3()
                                .label(project.name.to_uppercase());
                        (if selected { button.primary() } else { button }).on_click(cx.listener(
                            move |view, _, _, cx| {
                                view.set_project_filter(Some(id.clone()), cx);
                            },
                        ))
                    }))
                    .when_some(self.project_filter.clone(), |this, project_id| {
                        let name = snapshot
                            .and_then(|snapshot| {
                                snapshot
                                    .projects
                                    .iter()
                                    .find(|project| project.id == project_id)
                            })
                            .map(|project| project.name.clone())
                            .unwrap_or_else(|| "Project".into());
                        this.child(
                            Button::new("open-project-workspace")
                                .small()
                                .padded()
                                .label(format!("Workspace: {name}").to_uppercase())
                                .on_click(cx.listener(move |view, _, _, cx| {
                                    view.open_project_workspace(project_id.clone(), cx);
                                })),
                        )
                    })
                    .child(div().flex_1())
                    .when(self.reordering, |this| {
                        this.child(
                            div()
                                .text_xs()
                                .text_color(rgb(crate::theme::WARNING))
                                .child("Saving order…"),
                        )
                    })
                    .child({
                        let refresh = Button::new("list-refresh")
                            .small()
                            .padded()
                            .label(if self.refreshing {
                                "REFRESHING…"
                            } else {
                                "REFRESH"
                            })
                            .loading(self.refreshing);
                        refresh
                            .with_variant(ButtonVariant::Custom(
                                ButtonCustomVariant::new(cx)
                                    .color(rgb(0x223246).into())
                                    .foreground(rgb(crate::theme::TEXT_STRONG).into())
                                    .hover(rgb(0x2a3d51).into())
                                    .active(rgb(0x315574).into())
                                    .shadow(true),
                            ))
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.reload(cx);
                            }))
                    }),
            )
            .when_some(
                self.error.as_ref().filter(|_| self.snapshot.is_some()),
                |this, error| {
                    this.child(
                        div()
                            .px_3()
                            .py_1()
                            .bg(rgb(0x3a2530))
                            .text_xs()
                            .text_color(rgb(crate::theme::DANGER))
                            .child(format!("Refresh failed: {error}")),
                    )
                },
            )
    }

    fn render_body(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        if self.snapshot.is_none() {
            return if self.loading {
                div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_sm()
                    .text_color(rgb(0x8ea3b8))
                    .child("Loading cards from workflow.sqlite3…")
                    .into_any_element()
            } else {
                let error = self
                    .error
                    .clone()
                    .unwrap_or_else(|| "No card database loaded".into());
                div()
                    .size_full()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap_3()
                    .p_6()
                    .child(
                        div()
                            .text_lg()
                            .text_color(rgb(0xe6b5bd))
                            .child("Could not load cards"),
                    )
                    .child(
                        div()
                            .max_w(px(760.0))
                            .text_sm()
                            .text_color(rgb(0x8ea3b8))
                            .child(error),
                    )
                    .child(div().text_xs().text_color(rgb(0x6f8498)).child(format!(
                        "Database: {}. Override with STACKS_GPUI_CARDS_DB.",
                        self.store.path().display()
                    )))
                    .child(
                        div()
                            .id("list-retry")
                            .px_3()
                            .py_1()
                            .rounded_md()
                            .bg(rgb(0x233447))
                            .border_1()
                            .border_color(rgb(0x3b5e7d))
                            .cursor_pointer()
                            .text_sm()
                            .text_color(rgb(0xd7e1eb))
                            .on_click(cx.listener(|view, _, _, cx| view.reload(cx)))
                            .child("RETRY"),
                    )
                    .into_any_element()
            };
        }
        let snapshot = self.snapshot.as_ref().expect("checked above");
        let projects = snapshot.projects.clone();
        let card_count = snapshot.cards.len();
        uniform_list(
            "stacks-list",
            self.rows.len(),
            cx.processor(move |view, range: std::ops::Range<usize>, _window, cx| {
                view.visible_range = range.clone();
                if !view.metric_reported && range.len() > 1 {
                    view.metric_reported = true;
                    if std::env::var_os("STACKS_GPUI_METRICS").is_some() {
                        eprintln!(
                            "STACKS_GPUI_METRIC first_list_frame_ms={:.1} list_load_ms={:.1} list_flatten_us={:.1} list_cards={} list_rows={} list_visible_rows={}",
                            process_start().elapsed().as_secs_f64() * 1000.0,
                            view.load_ms.unwrap_or(-1.0),
                            view.flatten_us.unwrap_or(-1.0),
                            card_count,
                            view.rows.len(),
                            range.len(),
                        );
                    }
                }
                range
                    .map(|index| view.render_row(index, &projects, cx))
                    .collect::<Vec<_>>()
            }),
        )
        .size_full()
        .track_scroll(&self.scroll)
        .into_any_element()
    }

    fn render_row(
        &mut self,
        index: usize,
        projects: &[Project],
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        match self.rows.get(index).cloned() {
            Some(FlatRow::Header { group, count }) => div()
                .id(SharedString::from(format!("group-{}", group.id())))
                .debug_selector(|| format!("group-{}", group.id()))
                .flex()
                .items_center()
                .gap_2()
                .h(px(ROW_HEIGHT))
                .w_full()
                .px_4()
                .bg(rgb(0x121a23))
                .border_b_1()
                .border_color(rgb(crate::theme::BORDER_SUBTLE))
                .cursor_pointer()
                .hover(|style| style.bg(rgb(0x17212c)))
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.toggle_group(group, cx);
                }))
                .child(
                    div()
                        .text_lg()
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(rgb(crate::theme::TEXT_MUTED))
                        .child(group.label().to_uppercase()),
                )
                .child(Tag::new().child(format!("{count}")))
                .child(div().flex_1())
                .into_any_element(),
            Some(FlatRow::Empty { group }) => div()
                .h(px(ROW_HEIGHT))
                .w_full()
                .flex()
                .items_center()
                .px_12()
                .text_sm()
                .text_color(rgb(0x5f7488))
                .child(format!("No cards here · {}", group.label()))
                .into_any_element(),
            Some(FlatRow::Card { index }) => {
                let Some(card) = self.visible_cards.get(index).cloned() else {
                    return div().h(px(ROW_HEIGHT)).into_any_element();
                };
                self.render_card(card, projects, cx)
            }
            None => div().h(px(ROW_HEIGHT)).into_any_element(),
        }
    }

    fn render_card(
        &mut self,
        card: CardSummary,
        projects: &[Project],
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let focused = self.keyboard_focused.as_deref() == Some(card.id.as_str());
        let project = card.project(projects);
        let project_name = project
            .map(|project| project.name.clone())
            .unwrap_or_else(|| "Unknown project".into());
        let project_accent =
            project_accent(project.and_then(|project| project.color_id.as_deref()));
        let step = delivery_step(&card, projects);
        let dragging = card.status == CardStatus::NeedsRefinement;
        let row_id = card.id.clone();
        let click_id = card.id.clone();
        let down_id = card.id.clone();
        let drop_id = card.id.clone();
        let drag = CardDrag {
            card_id: card.id.clone(),
            title: card.title.clone(),
            external_id: card.external_id.clone(),
        };
        let pr = card.pull_request.clone();
        let git = self.git_statuses.get(&card.id).cloned();
        let server_target = card_server_target(&card, projects);
        let server_running = self.service_running(&card.id, ServiceKind::Server);
        let warning = card.has_git_environment_warning();
        let hierarchy = hierarchy_label(&card);
        let provider_board = (card.provider != "local"
            && !card.board_title.trim().is_empty()
            && !card.board_title.eq_ignore_ascii_case("dev - active"))
        .then(|| card.board_title.clone());
        let attribution = (card.provider != "local").then(|| {
            if card.assignee_names.is_empty() {
                "Unassigned".to_string()
            } else {
                card.assignee_names.join(", ")
            }
        });
        let debug_card_id = card.id.clone();
        let mut row = div()
            .id(SharedString::from(format!("card-{}", card.id)))
            .debug_selector(move || format!("card-{debug_card_id}"))
            .flex()
            .flex_col()
            .h(px(ROW_HEIGHT))
            .w_full()
            .rounded(px(4.0))
            .overflow_hidden()
            .border_2()
            .border_color(if focused {
                project_accent
            } else {
                gpui::rgba(0x00000000).into()
            })
            .bg(if focused {
                project_accent.opacity(0.16)
            } else {
                rgb(crate::theme::CANVAS).into()
            })
            .when(!focused, |this| this.hover(|style| style.bg(rgb(0x151f2b))))
            .cursor_pointer()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |view, _, window, cx| {
                    view.focus_card(&down_id, window, cx);
                }),
            )
            .on_click(cx.listener(move |view, _, _, cx| {
                view.keyboard_focused = Some(click_id.clone());
                view.open_focused(cx);
            }));
        if dragging {
            let drag_id = row_id.clone();
            let drop_target = drop_id.clone();
            row = row
                .on_drag(drag, move |drag, _offset, _window, cx| {
                    cx.new(|_| CardDragPreview {
                        title: drag.title.clone(),
                        external_id: drag.external_id.clone(),
                    })
                })
                .on_drag_move::<CardDrag>(cx.listener(move |view, _, _, cx| {
                    view.keyboard_focused = Some(drag_id.clone());
                    cx.notify();
                }))
                .drag_over::<CardDrag>(|style, _, _, _| {
                    style.bg(rgb(0x213449)).border_color(rgb(0x4b779e))
                })
                .on_drop::<CardDrag>(cx.listener(move |view, drag: &CardDrag, _, cx| {
                    view.finish_reorder(drag.card_id.clone(), drop_target.clone(), cx);
                }));
        }

        let title_line = div()
            .flex()
            .flex_row()
            .items_center()
            .gap_2()
            .min_w_0()
            .child(
                div()
                    .font_family("Menlo")
                    .text_sm()
                    .text_color(rgb(crate::theme::TEXT_MUTED))
                    .child(format!("#{}", card.external_id)),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_sm()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(rgb(crate::theme::TEXT_STRONG))
                    .child(card.title.clone()),
            )
            .child({
                let group = work_group(&card, projects);
                let (background, foreground, border) = match group {
                    WorkGroup::Attention => (
                        project_accent.opacity(0.30),
                        project_accent,
                        project_accent.opacity(0.75),
                    ),
                    WorkGroup::Progress => (
                        project_accent.opacity(0.18),
                        project_accent,
                        project_accent.opacity(0.50),
                    ),
                    WorkGroup::Backlog | WorkGroup::Done => (
                        project_accent.opacity(0.07),
                        project_accent.opacity(0.72),
                        project_accent.opacity(0.22),
                    ),
                };
                Tag::custom(background, foreground, border).child(delivery_label(&step))
            });

        let meta_line = div()
            .flex()
            .flex_row()
            .items_center()
            .gap_2()
            .min_w_0()
            .child(
                Tag::custom(
                    project_accent.opacity(0.18),
                    project_accent,
                    project_accent.opacity(0.45),
                )
                .px_3()
                .child(project_name),
            )
            .when_some(hierarchy, |this, label| this.child(Tag::new().child(label)))
            .when(warning, |this| {
                this.child(Tag::warning().child("! environment"))
            })
            .when_some(card.parent.as_ref(), |this, parent| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(rgb(crate::theme::TEXT_MUTED))
                        .child(format!("#{}", parent.external_id)),
                )
            })
            .when_some(provider_board, |this, board| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(rgb(crate::theme::TEXT_FAINT))
                        .truncate()
                        .child(board),
                )
            })
            .when_some(attribution, |this, assignee| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(rgb(crate::theme::TEXT_MUTED))
                        .truncate()
                        .child(assignee),
                )
            })
            .child(div().flex_1())
            .when_some(git.as_ref().and_then(git_badge), |this, badge| {
                this.child(badge)
            })
            .when_some(pr, |this, pr| this.child(pr_badge(&pr)))
            .when_some(server_target, |this, (worktree, command)| {
                let card_id = card.id.clone();
                let start_worktree = worktree.clone();
                let start_command = command.clone();
                let button = Button::new(SharedString::from(format!("server-toggle-{}", card.id)))
                    .small()
                    .padded()
                    .px_2()
                    .label(if server_running { "■" } else { "▶" });
                this.child(
                    if server_running {
                        button.success()
                    } else {
                        button
                    }
                    .on_click(cx.listener(move |view, _, _, cx| {
                        cx.stop_propagation();
                        if view.service_running(&card_id, ServiceKind::Server) {
                            view.stop_service(&card_id, ServiceKind::Server, cx);
                        } else {
                            view.start_service(
                                card_id.clone(),
                                ServiceKind::Server,
                                start_worktree.clone(),
                                Some(start_command.clone()),
                                cx,
                            );
                        }
                    })),
                )
            });

        row.child(
            div().flex().flex_row().flex_1().min_h_0().child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .justify_center()
                    .gap_1()
                    .px_3()
                    .child(title_line)
                    .child(meta_line),
            ),
        )
        .child(div().h(px(1.0)).w_full().bg(if focused {
            gpui::rgba(0x00000000)
        } else {
            rgb(crate::theme::BORDER_SUBTLE)
        }))
        .into_any_element()
    }

    fn ensure_project_agent(&mut self, cx: &mut Context<Self>) {
        if self.project_agent.is_some() {
            return;
        }
        let Some(workspace) = self.project_workspace.as_ref() else {
            return;
        };
        let project = workspace.project.clone();
        let owner_id = format!("project-direct:{}:agent", project.id);
        let session_dir = pi_sessions_dir().join(safe_session_key(&owner_id));
        let config = AgentConfig {
            owner_id,
            cwd: project.path.clone(),
            project_path: project.path.clone(),
            project_id: project.id.clone(),
            session_dir,
            extension: extension_path(),
            trusted: project_trusted(&project.path),
            accent: project_accent(project.color_id.as_deref()),
            lifecycle: None,
        };
        self.project_agent = Some(cx.new(|cx| AgentView::new(cx, config)));
    }

    fn ensure_card_agent(&mut self, cx: &mut Context<Self>) {
        if self.card_agent.is_some() {
            return;
        }
        let Some(detail) = self.detail.as_ref() else {
            return;
        };
        let card_id = detail.card_id.clone();
        let project_id = detail.summary.project_id.clone().unwrap_or_default();
        let project = self
            .snapshot
            .as_ref()
            .and_then(|snapshot| {
                snapshot
                    .projects
                    .iter()
                    .find(|project| project.id == project_id)
            })
            .cloned();
        let Some(project) = project else {
            return;
        };
        let thread = if detail.summary.environment.is_some() {
            "work"
        } else {
            "planning"
        };
        let cwd = detail
            .summary
            .environment
            .as_ref()
            .map(|environment| environment.worktree_path.clone())
            .unwrap_or_else(|| project.path.clone());
        let owner_id = format!("kanban-card:{card_id}:{thread}");
        let session_dir = card_pi_session_dir(&card_id, thread);
        let (lifecycle_tx, lifecycle_rx) = async_channel::unbounded();
        let config = AgentConfig {
            owner_id,
            cwd,
            project_path: project.path.clone(),
            project_id: project.id.clone(),
            session_dir,
            extension: extension_path(),
            trusted: project_trusted(&project.path),
            accent: project_accent(project.color_id.as_deref()),
            lifecycle: Some(lifecycle_tx),
        };
        let lifecycle_card = card_id.clone();
        let lifecycle_thread = thread.to_string();
        cx.spawn(async move |this, cx| {
            while let Ok(event) = lifecycle_rx.recv().await {
                let _ = this.update(cx, |view, cx| {
                    view.apply_card_agent_lifecycle(&lifecycle_card, &lifecycle_thread, event, cx);
                });
            }
        })
        .detach();
        self.card_agent = Some(cx.new(|cx| AgentView::new(cx, config)));
    }

    fn apply_card_agent_lifecycle(
        &mut self,
        card_id: &str,
        thread: &str,
        event: AgentLifecycle,
        cx: &mut Context<Self>,
    ) {
        let intent = match event {
            AgentLifecycle::Started => "agent_started",
            AgentLifecycle::Settled => "agent_settled",
            AgentLifecycle::Failed => "process_exited",
        };
        match self.store.apply_agent_lifecycle(card_id, thread, intent) {
            Ok(Some(_)) => {
                if self
                    .detail
                    .as_ref()
                    .is_some_and(|state| state.card_id == card_id)
                {
                    let tab = self
                        .detail
                        .as_ref()
                        .map(|state| state.tab)
                        .unwrap_or(DetailTab::Description);
                    self.open_card(card_id.to_string(), cx);
                    self.set_detail_tab(tab, cx);
                    self.reload(cx);
                }
            }
            Ok(None) => {}
            Err(error) => {
                self.notice = Some((
                    format!("Could not update agent lifecycle: {error:#}"),
                    Instant::now(),
                ));
            }
        }
        if event == AgentLifecycle::Settled
            && thread == "work"
            && self.pending_ship.as_deref() == Some(card_id)
        {
            self.pending_ship = None;
            match self.store.approve_local_card(card_id) {
                Ok(()) => {
                    if let Ok(snapshot) = self.store.load_snapshot() {
                        self.apply_snapshot(snapshot, cx);
                    }
                    let tab = self
                        .detail
                        .as_ref()
                        .map(|state| state.tab)
                        .unwrap_or(DetailTab::Agent);
                    self.open_card(card_id.to_string(), cx);
                    self.set_detail_tab(tab, cx);
                    self.notice = Some(("Card approved".into(), Instant::now()));
                }
                Err(error) => {
                    self.notice = Some((format!("Approval failed: {error:#}"), Instant::now()));
                }
            }
        }
        cx.notify();
    }

    fn ensure_card_terminal(&mut self, cx: &mut Context<Self>) {
        let Some(state) = self.detail.as_ref() else {
            return;
        };
        if state.terminal.is_some() {
            return;
        }
        let card_id = state.card_id.clone();
        let Some(path) = state
            .summary
            .environment
            .as_ref()
            .map(|environment| environment.worktree_path.clone())
        else {
            return;
        };
        let pane_id = new_project_terminal_pane_id();
        #[cfg(test)]
        let _ = (&card_id, &path, &pane_id);
        if let Some(state) = self.detail.as_mut() {
            state.terminal = Some(ProjectTerminalState {
                layout: SplitNode::leaf(pane_id.clone()),
                focused: pane_id.clone(),
                maximized: None,
            });
        }
        #[cfg(not(test))]
        self.start_service(
            card_terminal_owner_id(&card_id, &pane_id),
            ServiceKind::Terminal,
            path,
            None,
            cx,
        );
        cx.notify();
    }

    fn render_detail(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let Some(state) = self.detail.clone() else {
            return div().into_any_element();
        };
        let card = state.summary.clone();
        let projects = self
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.projects.clone())
            .unwrap_or_default();
        let project = card.project(&projects);
        let project_name = project
            .map(|project| project.name.clone())
            .unwrap_or_else(|| "Unknown project".into());
        let project_accent =
            project_accent(project.and_then(|project| project.color_id.as_deref()));
        let step = delivery_step(&card, &projects);

        let git = self.git_statuses.get(&card.id).cloned();
        let card_url = state
            .detail
            .as_ref()
            .map(|detail| detail.card_url.clone())
            .unwrap_or_default();
        let branch = card
            .environment
            .as_ref()
            .map(|environment| environment.branch.clone());
        let pr = card.pull_request.clone();
        let has_repository_meta = branch.is_some() || git.is_some() || pr.is_some();

        let header = div()
            .relative()
            .flex()
            .flex_col()
            .gap_2()
            .px_5()
            .pt_4()
            .pb_3()
            .flex_shrink_0()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .pr(px(36.0))
                    .child(
                        div()
                            .font_family("Menlo")
                            .text_sm()
                            .text_color(rgb(crate::theme::TEXT_MUTED))
                            .child(format!("#{}", card.external_id)),
                    )
                    .child(
                        Tag::custom(
                            project_accent.opacity(0.18),
                            project_accent,
                            project_accent.opacity(0.45),
                        )
                        .px_3()
                        .child(project_name.clone()),
                    )
                    .child(status_tag(&card, &projects, project_accent, &step))
                    .when(card.child_count > 0, |this| {
                        this.child(Tag::new().child(format!("{} children", card.child_count)))
                    })
                    .when_some(card.parent.as_ref(), |this, parent| {
                        this.child(Tag::new().child(format!("#{}", parent.external_id)))
                    })
                    .child(div().flex_1())
                    .when(!card_url.is_empty(), |this| {
                        this.child(
                            Button::new("detail-open-url")
                                .small()
                                .padded()
                                .label("OPEN URL")
                                .on_click(cx.listener(|view, _, _, cx| {
                                    let Some(url) = view
                                        .detail
                                        .as_ref()
                                        .and_then(|state| state.detail.as_ref())
                                        .map(|detail| detail.card_url.clone())
                                    else {
                                        return;
                                    };
                                    if let Err(error) =
                                        std::process::Command::new("open").arg(&url).spawn()
                                    {
                                        view.notice = Some((
                                            format!("Could not open card URL: {error}"),
                                            Instant::now(),
                                        ));
                                        cx.notify();
                                    }
                                })),
                        )
                    }),
            )
            .child(
                div()
                    .pr(px(36.0))
                    .text_2xl()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(rgb(crate::theme::TEXT_STRONG))
                    .child(card.title.clone()),
            )
            .when(has_repository_meta, |this| {
                this.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(
                            div()
                                .text_xs()
                                .text_color(rgb(crate::theme::TEXT_MUTED))
                                .child(branch.unwrap_or_else(|| "no branch".into())),
                        )
                        .when_some(git.as_ref().and_then(git_badge), |this, badge| {
                            this.child(badge)
                        })
                        .when_some(pr, |this, pr| this.child(pr_badge(&pr))),
                )
            })
            .child(
                div().absolute().top(px(12.0)).right(px(12.0)).child(
                    Button::new("detail-close")
                        .small()
                        .padded()
                        .label("X")
                        .on_click(cx.listener(|view, _, _, cx| view.close_detail(cx))),
                ),
            );

        let service_worktree = card
            .environment
            .as_ref()
            .map(|environment| environment.worktree_path.clone())
            .unwrap_or_default();
        let server_command = project_service_command(&card, &projects, ServiceKind::Server);
        let console_command = project_service_command(&card, &projects, ServiceKind::Console);
        let tabs = div()
            .flex()
            .items_center()
            .gap_1()
            .h(px(42.0))
            .px_4()
            .flex_shrink_0()
            .border_b_1()
            .border_color(rgb(crate::theme::BORDER))
            .children(
                [
                    (DetailTab::Description, "Description"),
                    (DetailTab::Agent, "Agent"),
                    (DetailTab::Diff, "Diff"),
                    (DetailTab::Terminal, "Terminal"),
                    (DetailTab::Server, "Server"),
                    (DetailTab::Console, "Console"),
                ]
                .into_iter()
                .filter(|(tab, _)| detail_tab_visible(&card, &projects, *tab))
                .map(|(tab, label)| {
                    let active = state.tab == tab;
                    let enabled = detail_tab_enabled(&card, &projects, tab);
                    let action = match tab {
                        DetailTab::Diff => {
                            let refresh = Button::new("detail-diff-refresh")
                                .xsmall()
                                .label("↻")
                                .disabled(!enabled)
                                .on_click(cx.listener(move |view, _, _, cx| {
                                    cx.stop_propagation();
                                    view.reload(cx);
                                    view.load_git_statuses(cx);
                                }));
                            Some(refresh.into_any_element())
                        }
                        DetailTab::Server | DetailTab::Console => {
                            let kind = if tab == DetailTab::Server {
                                ServiceKind::Server
                            } else {
                                ServiceKind::Console
                            };
                            let owner = card.id.clone();
                            let running = self.service_running(&owner, kind);
                            let worktree = service_worktree.clone();
                            let command = if kind == ServiceKind::Server {
                                server_command.clone()
                            } else {
                                console_command.clone()
                            };
                            let toggle_id =
                                SharedString::from(format!("detail-service-toggle-{label}"));
                            Some(
                                Button::new(toggle_id)
                                    .xsmall()
                                    .label(if running { "■" } else { "▶" })
                                    .when(running, |button| button.primary())
                                    .on_click(cx.listener(move |view, _, _, cx| {
                                        cx.stop_propagation();
                                        if view.service_running(&owner, kind) {
                                            view.stop_service(&owner, kind, cx);
                                        } else {
                                            view.start_service(
                                                owner.clone(),
                                                kind,
                                                worktree.clone(),
                                                command.clone(),
                                                cx,
                                            );
                                        }
                                    }))
                                    .into_any_element(),
                            )
                        }
                        _ => None,
                    };
                    div()
                        .id(SharedString::from(format!("detail-tab-{label}")))
                        .flex()
                        .items_center()
                        .gap_2()
                        .h_full()
                        .px_3()
                        .cursor_pointer()
                        .text_xs()
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(if active {
                            rgb(crate::theme::TEXT_STRONG)
                        } else if enabled {
                            rgb(crate::theme::TEXT_MUTED)
                        } else {
                            rgb(crate::theme::TEXT_FAINT)
                        })
                        .border_b_2()
                        .border_color(if active {
                            project_accent
                        } else {
                            gpui::rgba(0x00000000).into()
                        })
                        .hover(|style| style.bg(rgb(crate::theme::SURFACE_RAISED)))
                        .on_click(cx.listener(move |view, _, _, cx| {
                            cx.stop_propagation();
                            if enabled {
                                view.set_detail_tab(tab, cx);
                            }
                        }))
                        .child(label.to_uppercase())
                        .when_some(action, |this, action| this.child(action))
                }),
            );

        let body = if state.loading {
            div()
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_3()
                .child(Spinner::new().small())
                .child("Loading card detail…")
                .into_any_element()
        } else if let Some(error) = state.error.clone() {
            div()
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_3()
                .p_6()
                .child(
                    div()
                        .text_lg()
                        .text_color(rgb(crate::theme::DANGER))
                        .child("Could not load card detail"),
                )
                .child(
                    div()
                        .max_w(px(760.0))
                        .text_sm()
                        .text_color(rgb(crate::theme::TEXT_MUTED))
                        .child(error),
                )
                .child(
                    Button::new("detail-retry")
                        .small()
                        .padded()
                        .label("RETRY")
                        .on_click(cx.listener(|view, _, _, cx| {
                            if let Some(state) = view.detail.as_ref() {
                                view.open_card(state.card_id.clone(), cx);
                            }
                        })),
                )
                .into_any_element()
        } else if let Some(detail) = state.detail.clone() {
            match state.tab {
                DetailTab::Description => {
                    self.render_detail_description(&detail, project_accent, cx)
                }
                DetailTab::Agent => self
                    .card_agent
                    .as_ref()
                    .map(|agent| agent.clone().into_any_element())
                    .unwrap_or_else(|| {
                        self.render_detail_placeholder("Agent", "Starting the native Pi agent…", cx)
                    }),
                DetailTab::Diff => self.render_detail_placeholder(
                    "Diff",
                    "The native diff review view is not ported yet.",
                    cx,
                ),
                DetailTab::Terminal => self.render_card_terminal(&detail, cx),
                DetailTab::Server => self.render_service_tab(&detail, ServiceKind::Server, cx),
                DetailTab::Console => self.render_service_tab(&detail, ServiceKind::Console, cx),
            }
        } else {
            div().into_any_element()
        };

        let action_row_visible = matches!(
            state.tab,
            DetailTab::Description | DetailTab::Agent | DetailTab::Diff
        );
        let capabilities = state
            .detail
            .as_ref()
            .map(|detail| {
                stacks_cards::present_actions(
                    &detail.workflow_context,
                    state.tab == DetailTab::Agent,
                )
            })
            .unwrap_or_default();
        let workflow_footer = action_row_visible
            .then(|| {
                let mut regular = Vec::new();
                let mut ghost = Vec::new();
                for capability in &capabilities {
                    let action = capability.action;
                    let supported =
                        ListView::native_workflow_action_supported(&card, project, action);
                    let enabled = supported
                        && capability.disabled_reason.is_none()
                        && !self.workflow_action_pending;
                    let reason = capability
                        .disabled_reason
                        .clone()
                        .or_else(|| {
                            (!supported).then(|| {
                                if card.provider != "local" {
                                    "Native workflow actions are currently limited to local cards"
                                        .to_string()
                                } else {
                                    "This native workflow action is not wired yet".to_string()
                                }
                            })
                        })
                        .unwrap_or_else(|| "Native workflow action is unavailable".to_string());
                    let card_id = card.id.clone();
                    let expected_revision = card.workflow_revision;
                    let confirmation = capability
                        .confirmation
                        .clone()
                        .or_else(|| Self::workflow_action_confirmation(&card, action));
                    let mut button =
                        Button::new(SharedString::from(format!("workflow-{}", action.as_str())))
                            .small()
                            .padded()
                            .label(capability.label.to_uppercase())
                            .disabled(!enabled)
                            .tooltip(SharedString::from(reason));
                    if capability.primary {
                        button = button.primary();
                    } else {
                        match capability.appearance {
                            stacks_cards::WorkflowActionAppearance::NeutralGhost => {
                                button = button.ghost();
                            }
                            stacks_cards::WorkflowActionAppearance::DangerGhost => {
                                button = button.ghost().text_color(rgb(crate::theme::DANGER));
                            }
                            stacks_cards::WorkflowActionAppearance::Regular => {}
                        }
                    }
                    if enabled {
                        button = button.on_click(cx.listener(move |view, _, window, cx| {
                            if let Some(confirmation) = confirmation.clone() {
                                view.request_workflow_confirmation(
                                    card_id.clone(),
                                    action,
                                    expected_revision,
                                    confirmation.title,
                                    confirmation.detail,
                                    window,
                                    cx,
                                );
                            } else {
                                view.apply_workflow_action(
                                    card_id.clone(),
                                    action,
                                    expected_revision,
                                    cx,
                                );
                            }
                        }));
                    }
                    match capability.appearance {
                        stacks_cards::WorkflowActionAppearance::NeutralGhost
                        | stacks_cards::WorkflowActionAppearance::DangerGhost => {
                            ghost.push(button.into_any_element())
                        }
                        stacks_cards::WorkflowActionAppearance::Regular => {
                            regular.push(button.into_any_element())
                        }
                    }
                }
                (!regular.is_empty() || !ghost.is_empty()).then(|| {
                    div()
                        .flex_shrink_0()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap_3()
                        .px_4()
                        .py_3()
                        .border_t_1()
                        .border_color(rgb(crate::theme::BORDER))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .flex_wrap()
                                .gap_2()
                                .children(regular),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .flex_wrap()
                                .gap_2()
                                .children(ghost),
                        )
                        .into_any_element()
                })
            })
            .flatten();

        div()
            .absolute()
            .top(px(0.0))
            .left(px(0.0))
            .right(px(0.0))
            .bottom(px(0.0))
            .occlude()
            .flex()
            .flex_col()
            .bg(rgb(crate::theme::CANVAS))
            .child(header)
            .child(tabs)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .when(state.tab == DetailTab::Agent, |this| this.pt(px(12.0)))
                    .child(body),
            )
            .when_some(workflow_footer, |this, footer| this.child(footer))
            .into_any_element()
    }

    fn service_running(&self, card_id: &str, kind: ServiceKind) -> bool {
        self.services
            .get(&(card_id.to_string(), kind))
            .is_some_and(|service| service.running)
    }

    fn start_service(
        &mut self,
        card_id: String,
        kind: ServiceKind,
        worktree: String,
        command: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if self.service_running(&card_id, kind) {
            return;
        }
        let key = (card_id, kind);
        let model = TerminalModel::new(120, 40, 200_000)
            .unwrap_or_else(|_| TerminalModel::new(80, 24, 1_000_000).unwrap());
        let (events_tx, events_rx) = async_channel::bounded(1024);
        let spawn = match command.as_deref() {
            Some(command) => Pty::spawn_with_command(&worktree, 120, 40, command, events_tx),
            None => Pty::spawn_with_shell(&worktree, 120, 40, None, events_tx),
        };
        match spawn {
            Ok(pty) => {
                let generation = pty.generation.clone();
                self.services.insert(
                    key.clone(),
                    ServiceState {
                        model,
                        metrics: TerminalMetrics::default(),
                        pty: Some(pty),
                        generation: Some(generation),
                        running: true,
                        error: None,
                        selection_anchor: None,
                        selecting: false,
                        search_open: false,
                        search_query: String::new(),
                        search_info: SearchInfo::default(),
                    },
                );
                cx.spawn(async move |this, cx| {
                    while let Ok(event) = events_rx.recv().await {
                        let _ = this.update(cx, |view, cx| {
                            view.on_service_event(&key, event, cx);
                        });
                    }
                })
                .detach();
            }
            Err(error) => {
                self.services.insert(
                    key,
                    ServiceState {
                        model,
                        metrics: TerminalMetrics::default(),
                        pty: None,
                        generation: None,
                        running: false,
                        error: Some(format!("{error:#}")),
                        selection_anchor: None,
                        selecting: false,
                        search_open: false,
                        search_query: String::new(),
                        search_info: SearchInfo::default(),
                    },
                );
            }
        }
        cx.notify();
    }

    fn stop_service(&mut self, card_id: &str, kind: ServiceKind, cx: &mut Context<Self>) {
        let key = (card_id.to_string(), kind);
        if let Some(service) = self.services.get_mut(&key) {
            service.pty = None;
            service.generation = None;
            service.running = false;
            service.model.feed(b"\r\n[stopped]\r\n");
        }
        cx.notify();
    }

    fn stop_owner_services(&mut self, owner_id: &str) {
        for kind in [
            ServiceKind::Server,
            ServiceKind::Console,
            ServiceKind::Terminal,
        ] {
            let key = (owner_id.to_string(), kind);
            if let Some(service) = self.services.get_mut(&key) {
                service.pty = None;
                service.generation = None;
                service.running = false;
            }
        }
    }

    fn stop_card_services(&mut self, card_id: &str) {
        self.stop_owner_services(card_id);
    }

    fn on_service_event(
        &mut self,
        key: &(String, ServiceKind),
        event: PtyEvent,
        cx: &mut Context<Self>,
    ) {
        let Some(service) = self.services.get_mut(key) else {
            return;
        };
        match event {
            PtyEvent::Data { generation, data } => {
                if service.generation.as_deref() == Some(generation.as_str()) {
                    service.model.feed(&data);
                }
            }
            PtyEvent::Exit { generation, .. } => {
                if service.generation.as_deref() == Some(generation.as_str()) {
                    service.pty = None;
                    service.generation = None;
                    service.running = false;
                    service.model.feed(b"\r\n[process exited]\r\n");
                }
            }
        }
        cx.notify();
    }

    fn prepare_service_terminal(
        &mut self,
        key: &(String, ServiceKind),
        bounds: gpui::Bounds<gpui::Pixels>,
        window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> PreparedFrame {
        let Some(service) = self.services.get_mut(key) else {
            return PreparedFrame::default();
        };
        let (metrics, prepared) = prepare_frame(&mut service.model, bounds, "", true, window);
        service.metrics = metrics;
        if let Some(pty) = service.pty.as_mut() {
            let _ = pty.resize(metrics.cols, metrics.rows);
        }
        prepared
    }

    fn active_service_search_open(&self) -> bool {
        self.active_service_key()
            .and_then(|key| self.services.get(&key))
            .is_some_and(|service| service.search_open)
    }

    fn toggle_service_search(&mut self, cx: &mut Context<Self>) {
        let Some(key) = self.active_service_key() else {
            return;
        };
        let Some(service) = self.services.get_mut(&key) else {
            return;
        };
        service.search_open = !service.search_open;
        if service.search_open {
            service.search_info = if service.search_query.is_empty() {
                SearchInfo::default()
            } else {
                service
                    .model
                    .search_set(&service.search_query)
                    .unwrap_or_default()
            };
        } else {
            service.search_query.clear();
            service.search_info = SearchInfo::default();
            let _ = service.model.search_clear();
        }
        cx.notify();
    }

    fn update_service_search(&mut self, query: String, cx: &mut Context<Self>) {
        let Some(key) = self.active_service_key() else {
            return;
        };
        let Some(service) = self.services.get_mut(&key) else {
            return;
        };
        service.search_query = query;
        service.search_info = service
            .model
            .search_set(&service.search_query)
            .unwrap_or_default();
        cx.notify();
    }

    fn service_search_next(&mut self, backwards: bool, cx: &mut Context<Self>) {
        let Some(key) = self.active_service_key() else {
            return;
        };
        let Some(service) = self.services.get_mut(&key) else {
            return;
        };
        service.search_info = if backwards {
            service.model.search_prev()
        } else {
            service.model.search_next()
        }
        .unwrap_or_default();
        cx.notify();
    }

    fn handle_service_search_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) -> bool {
        match event.keystroke.key.as_str() {
            "escape" => {
                self.toggle_service_search(cx);
                true
            }
            "enter" => {
                self.service_search_next(event.keystroke.modifiers.shift, cx);
                true
            }
            "backspace" => {
                let query = self
                    .active_service_key()
                    .and_then(|key| self.services.get(&key))
                    .map(|service| service.search_query.clone())
                    .unwrap_or_default();
                let mut query = query;
                query.pop();
                self.update_service_search(query, cx);
                true
            }
            _ if !event.keystroke.modifiers.platform
                && !event.keystroke.modifiers.control
                && !event.keystroke.modifiers.alt =>
            {
                if let Some(text) = event.keystroke.key_char.as_deref()
                    && !text.is_empty()
                    && !text.chars().any(char::is_control)
                {
                    let query = self
                        .active_service_key()
                        .and_then(|key| self.services.get(&key))
                        .map(|service| service.search_query.clone())
                        .unwrap_or_default();
                    self.update_service_search(format!("{query}{text}"), cx);
                    return true;
                }
                false
            }
            _ => false,
        }
    }

    fn paste_active_service(&mut self, cx: &mut Context<Self>) {
        let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else {
            return;
        };
        let Some(key) = self.active_service_key() else {
            return;
        };
        let Some(service) = self.services.get_mut(&key) else {
            return;
        };
        if let Ok(bytes) = service.model.encode_paste(&text)
            && let Some(pty) = service.pty.as_mut()
        {
            let _ = pty.write(&bytes);
            let _ = service.model.scroll_to_bottom();
            self.notice = Some(("Pasted".into(), Instant::now()));
        }
        cx.notify();
    }

    fn service_mouse_down(
        &mut self,
        key: (String, ServiceKind),
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.focus_handle.focus(window, cx);
        let Some(service) = self.services.get_mut(&key) else {
            return;
        };
        let Some((x, y)) = service.metrics.cell_at(event.position) else {
            return;
        };
        service.selection_anchor = Some((x, y));
        service.selecting = true;
        let _ = service.model.set_selection((x, y), (x, y));
        cx.notify();
    }

    fn service_mouse_move(
        &mut self,
        key: (String, ServiceKind),
        event: &MouseMoveEvent,
        cx: &mut Context<Self>,
    ) {
        let Some(service) = self.services.get_mut(&key) else {
            return;
        };
        if !service.selecting {
            return;
        }
        let Some((x, y)) = service.metrics.cell_at(event.position) else {
            return;
        };
        if let Some(anchor) = service.selection_anchor {
            let _ = service.model.set_selection(anchor, (x, y));
            cx.notify();
        }
    }

    fn service_mouse_up(
        &mut self,
        key: (String, ServiceKind),
        _event: &MouseUpEvent,
        cx: &mut Context<Self>,
    ) {
        let Some(service) = self.services.get_mut(&key) else {
            return;
        };
        if !service.selecting {
            return;
        }
        service.selecting = false;
        if let Ok(Some(text)) = service.model.selection_text()
            && !text.is_empty()
        {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
            self.notice = Some(("Copied to clipboard".into(), Instant::now()));
        }
        let _ = service.model.clear_selection();
        cx.notify();
    }

    fn render_service_tab(
        &self,
        detail: &CardDetail,
        kind: ServiceKind,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let card = &detail.card;
        let projects = self
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.projects.as_slice())
            .unwrap_or(&[]);
        let command = project_service_command(card, projects, kind);
        let worktree = card
            .environment
            .as_ref()
            .map(|environment| environment.worktree_path.clone())
            .unwrap_or_default();
        self.render_service_panel(card.id.clone(), kind, command, worktree, cx)
    }

    fn render_service_panel(
        &self,
        owner_id: String,
        kind: ServiceKind,
        command: Option<String>,
        worktree: String,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let key = (owner_id.clone(), kind);
        let service = self.services.get(&key);
        let running = service.is_some_and(|service| service.running);
        let error = service.and_then(|service| service.error.clone());
        let search = service
            .filter(|service| service.search_open)
            .map(|service| (service.search_query.clone(), service.search_info));
        let entity = cx.entity();
        let prepare_key = key.clone();
        let terminal = canvas(
            move |bounds, window, cx| {
                entity.update(cx, |view, cx| {
                    view.prepare_service_terminal(&prepare_key, bounds, window, cx)
                })
            },
            |bounds, prepared, window, cx| prepared.paint(bounds, window, cx),
        )
        .size_full();

        let start_worktree = worktree.clone();
        let start_command = command.clone();
        let start_owner = owner_id.clone();
        let label = command.clone().unwrap_or_else(|| "login shell".into());
        let status_bar = div()
            .flex()
            .items_center()
            .gap_2()
            .px_4()
            .py_2()
            .border_b_1()
            .border_color(rgb(crate::theme::BORDER))
            .child(
                Tag::new()
                    .with_variant(if running {
                        TagVariant::Success
                    } else {
                        TagVariant::Secondary
                    })
                    .child(if running { "Running" } else { "Stopped" }),
            )
            .child(
                div()
                    .font_family("Menlo")
                    .text_xs()
                    .text_color(rgb(crate::theme::TEXT_MUTED))
                    .child(label),
            )
            .child(div().flex_1())
            .when_some(error, |this, error| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(rgb(crate::theme::DANGER))
                        .child(error),
                )
            })
            .child(
                Button::new(SharedString::from(format!(
                    "service-toggle-{}-{}",
                    owner_id,
                    kind.label()
                )))
                .small()
                .padded()
                .label(if running { "STOP" } else { "START" })
                .on_click(cx.listener(move |view, _, _, cx| {
                    if view.service_running(&start_owner, kind) {
                        view.stop_service(&start_owner, kind, cx);
                    } else {
                        view.start_service(
                            start_owner.clone(),
                            kind,
                            start_worktree.clone(),
                            start_command.clone(),
                            cx,
                        );
                    }
                })),
            );
        let mouse_key = key.clone();
        let move_key = key.clone();
        let up_key = key.clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .relative()
            .bg(rgb(crate::theme::CANVAS))
            .when(kind != ServiceKind::Terminal, |this| this.child(status_bar))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |view, event, window, cx| {
                            view.service_mouse_down(mouse_key.clone(), event, window, cx);
                        }),
                    )
                    .on_mouse_move(cx.listener(move |view, event, _, cx| {
                        view.service_mouse_move(move_key.clone(), event, cx);
                    }))
                    .on_mouse_up(
                        MouseButton::Left,
                        cx.listener(move |view, event, _, cx| {
                            view.service_mouse_up(up_key.clone(), event, cx);
                        }),
                    )
                    .child(terminal),
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
                        .bg(rgb(crate::theme::SURFACE_RAISED))
                        .border_1()
                        .border_color(rgb(crate::theme::BORDER))
                        .text_sm()
                        .child(
                            div()
                                .min_w(px(140.0))
                                .max_w(px(280.0))
                                .truncate()
                                .text_color(if query.is_empty() {
                                    rgb(crate::theme::TEXT_MUTED)
                                } else {
                                    rgb(crate::theme::TEXT)
                                })
                                .child(if query.is_empty() {
                                    "Search…".to_string()
                                } else {
                                    query
                                }),
                        )
                        .child(div().text_color(rgb(crate::theme::TEXT_MUTED)).child(count))
                        .child(
                            div()
                                .id("service-search-prev")
                                .px_1()
                                .cursor_pointer()
                                .text_color(rgb(crate::theme::ACCENT))
                                .on_click(cx.listener(|view, _, _, cx| {
                                    view.service_search_next(true, cx);
                                }))
                                .child("↑"),
                        )
                        .child(
                            div()
                                .id("service-search-next")
                                .px_1()
                                .cursor_pointer()
                                .text_color(rgb(crate::theme::ACCENT))
                                .on_click(cx.listener(|view, _, _, cx| {
                                    view.service_search_next(false, cx);
                                }))
                                .child("↓"),
                        )
                        .child(
                            div()
                                .id("service-search-close")
                                .px_1()
                                .cursor_pointer()
                                .text_color(rgb(crate::theme::TEXT_MUTED))
                                .on_click(cx.listener(|view, _, _, cx| {
                                    view.toggle_service_search(cx);
                                }))
                                .child("×"),
                        ),
                )
            })
            .into_any_element()
    }

    fn render_detail_placeholder(
        &self,
        label: &str,
        message: &str,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        div()
            .flex_1()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap_3()
            .p_6()
            .child(
                div()
                    .text_lg()
                    .text_color(rgb(crate::theme::TEXT_STRONG))
                    .child(format!("{label} is not ported yet")),
            )
            .child(
                div()
                    .max_w(px(520.0))
                    .text_sm()
                    .text_color(rgb(crate::theme::TEXT_MUTED))
                    .child(message.to_string()),
            )
            .child(
                Button::new(SharedString::from(format!("detail-back-{label}")))
                    .small()
                    .padded()
                    .label("BACK TO DESCRIPTION")
                    .on_click(cx.listener(|view, _, _, cx| {
                        view.set_detail_tab(DetailTab::Description, cx);
                    })),
            )
            .into_any_element()
    }

    fn render_detail_description(
        &self,
        detail: &CardDetail,
        project_accent: gpui::Hsla,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let card = &detail.card;
        let children = card
            .children
            .iter()
            .take(32)
            .map(|child| {
                let id = child.id.clone();
                Button::new(SharedString::from(format!("detail-child-{}", child.id)))
                    .text()
                    .label(
                        format!(
                            "#{} · {} · {}",
                            child.external_id,
                            child.title,
                            child.status.label()
                        )
                        .to_uppercase(),
                    )
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.open_card(id.clone(), cx);
                    }))
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        div()
            .id("detail-description")
            .size_full()
            .overflow_y_scroll()
            .child(
                div()
                    .max_w(px(860.0))
                    .mx_auto()
                    .px_6()
                    .py_5()
                    .child(if detail.content.trim().is_empty() {
                        div()
                            .text_sm()
                            .text_color(rgb(crate::theme::TEXT_MUTED))
                            .child("No description.")
                            .into_any_element()
                    } else {
                        TextView::markdown(
                            SharedString::from(format!("detail-markdown-{}", card.id)),
                            detail.content.clone(),
                        )
                        .selectable(true)
                        .into_any_element()
                    })
                    .when(!children.is_empty(), |this| {
                        this.child(
                            div()
                                .mt_6()
                                .pt_4()
                                .border_t_1()
                                .border_color(rgb(crate::theme::BORDER))
                                .child(
                                    div()
                                        .text_base()
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .text_color(rgb(crate::theme::TEXT_STRONG))
                                        .child(format!("Children ({})", card.child_count)),
                                )
                                .child(div().mt_2().flex().flex_col().gap_1().children(children)),
                        )
                    })
                    .when_some(card.parent.as_ref(), |this, parent| {
                        let id = parent.id.clone();
                        this.child(
                            div().mt_4().child(
                                Button::new(SharedString::from(format!(
                                    "detail-parent-{}",
                                    parent.id
                                )))
                                .text()
                                .label(
                                    format!("Parent #{} · {}", parent.external_id, parent.title)
                                        .to_uppercase(),
                                )
                                .on_click(cx.listener(
                                    move |view, _, _, cx| {
                                        view.open_card(id.clone(), cx);
                                    },
                                )),
                            ),
                        )
                    })
                    .when(!detail.events.is_empty(), |this| {
                        this.child(self.render_detail_history(detail, cx))
                    })
                    .child(
                        div()
                            .mt_6()
                            .h(px(2.0))
                            .w(px(42.0))
                            .rounded_full()
                            .bg(project_accent.opacity(0.45)),
                    ),
            )
            .into_any_element()
    }

    fn render_detail_history(&self, detail: &CardDetail, cx: &mut Context<Self>) -> AnyElement {
        let expanded = self
            .detail
            .as_ref()
            .is_some_and(|state| state.history_expanded);
        let events = detail
            .events
            .iter()
            .map(|event| {
                let transition = match (event.from_status, event.to_status) {
                    (Some(from), Some(to)) => format!("{} → {}", from.label(), to.label()),
                    _ => event.summary.clone().unwrap_or_default(),
                };
                div()
                    .flex()
                    .gap_3()
                    .py_2()
                    .border_b_1()
                    .border_color(rgb(crate::theme::BORDER_SUBTLE))
                    .child(
                        Tag::new()
                            .with_variant(if event.outcome == "success" {
                                TagVariant::Success
                            } else {
                                TagVariant::Danger
                            })
                            .child(event.outcome.clone()),
                    )
                    .child(
                        div()
                            .w(px(190.0))
                            .flex_shrink_0()
                            .text_xs()
                            .text_color(rgb(crate::theme::TEXT_MUTED))
                            .child(format!("{} · {}", event.actor, event.event_type)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_sm()
                            .text_color(rgb(crate::theme::TEXT))
                            .child(transition),
                    )
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        div()
            .mt_6()
            .pt_4()
            .border_t_1()
            .border_color(rgb(crate::theme::BORDER))
            .child(
                div()
                    .id("detail-history-toggle")
                    .flex()
                    .items_center()
                    .justify_between()
                    .cursor_pointer()
                    .on_click(cx.listener(|view, _, _, cx| {
                        if let Some(state) = view.detail.as_mut() {
                            state.history_expanded = !state.history_expanded;
                        }
                        cx.notify();
                    }))
                    .child(
                        div()
                            .text_base()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(rgb(crate::theme::TEXT_STRONG))
                            .child(format!("HISTORY ({})", detail.events.len())),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(rgb(crate::theme::TEXT_MUTED))
                            .child(if expanded { "−" } else { "+" }),
                    ),
            )
            .when(expanded, |this| {
                this.child(div().mt_2().flex().flex_col().children(events))
            })
            .into_any_element()
    }
}

struct FlattenedRows {
    visible_cards: Vec<CardSummary>,
    rows: Vec<FlatRow>,
    card_order: Vec<String>,
    row_for_card: HashMap<String, usize>,
}

fn flatten_rows(
    snapshot: &CardSnapshot,
    project_filter: Option<&str>,
    collapsed: [bool; 4],
) -> FlattenedRows {
    let mut counts = [0usize; 4];
    let mut visible_cards = Vec::new();
    for (index, group) in WorkGroup::ALL.into_iter().enumerate() {
        let entries = group_cards(&snapshot.cards, group, &snapshot.projects)
            .into_iter()
            .filter(|card| {
                project_filter
                    .is_none_or(|project_id| card.project_id.as_deref() == Some(project_id))
            })
            .collect::<Vec<_>>();
        counts[index] = entries.len();
        if !collapsed[index] {
            visible_cards.extend(entries.into_iter().cloned());
        }
    }

    let mut rows = Vec::with_capacity(visible_cards.len() + 8);
    let mut card_order = Vec::with_capacity(visible_cards.len());
    let mut row_for_card = HashMap::with_capacity(visible_cards.len());
    let mut card_index = 0;
    for (index, group) in WorkGroup::ALL.into_iter().enumerate() {
        rows.push(FlatRow::Header {
            group,
            count: counts[index],
        });
        if collapsed[index] {
            continue;
        }
        if counts[index] == 0 {
            rows.push(FlatRow::Empty { group });
            continue;
        }
        for _ in 0..counts[index] {
            let Some(card) = visible_cards.get(card_index) else {
                break;
            };
            row_for_card.insert(card.id.clone(), rows.len());
            card_order.push(card.id.clone());
            rows.push(FlatRow::Card { index: card_index });
            card_index += 1;
        }
    }
    FlattenedRows {
        visible_cards,
        rows,
        card_order,
        row_for_card,
    }
}

impl Render for ListView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.report_detail_metric();
        let notice = self.notice.as_ref().and_then(|(message, at)| {
            (at.elapsed() < Duration::from_secs(6)).then(|| message.clone())
        });
        div()
            .size_full()
            .flex()
            .flex_col()
            .relative()
            .track_focus(&self.focus_handle)
            .key_context(if self.project_workspace.is_some() {
                "ProjectWorkspace"
            } else if self.detail.is_some() {
                "StacksList"
            } else {
                "CardsList"
            })
            .on_key_down(cx.listener(Self::handle_key_down))
            .on_action(cx.listener(|view, _: &crate::CloseDetail, _, cx| {
                view.close_detail_or_clear(cx);
            }))
            .on_action(cx.listener(|view, _: &crate::DetailDescription, _, cx| {
                view.set_detail_tab(DetailTab::Description, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::DetailAgent, _, cx| {
                view.set_detail_tab(DetailTab::Agent, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::DetailDiff, _, cx| {
                view.set_detail_tab(DetailTab::Diff, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::DetailTerminal, _, cx| {
                view.set_detail_tab(DetailTab::Terminal, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::DetailServer, _, cx| {
                view.set_detail_tab(DetailTab::Server, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::DetailConsole, _, cx| {
                view.set_detail_tab(DetailTab::Console, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::ProjectAgent, _, cx| {
                view.set_project_workspace_tab(ProjectWorkspaceTab::Agent, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::ProjectNotes, _, cx| {
                view.set_project_workspace_tab(ProjectWorkspaceTab::Notes, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::ProjectDiff, _, cx| {
                view.set_project_workspace_tab(ProjectWorkspaceTab::Diff, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::ProjectTerminal, _, cx| {
                view.set_project_workspace_tab(ProjectWorkspaceTab::Terminal, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::ProjectRelease, _, cx| {
                view.set_project_workspace_tab(ProjectWorkspaceTab::Release, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::ProjectServer, _, cx| {
                view.set_project_workspace_tab(ProjectWorkspaceTab::Server, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::ProjectConsole, _, cx| {
                view.set_project_workspace_tab(ProjectWorkspaceTab::Console, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::ProjectSplitRight, _, cx| {
                view.split_active_terminal(SplitDirection::Row, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::ProjectSplitDown, _, cx| {
                view.split_active_terminal(SplitDirection::Column, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::ProjectClosePane, _, cx| {
                view.close_active_terminal_pane(cx);
            }))
            .on_action(
                cx.listener(|view, _: &crate::ProjectToggleMaximize, _, cx| {
                    view.toggle_active_terminal_maximize(cx);
                }),
            )
            .on_action(cx.listener(|view, _: &crate::TerminalSearch, _, cx| {
                view.toggle_service_search(cx);
            }))
            .on_action(cx.listener(|view, _: &crate::TerminalPaste, _, cx| {
                view.paste_active_service(cx);
            }))
            .on_action(cx.listener(|view, _: &crate::FilterProjectAll, _, cx| {
                view.filter_project_by_index(0, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::FilterProject1, _, cx| {
                view.filter_project_by_index(1, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::FilterProject2, _, cx| {
                view.filter_project_by_index(2, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::FilterProject3, _, cx| {
                view.filter_project_by_index(3, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::FilterProject4, _, cx| {
                view.filter_project_by_index(4, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::FilterProject5, _, cx| {
                view.filter_project_by_index(5, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::FilterProject6, _, cx| {
                view.filter_project_by_index(6, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::FilterProject7, _, cx| {
                view.filter_project_by_index(7, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::FilterProject8, _, cx| {
                view.filter_project_by_index(8, cx);
            }))
            .on_action(cx.listener(|view, _: &crate::FilterProject9, _, cx| {
                view.filter_project_by_index(9, cx);
            }))
            .bg(rgb(0x0f141b))
            .text_color(rgb(0xd7e1eb))
            .child(self.render_header(cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .child(self.render_body(cx)),
            )
            .when_some(notice, |this, message| {
                this.child(
                    div()
                        .absolute()
                        .top(px(96.0))
                        .left(px(0.0))
                        .right(px(0.0))
                        .flex()
                        .justify_center()
                        .child(
                            div()
                                .px_3()
                                .py_1()
                                .rounded_md()
                                .bg(rgb(0x2b2418))
                                .border_1()
                                .border_color(rgb(0x6b552a))
                                .text_sm()
                                .text_color(rgb(0xe8c07a))
                                .child(message),
                        ),
                )
            })
            .child(self.render_detail(cx))
            .child(self.render_project_workspace(cx))
            .child(self.render_workflow_confirmation(cx))
    }
}

#[cfg_attr(test, allow(dead_code))]
fn snapshot_changed(old: &CardSnapshot, new: &CardSnapshot) -> bool {
    old.projects.len() != new.projects.len()
        || old.cards.len() != new.cards.len()
        || old
            .projects
            .iter()
            .zip(&new.projects)
            .any(|(a, b)| a.id != b.id || a.name != b.name || a.color_id != b.color_id)
        || old.cards.iter().zip(&new.cards).any(|(a, b)| {
            a.id != b.id
                || a.status != b.status
                || a.title != b.title
                || a.project_id != b.project_id
                || a.record_revision != b.record_revision
                || a.workflow_revision != b.workflow_revision
                || a.updated_at != b.updated_at
                || a.completion_outcome != b.completion_outcome
                || a.environment
                    .as_ref()
                    .map(|e| (&e.id, &e.branch, &e.lifecycle_state))
                    != b.environment
                        .as_ref()
                        .map(|e| (&e.id, &e.branch, &e.lifecycle_state))
                || a.pull_request
                    .as_ref()
                    .map(|p| (p.number, &p.state, &p.ci_status))
                    != b.pull_request
                        .as_ref()
                        .map(|p| (p.number, &p.state, &p.ci_status))
                || a.sort_order != b.sort_order
        })
}

fn new_project_terminal_pane_id() -> String {
    format!("term:{}", uuid::Uuid::new_v4())
}

fn project_release_owner_id(project_id: &str) -> String {
    format!("project:{project_id}:release")
}

fn project_terminal_owner_id(project_id: &str, pane_id: &str) -> String {
    format!("project:{project_id}:terminal:{pane_id}")
}

fn card_terminal_owner_id(card_id: &str, pane_id: &str) -> String {
    format!("card:{card_id}:terminal:{pane_id}")
}

fn terminal_owner_id(owner: &TerminalOwner, pane_id: &str) -> String {
    match owner {
        TerminalOwner::Project(project_id) => project_terminal_owner_id(project_id, pane_id),
        TerminalOwner::Card(card_id) => card_terminal_owner_id(card_id, pane_id),
    }
}

fn projects_alphabetically(projects: &[Project]) -> Vec<&Project> {
    let mut projects = projects.iter().collect::<Vec<_>>();
    projects.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    });
    projects
}

fn project_owner_id(project_id: &str) -> String {
    format!("project:{project_id}")
}

fn project_workspace_tab_visible(project: &Project, tab: ProjectWorkspaceTab) -> bool {
    match tab {
        ProjectWorkspaceTab::Agent
        | ProjectWorkspaceTab::Notes
        | ProjectWorkspaceTab::Diff
        | ProjectWorkspaceTab::Terminal => true,
        ProjectWorkspaceTab::Release => project.releases_enabled,
        ProjectWorkspaceTab::Server => project
            .server_command
            .as_deref()
            .is_some_and(|command| !command.trim().is_empty()),
        ProjectWorkspaceTab::Console => project
            .console_command
            .as_deref()
            .is_some_and(|command| !command.trim().is_empty()),
    }
}

fn card_server_target(card: &CardSummary, projects: &[Project]) -> Option<(String, String)> {
    if card.hierarchy_finalized {
        return None;
    }
    let worktree = card.environment.as_ref()?.worktree_path.clone();
    let command = project_service_command(card, projects, ServiceKind::Server)?;
    Some((worktree, command))
}

fn detail_tab_visible(card: &CardSummary, projects: &[Project], tab: DetailTab) -> bool {
    if card.hierarchy_finalized {
        return tab == DetailTab::Description;
    }
    match tab {
        DetailTab::Server => {
            card.environment.is_some()
                && project_service_command(card, projects, ServiceKind::Server).is_some()
        }
        DetailTab::Console => {
            card.environment.is_some()
                && project_service_command(card, projects, ServiceKind::Console).is_some()
        }
        _ => true,
    }
}

fn detail_tab_enabled(card: &CardSummary, projects: &[Project], tab: DetailTab) -> bool {
    match tab {
        DetailTab::Description => true,
        DetailTab::Agent => card.project(projects).is_some(),
        DetailTab::Diff | DetailTab::Terminal => card.environment.is_some(),
        DetailTab::Server | DetailTab::Console => {
            card.environment.is_some()
                && project_service_command(card, projects, tab_kind(tab)).is_some()
        }
    }
}

fn tab_kind(tab: DetailTab) -> ServiceKind {
    match tab {
        DetailTab::Server => ServiceKind::Server,
        _ => ServiceKind::Console,
    }
}

fn project_service_command(
    card: &CardSummary,
    projects: &[Project],
    kind: ServiceKind,
) -> Option<String> {
    let command = match kind {
        ServiceKind::Server => card.project(projects)?.server_command.clone(),
        ServiceKind::Console => card.project(projects)?.console_command.clone(),
        ServiceKind::Terminal => None,
    }?;
    (!command.trim().is_empty()).then_some(command)
}

fn status_tag(
    card: &CardSummary,
    projects: &[Project],
    project_accent: gpui::Hsla,
    step: &DeliveryStep,
) -> Tag {
    let group = work_group(card, projects);
    let (background, foreground, border) = match group {
        WorkGroup::Attention => (
            project_accent.opacity(0.30),
            project_accent,
            project_accent.opacity(0.75),
        ),
        WorkGroup::Progress => (
            project_accent.opacity(0.18),
            project_accent,
            project_accent.opacity(0.50),
        ),
        WorkGroup::Backlog | WorkGroup::Done => (
            project_accent.opacity(0.07),
            project_accent.opacity(0.72),
            project_accent.opacity(0.22),
        ),
    };
    Tag::custom(background, foreground, border).child(delivery_label(step))
}

fn group_index(group: WorkGroup) -> usize {
    WorkGroup::ALL
        .iter()
        .position(|candidate| *candidate == group)
        .unwrap_or(0)
}

fn project_accent(color: Option<&str>) -> gpui::Hsla {
    match color {
        Some("slate") => rgb(0x7f95a9).into(),
        Some("teal") => rgb(0x5fb8ad).into(),
        Some("green") => rgb(0x7abf7a).into(),
        Some("amber") => rgb(0xd6aa5f).into(),
        Some("coral") => rgb(0xd68b78).into(),
        Some("rose") => rgb(0xd28b9e).into(),
        Some("violet") => rgb(0xa892d6).into(),
        Some("indigo") => rgb(0x8098d8).into(),
        Some("cyan") => rgb(0x6fb7c8).into(),
        _ => rgb(0x4f8cbd).into(),
    }
}

fn delivery_label(step: &DeliveryStep) -> String {
    // The React list badge keeps only the part before " · ".
    step.label
        .split(" · ")
        .next()
        .unwrap_or(&step.label)
        .to_string()
}

fn hierarchy_label(card: &CardSummary) -> Option<String> {
    (card.child_count > 0).then(|| format!("{} children", card.child_count))
}

fn git_badge(status: &GitStatus) -> Option<Tag> {
    match status {
        GitStatus::Error { .. } => Some(Tag::warning().child("Git ?")),
        GitStatus::Ok(counts)
            if counts.created == 0 && counts.changed == 0 && counts.deleted == 0 =>
        {
            None
        }
        GitStatus::Ok(counts) => {
            let values = div()
                .flex()
                .items_center()
                .gap_1()
                .when(counts.created > 0, |this| {
                    this.child(
                        div()
                            .text_color(rgb(0x8acb8a))
                            .child(format!("+{}", counts.created)),
                    )
                })
                .when(counts.changed > 0, |this| {
                    this.child(
                        div()
                            .text_color(rgb(0xd6aa5f))
                            .child(format!("~{}", counts.changed)),
                    )
                })
                .when(counts.deleted > 0, |this| {
                    this.child(
                        div()
                            .text_color(rgb(0xd68b78))
                            .child(format!("-{}", counts.deleted)),
                    )
                });
            Some(
                Tag::custom(
                    rgb(0x151f2b).into(),
                    rgb(crate::theme::TEXT_MUTED).into(),
                    rgb(crate::theme::BORDER_SUBTLE).into(),
                )
                .px_2()
                .child(values),
            )
        }
    }
}

fn pr_badge(pr: &PullRequestIndicator) -> Tag {
    let variant = match pr.ci_status.as_str() {
        "success" => TagVariant::Success,
        "failure" => TagVariant::Danger,
        "pending" => TagVariant::Warning,
        _ => TagVariant::Secondary,
    };
    let marker = match pr.ci_status.as_str() {
        "success" => "✓",
        "failure" => "×",
        "pending" => "…",
        _ => "?",
    };
    Tag::new()
        .with_variant(variant)
        .child(format!("PR #{} {}", pr.number, marker))
}

#[cfg(test)]
mod tests {
    use super::*;
    use stacks_cards::{DeliveryWorkflow, Project, Relationship};

    fn card(id: &str, status: CardStatus, project_id: &str) -> CardSummary {
        CardSummary {
            id: id.into(),
            provider: "local".into(),
            external_id: id.into(),
            title: id.into(),
            board_id: String::new(),
            board_title: String::new(),
            list_title: String::new(),
            assignee_names: Vec::new(),
            status,
            completion_outcome: None,
            workflow_revision: 1,
            record_revision: 1,
            project_id: Some(project_id.into()),
            parent: None,
            child_count: 0,
            children: Vec::new(),
            hierarchy_finalized: false,
            environment: None,
            pull_request: None,
            delivery_operation_stage: None,
            delivery_error: None,
            created_at: 0,
            updated_at: 0,
            sort_order: 0,
        }
    }

    fn project(id: &str) -> Project {
        Project {
            id: id.into(),
            name: id.into(),
            path: "/tmp".into(),
            color_id: Some("slate".into()),
            delivery_workflow: DeliveryWorkflow::LocalMerge,
            kanban_source: Some("local".into()),
            server_command: None,
            console_command: None,
            notes: String::new(),
            releases_enabled: false,
            release_config_path: ".stacks/release.json".into(),
            supports_feature_environments: false,
            target_branch: "main".into(),
            start_work_command: None,
            deployment_command: None,
        }
    }

    #[test]
    fn rows_keep_group_order_and_collapse_state() {
        let snapshot = CardSnapshot {
            projects: vec![project("p1")],
            cards: vec![
                card("backlog", CardStatus::NeedsRefinement, "p1"),
                card("ready", CardStatus::Ready, "p1"),
                card("done", CardStatus::Done, "p1"),
            ],
        };
        let flattened = flatten_rows(&snapshot, None, [false, false, false, true]);
        assert_eq!(
            flattened.card_order,
            ["ready", "backlog"],
            "attention is listed before backlog; Done is collapsed"
        );
        let flattened = flatten_rows(&snapshot, None, [false, false, true, true]);
        assert_eq!(flattened.card_order, ["ready"]);
    }

    #[test]
    fn project_filter_keeps_counts_and_hides_other_rows() {
        let snapshot = CardSnapshot {
            projects: vec![project("p1"), project("p2")],
            cards: vec![
                card("one", CardStatus::NeedsRefinement, "p1"),
                card("two", CardStatus::NeedsRefinement, "p2"),
            ],
        };
        let flattened = flatten_rows(&snapshot, Some("p1"), [false, false, false, true]);
        assert_eq!(flattened.card_order, ["one"]);
        assert!(flattened.rows.iter().any(|row| matches!(
            row,
            FlatRow::Header {
                group: WorkGroup::Backlog,
                count: 1,
                ..
            }
        )));
    }

    fn test_store() -> (tempfile::TempDir, CardStore) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workflow.sqlite3");
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE projects (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
                    color_id TEXT, delivery_workflow TEXT NOT NULL DEFAULT 'local_merge',
                    kanban_source TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
                    require_passing_ci INTEGER NOT NULL DEFAULT 1,
                    require_approval INTEGER NOT NULL DEFAULT 0,
                    server_command TEXT, console_command TEXT,
                    notes TEXT NOT NULL DEFAULT '',
                    releases_enabled INTEGER NOT NULL DEFAULT 0,
                    release_config_path TEXT NOT NULL DEFAULT '.stacks/release.json',
                    supports_feature_environments INTEGER NOT NULL DEFAULT 0,
                    target_branch TEXT, start_work_command TEXT, deployment_command TEXT
                );
                CREATE TABLE kanban_cards (
                    id TEXT PRIMARY KEY, external_provider TEXT NOT NULL, external_id TEXT NOT NULL,
                    title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', board_id TEXT NOT NULL DEFAULT '',
                    board_title TEXT NOT NULL DEFAULT '', list_id TEXT NOT NULL DEFAULT '',
                    list_title TEXT NOT NULL DEFAULT '', card_url TEXT NOT NULL DEFAULT '',
                    assignee_names TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
                    completion_outcome TEXT, feature_environment INTEGER NOT NULL DEFAULT 0,
                    delivery_operation_stage TEXT, delivery_error TEXT, runtime_cleanup_status TEXT,
                    runtime_cleanup_error TEXT, workflow_revision INTEGER NOT NULL DEFAULT 1,
                    record_revision INTEGER NOT NULL DEFAULT 1, project_id TEXT, workspace_id TEXT,
                    parent_id TEXT, hierarchy_finalized INTEGER NOT NULL DEFAULT 0,
                    provider_child_count INTEGER NOT NULL DEFAULT 0, provider_parent_title TEXT,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0, in_scope INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE card_environments (
                    id TEXT PRIMARY KEY, card_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
                    worktree_path TEXT NOT NULL, branch TEXT NOT NULL DEFAULT '',
                    lifecycle_state TEXT NOT NULL DEFAULT 'ready', revision INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, target_branch TEXT,
                    source_revision TEXT
                );
                CREATE TABLE card_layouts (
                    environment_id TEXT PRIMARY KEY, layout_revision INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE card_pull_requests (
                    card_id TEXT PRIMARY KEY, repository TEXT NOT NULL, number INTEGER NOT NULL,
                    title TEXT NOT NULL, url TEXT NOT NULL, state TEXT NOT NULL,
                    draft INTEGER NOT NULL DEFAULT 0, ci_status TEXT NOT NULL DEFAULT 'unknown',
                    review_state TEXT NOT NULL DEFAULT 'unknown', has_conflicts INTEGER NOT NULL DEFAULT 0,
                    mergeable INTEGER NOT NULL DEFAULT 0, head_revision TEXT, updated_at INTEGER NOT NULL
                );
                CREATE TABLE environment_creation_operations (
                    card_id TEXT PRIMARY KEY, cleanup_available INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE card_cleanup_operations (
                    card_id TEXT PRIMARY KEY, status TEXT NOT NULL
                );
                CREATE TABLE scripted_delivery_operations (
                    card_id TEXT PRIMARY KEY, stage TEXT NOT NULL
                );
                CREATE TABLE card_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL, actor TEXT NOT NULL, event_type TEXT NOT NULL,
                    outcome TEXT NOT NULL, from_status TEXT, to_status TEXT, summary TEXT,
                    error_code TEXT, error_detail TEXT
                );
                INSERT INTO projects(id,name,path,color_id,delivery_workflow,kanban_source,sort_order)
                    VALUES ('p1','Stacks','/tmp/stacks','slate','local_merge','local',0);
                INSERT INTO kanban_cards(id,external_provider,external_id,title,status,project_id,
                    created_at,updated_at,sort_order)
                    VALUES ('backlog-a','local:a','1','Backlog A','needs_refinement','p1',1,1,0),
                           ('backlog-b','local:b','2','Backlog B','needs_refinement','p1',2,2,1),
                           ('done','local:d','3','Done','done','p1',3,3,2);
                UPDATE kanban_cards SET completion_outcome='merged' WHERE id='done';
                UPDATE kanban_cards SET content='## Detail

- Markdown from gpui-component', card_url='https://example.test/b' WHERE id='backlog-b';
                INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,summary)
                    VALUES ('backlog-b',100,'user','status_change','success','Moved to backlog');
                "#,
            )
            .unwrap();
        let store = CardStore::new(&path);
        (directory, store)
    }

    #[gpui::test]
    fn renders_list_and_opens_card_with_keyboard(cx: &mut gpui::TestAppContext) {
        let (_directory, store) = test_store();
        let snapshot = store.load_snapshot().unwrap();
        let (view, cx) = cx.add_window_view(|_, cx| ListView::with_snapshot(cx, snapshot, store));
        cx.run_until_parked();
        assert!(cx.debug_bounds("group-attention").is_some());
        assert!(cx.debug_bounds("group-backlog").is_some());
        assert!(cx.debug_bounds("card-backlog-a").is_some());
        assert!(cx.debug_bounds("card-backlog-b").is_some());

        cx.update(|window, cx| {
            view.read(cx).focus_handle().focus(window, cx);
        });
        cx.simulate_keystrokes("down enter");
        view.read_with(cx, |view, _| {
            assert_eq!(view.keyboard_focused.as_deref(), Some("backlog-b"));
            let state = view.detail.as_ref().expect("detail opened");
            assert_eq!(state.summary.id, "backlog-b");
            let detail = state.detail.as_ref().expect("detail loaded");
            assert_eq!(detail.card.id, "backlog-b");
            assert!(detail.content.contains("gpui-component"));
            assert_eq!(detail.events.len(), 1);
        });
    }

    #[gpui::test]
    fn j_k_navigation_moves_focus_and_opens_card(cx: &mut gpui::TestAppContext) {
        let (_directory, store) = test_store();
        let snapshot = store.load_snapshot().unwrap();
        let (view, cx) = cx.add_window_view(|_, cx| ListView::with_snapshot(cx, snapshot, store));
        cx.run_until_parked();
        cx.update(|window, cx| {
            view.read(cx).focus_handle().focus(window, cx);
        });
        cx.simulate_keystrokes("j enter");
        view.read_with(cx, |view, _| {
            assert_eq!(view.keyboard_focused.as_deref(), Some("backlog-b"));
            assert_eq!(
                view.detail
                    .as_ref()
                    .and_then(|state| state.detail.as_ref())
                    .map(|detail| detail.card.id.as_str()),
                Some("backlog-b")
            );
        });
    }

    #[gpui::test]
    fn workflow_footer_applies_supported_local_action(cx: &mut gpui::TestAppContext) {
        let (_directory, store) = test_store();
        {
            let connection = rusqlite::Connection::open(store.path()).unwrap();
            connection
                .execute(
                    "INSERT INTO kanban_cards
                        (id,external_provider,external_id,title,status,project_id,created_at,updated_at,sort_order)
                     VALUES ('ready','local:r','4','Ready card','ready','p1',4,4,3)",
                    [],
                )
                .unwrap();
        }
        let snapshot = store.load_snapshot().unwrap();
        let revision = snapshot
            .cards
            .iter()
            .find(|card| card.id == "ready")
            .unwrap()
            .workflow_revision;
        let (view, cx) =
            cx.add_window_view(|_, cx| ListView::with_snapshot(cx, snapshot, store.clone()));
        cx.run_until_parked();
        view.update(cx, |view, cx| {
            view.apply_workflow_action(
                "ready".into(),
                stacks_cards::WorkflowAction::ReturnToRefinement,
                revision,
                cx,
            );
        });
        cx.run_until_parked();
        assert_eq!(
            store.load_detail("ready").unwrap().card.status,
            CardStatus::NeedsRefinement
        );
        view.read_with(cx, |view, _| {
            let state = view.detail.as_ref().expect("detail");
            assert_eq!(state.card_id, "ready");
            assert_eq!(state.tab, DetailTab::Agent);
            assert_eq!(
                state.detail.as_ref().unwrap().card.status,
                CardStatus::NeedsRefinement
            );
        });
        let detail = store.load_detail("ready").unwrap();
        view.update(cx, |view, cx| {
            view.apply_workflow_action(
                "ready".into(),
                stacks_cards::WorkflowAction::Close,
                detail.card.workflow_revision,
                cx,
            );
        });
        cx.run_until_parked();
        let closed = store.load_detail("ready").unwrap();
        assert_eq!(closed.card.status, CardStatus::Done);
        assert_eq!(closed.card.completion_outcome.as_deref(), Some("closed"));
        assert_eq!(closed.runtime_cleanup_status.as_deref(), Some("complete"));
    }

    #[gpui::test]
    fn detail_tab_actions_and_escape_work(cx: &mut gpui::TestAppContext) {
        let (_directory, store) = test_store();
        let snapshot = store.load_snapshot().unwrap();
        let (view, cx) = cx.add_window_view(|_, cx| ListView::with_snapshot(cx, snapshot, store));
        cx.run_until_parked();
        cx.update(|window, cx| {
            view.read(cx).focus_handle().focus(window, cx);
        });
        cx.simulate_keystrokes("j enter");
        view.read_with(cx, |view, _| assert!(view.detail.is_some()));
        cx.dispatch_action(crate::DetailAgent);
        view.read_with(cx, |view, _| {
            assert_eq!(
                view.detail.as_ref().map(|state| state.tab),
                Some(DetailTab::Agent)
            );
        });
        cx.dispatch_action(crate::DetailDescription);
        view.read_with(cx, |view, _| {
            assert_eq!(
                view.detail.as_ref().map(|state| state.tab),
                Some(DetailTab::Description)
            );
        });
        cx.dispatch_action(crate::CloseDetail);
        view.read_with(cx, |view, _| assert!(view.detail.is_none()));
    }

    #[gpui::test]
    fn drag_backlog_row_reorders_optimistically_and_persists(cx: &mut gpui::TestAppContext) {
        let (_directory, store) = test_store();
        let snapshot = store.load_snapshot().unwrap();
        let (view, cx) =
            cx.add_window_view(|_, cx| ListView::with_snapshot(cx, snapshot, store.clone()));
        cx.run_until_parked();
        let first = cx
            .debug_bounds("card-backlog-a")
            .expect("first backlog row");
        let second = cx
            .debug_bounds("card-backlog-b")
            .expect("second backlog row");
        let first_center = gpui::point(
            first.origin.x + first.size.width / 2.0,
            first.origin.y + first.size.height / 2.0,
        );
        let second_center = gpui::point(
            second.origin.x + second.size.width / 2.0,
            second.origin.y + second.size.height / 2.0,
        );
        cx.simulate_mouse_down(
            second_center,
            gpui::MouseButton::Left,
            gpui::Modifiers::none(),
        );
        cx.simulate_mouse_move(
            gpui::point(second_center.x, second_center.y - gpui::px(12.0)),
            Some(gpui::MouseButton::Left),
            gpui::Modifiers::none(),
        );
        cx.simulate_mouse_move(
            first_center,
            Some(gpui::MouseButton::Left),
            gpui::Modifiers::none(),
        );
        cx.simulate_mouse_up(
            first_center,
            gpui::MouseButton::Left,
            gpui::Modifiers::none(),
        );
        cx.run_until_parked();
        cx.run_until_parked();
        view.read_with(cx, |view, _| {
            let order = view
                .visible_cards
                .iter()
                .filter(|card| card.status == CardStatus::NeedsRefinement)
                .map(|card| card.id.as_str())
                .collect::<Vec<_>>();
            assert_eq!(order, ["backlog-b", "backlog-a"]);
        });
        let persisted = store.load_snapshot().unwrap();
        let lane = persisted
            .cards
            .iter()
            .filter(|card| card.status == CardStatus::NeedsRefinement)
            .map(|card| card.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(lane, ["backlog-b", "backlog-a"]);
    }

    #[gpui::test]
    fn large_list_scroll_layout_is_viewport_bounded(cx: &mut gpui::TestAppContext) {
        let cards = (0..2137)
            .map(|index| {
                let mut card = card(
                    &format!("synthetic-{index:05}"),
                    CardStatus::NeedsRefinement,
                    "p1",
                );
                card.external_id = format!("9{index:05}");
                card.title = format!("Synthetic card {index}");
                card
            })
            .collect::<Vec<_>>();
        let snapshot = CardSnapshot {
            projects: vec![project("p1")],
            cards,
        };
        let store = CardStore::new("/nonexistent");
        let (view, cx) = cx.add_window_view(|_, cx| ListView::with_snapshot(cx, snapshot, store));
        cx.run_until_parked();
        let mut samples = Vec::new();
        for index in (0..200).map(|step| step * 10) {
            view.update(cx, |view, cx| {
                view.scroll.scroll_to_item(index, ScrollStrategy::Top);
                cx.notify();
            });
            let started = Instant::now();
            cx.update(|window, cx| {
                let _ = window.draw(cx);
            });
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(|left, right| left.total_cmp(right));
        let median = samples[samples.len() / 2];
        let p95 = samples[(samples.len() * 95) / 100];
        let visible = view.read_with(cx, |view, _| view.visible_range.len());
        assert!(visible <= 40, "uniform list rendered {visible} rows");
        eprintln!(
            "STACKS_GPUI_METRIC headless_scroll_median_ms={median:.2} headless_scroll_p95_ms={p95:.2} headless_scroll_visible_rows={visible} headless_scroll_cards=2137"
        );
    }

    #[test]
    fn service_tabs_require_commands_and_workspace() {
        let mut project = project("p1");
        project.server_command = Some("bin/dev".into());
        project.console_command = Some("bin/console".into());
        let mut entry = card("card", CardStatus::AgentWorking, "p1");
        assert!(!detail_tab_visible(
            &entry,
            std::slice::from_ref(&project),
            DetailTab::Server
        ));
        entry.environment = Some(stacks_cards::EnvironmentIndicator {
            id: "env".into(),
            project_id: "p1".into(),
            worktree_path: "/tmp/card".into(),
            branch: "stacks/card".into(),
            target_branch: Some("main".into()),
            lifecycle_state: "ready".into(),
            revision: 1,
            layout_revision: 1,
        });
        assert!(detail_tab_visible(
            &entry,
            std::slice::from_ref(&project),
            DetailTab::Server
        ));
        assert!(detail_tab_enabled(
            &entry,
            std::slice::from_ref(&project),
            DetailTab::Console
        ));
        assert_eq!(
            card_server_target(&entry, std::slice::from_ref(&project)),
            Some(("/tmp/card".into(), "bin/dev".into()))
        );
        project.console_command = None;
        assert!(!detail_tab_visible(
            &entry,
            std::slice::from_ref(&project),
            DetailTab::Console
        ));
    }

    #[gpui::test]
    fn card_terminal_tab_uses_the_shared_split_model(cx: &mut gpui::TestAppContext) {
        let (directory, store) = test_store();
        let path = directory.path().join("workflow.sqlite3");
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "INSERT INTO card_environments(id,card_id,project_id,worktree_path,branch,lifecycle_state,revision,created_at,updated_at)
                 VALUES ('env-backlog','backlog-b','p1','/tmp/card','stacks/card','ready',1,1,1);",
            )
            .unwrap();
        drop(connection);
        let snapshot = store.load_snapshot().unwrap();
        let (view, cx) = cx.add_window_view(|_, cx| ListView::with_snapshot(cx, snapshot, store));
        cx.run_until_parked();
        cx.update(|window, cx| {
            view.read(cx).focus_handle().focus(window, cx);
        });
        cx.simulate_keystrokes("j enter");
        cx.dispatch_action(crate::DetailTerminal);
        view.read_with(cx, |view, _| {
            let terminal = view
                .detail
                .as_ref()
                .and_then(|state| state.terminal.as_ref())
                .expect("card terminal initialized");
            assert_eq!(terminal.layout.leaves().len(), 1);
        });
        cx.dispatch_action(crate::ProjectSplitRight);
        view.read_with(cx, |view, _| {
            assert_eq!(
                view.detail
                    .as_ref()
                    .and_then(|state| state.terminal.as_ref())
                    .map(|terminal| terminal.layout.leaves().len()),
                Some(2)
            );
        });
        cx.dispatch_action(crate::ProjectClosePane);
        cx.dispatch_action(crate::ProjectClosePane);
        view.read_with(cx, |view, _| {
            assert_eq!(
                view.detail
                    .as_ref()
                    .and_then(|state| state.terminal.as_ref())
                    .map(|terminal| terminal.layout.leaves().len()),
                Some(1),
                "Cmd+W must no-op with a single terminal pane"
            );
        });
    }

    #[gpui::test]
    fn project_workspace_opens_and_switches_tabs(cx: &mut gpui::TestAppContext) {
        let (_directory, store) = test_store();
        let snapshot = store.load_snapshot().unwrap();
        let (view, cx) = cx.add_window_view(|_, cx| ListView::with_snapshot(cx, snapshot, store));
        cx.run_until_parked();
        cx.update(|window, cx| {
            view.read(cx).focus_handle().focus(window, cx);
        });
        view.update(cx, |view, cx| {
            view.open_project_workspace("p1".into(), cx);
        });
        view.read_with(cx, |view, _| {
            assert!(view.project_workspace.is_some());
            assert_eq!(
                view.project_workspace
                    .as_ref()
                    .map(|workspace| workspace.tab),
                Some(ProjectWorkspaceTab::Terminal)
            );
        });
        cx.dispatch_action(crate::ProjectNotes);
        view.read_with(cx, |view, _| {
            assert_eq!(
                view.project_workspace
                    .as_ref()
                    .map(|workspace| workspace.tab),
                Some(ProjectWorkspaceTab::Notes)
            );
        });
        cx.dispatch_action(crate::CloseDetail);
        view.read_with(cx, |view, _| assert!(view.project_workspace.is_none()));
    }

    #[gpui::test]
    fn project_filter_actions_select_sorted_projects(cx: &mut gpui::TestAppContext) {
        let (_directory, store) = test_store();
        let snapshot = store.load_snapshot().unwrap();
        let (view, cx) = cx.add_window_view(|_, cx| ListView::with_snapshot(cx, snapshot, store));
        cx.run_until_parked();
        cx.update(|window, cx| {
            view.read(cx).focus_handle().focus(window, cx);
        });
        cx.dispatch_action(crate::FilterProject1);
        view.read_with(cx, |view, _| {
            assert_eq!(view.project_filter.as_deref(), Some("p1"));
        });
        cx.dispatch_action(crate::FilterProjectAll);
        view.read_with(cx, |view, _| assert!(view.project_filter.is_none()));
    }

    #[test]
    fn projects_sort_alphabetically_case_insensitively() {
        let mut a = project("a");
        a.name = "zeta".into();
        let mut b = project("b");
        b.name = "Alpha".into();
        let projects = vec![a, b];
        assert_eq!(
            projects_alphabetically(&projects)
                .into_iter()
                .map(|project| project.name.as_str())
                .collect::<Vec<_>>(),
            ["Alpha", "zeta"]
        );
    }

    #[test]
    fn release_tab_requires_releases_enabled() {
        let mut project = project("p1");
        assert!(!project_workspace_tab_visible(
            &project,
            ProjectWorkspaceTab::Release
        ));
        project.releases_enabled = true;
        assert!(project_workspace_tab_visible(
            &project,
            ProjectWorkspaceTab::Release
        ));
    }

    #[test]
    fn hierarchy_label_uses_child_ownership() {
        let mut parent = card("parent", CardStatus::Ready, "p1");
        parent.child_count = 3;
        parent.children = vec![Relationship {
            id: "child".into(),
            external_id: "2".into(),
            title: "Child".into(),
            status: CardStatus::Ready,
        }];
        assert_eq!(hierarchy_label(&parent).as_deref(), Some("3 children"));
    }
}
