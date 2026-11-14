//! Native LIST surface for the card #322 product-surface spike.
//!
//! This renders the surviving Stacks LIST from the real `workflow.sqlite3`
//! through `stacks-cards`. It deliberately does not reimplement workflow
//! transitions, GitHub/Superthread sync, done cleanup or card detail. Those
//! remain seams to the shipped Tauri app.

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use gpui::{
    ClipboardItem, Context, FocusHandle, IntoElement, KeyDownEvent, MouseButton, ParentElement,
    Render, ScrollStrategy, SharedString, UniformListScrollHandle, Window, div, prelude::*, px,
    rgb, uniform_list,
};
use gpui_component::{
    Sizable,
    button::{Button, ButtonVariants},
    spinner::Spinner,
    tag::{Tag, TagVariant},
    text::TextView,
};
use stacks_cards::{
    CardDetail, CardSnapshot, CardStatus, CardStore, CardSummary, DeliveryStep, Project,
    PullRequestIndicator, WorkGroup, delivery_step, group_cards,
};

use crate::shell::process_start;

const ROW_HEIGHT: f32 = 52.0;
const HEADER_HEIGHT: f32 = 44.0;

#[derive(Clone, Debug)]
enum FlatRow {
    Header {
        group: WorkGroup,
        count: usize,
        collapsed: bool,
    },
    Empty {
        group: WorkGroup,
    },
    Card {
        index: usize,
    },
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

#[derive(Clone)]
struct DetailState {
    card_id: String,
    summary: CardSummary,
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
    error: Option<String>,
    notice: Option<(String, Instant)>,
    detail: Option<DetailState>,
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
        view
    }

    fn empty(cx: &mut Context<Self>) -> Self {
        #[cfg(test)]
        gpui_component::init(cx);
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
            error: None,
            notice: None,
            detail: None,
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

    pub fn focus(&self, window: &mut Window) {
        self.focus_handle.focus(window);
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
                        if view.project_filter.as_deref().is_some_and(|id| {
                            !snapshot.projects.iter().any(|project| project.id == id)
                        }) {
                            view.project_filter = None;
                        }
                        view.snapshot = Some(snapshot);
                        view.error = None;
                        view.rebuild_rows();
                        if view
                            .keyboard_focused
                            .as_deref()
                            .is_none_or(|id| !view.row_for_card.contains_key(id))
                        {
                            view.keyboard_focused = view.card_order.first().cloned();
                        }
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
        self.focus_handle.focus(window);
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

    fn close_detail(&mut self, cx: &mut Context<Self>) {
        self.detail = None;
        self.detail_generation += 1;
        cx.notify();
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

    fn handle_key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.detail.is_some() {
            if event.keystroke.key == "escape" {
                self.close_detail(cx);
                cx.stop_propagation();
            }
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
        let project = self.project_filter.as_deref().and_then(|id| {
            snapshot.and_then(|snapshot| snapshot.projects.iter().find(|project| project.id == id))
        });
        let total = snapshot.map(|snapshot| snapshot.cards.len()).unwrap_or(0);
        let shown = self.visible_cards.len();
        let project_count = snapshot
            .map(|snapshot| snapshot.projects.len())
            .unwrap_or(0);
        let chips = snapshot
            .map(|snapshot| {
                snapshot
                    .projects
                    .iter()
                    .map(|project| {
                        let selected = self.project_filter.as_deref() == Some(project.id.as_str());
                        let count = snapshot
                            .cards
                            .iter()
                            .filter(|card| card.project_id.as_deref() == Some(project.id.as_str()))
                            .count();
                        (project, selected, count)
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
            .bg(rgb(0x11171f))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_3()
                    .px_3()
                    .h(px(HEADER_HEIGHT))
                    .child(div().text_sm().text_color(rgb(0xe3edf6)).child("Cards"))
                    .child(div().text_xs().text_color(rgb(0x6f8498)).child(format!(
                        "{} of {} cards · {} projects · read-only",
                        shown, total, project_count
                    )))
                    .child(div().flex_1())
                    .when_some(project, |this, project| {
                        this.child(
                            div()
                                .text_xs()
                                .text_color(rgb(0x8ea3b8))
                                .child(format!("Filtered to {}", project.name)),
                        )
                    })
                    .child(
                        div()
                            .text_xs()
                            .text_color(if self.reordering {
                                rgb(0xc8a15a)
                            } else {
                                rgb(0x6f8498)
                            })
                            .child(if self.reordering {
                                "Saving order…"
                            } else {
                                "Drag Backlog rows to reorder"
                            }),
                    )
                    .child(
                        Button::new("list-refresh")
                            .small()
                            .label(if self.refreshing {
                                "Refreshing…"
                            } else {
                                "Refresh ⌘R"
                            })
                            .loading(self.refreshing)
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.reload(cx);
                            })),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .px_3()
                    .pb_2()
                    .child({
                        let all = Button::new("filter-all").xsmall().label("All projects");
                        (if self.project_filter.is_none() {
                            all.primary()
                        } else {
                            all
                        })
                        .on_click(cx.listener(|view, _, _, cx| {
                            view.set_project_filter(None, cx);
                        }))
                    })
                    .children(chips.into_iter().map(|(project, selected, count)| {
                        let id = project.id.clone();
                        let button =
                            Button::new(SharedString::from(format!("filter-{}", project.id)))
                                .xsmall()
                                .label(format!("{} {}", project.name, count));
                        (if selected { button.primary() } else { button }).on_click(cx.listener(
                            move |view, _, _, cx| {
                                view.set_project_filter(Some(id.clone()), cx);
                            },
                        ))
                    })),
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
                            .text_color(rgb(0xe6b5bd))
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
                            .child("Retry"),
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
        .track_scroll(self.scroll.clone())
        .into_any_element()
    }

    fn render_row(
        &mut self,
        index: usize,
        projects: &[Project],
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        match self.rows.get(index).cloned() {
            Some(FlatRow::Header {
                group,
                count,
                collapsed,
            }) => div()
                .id(SharedString::from(format!("group-{}", group.id())))
                .debug_selector(|| format!("group-{}", group.id()))
                .flex()
                .items_center()
                .gap_2()
                .h(px(ROW_HEIGHT))
                .w_full()
                .px_4()
                .bg(rgb(0x141b24))
                .border_b_1()
                .border_color(rgb(0x222e3b))
                .cursor_pointer()
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.toggle_group(group, cx);
                }))
                .child(
                    div()
                        .w(px(12.0))
                        .text_color(rgb(0x8ea3b8))
                        .child(if collapsed { "▸" } else { "▾" }),
                )
                .child(
                    div()
                        .text_sm()
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(if group == WorkGroup::Attention && count > 0 {
                            rgb(0xe8c07a)
                        } else {
                            rgb(0xd7e1eb)
                        })
                        .child(group.label()),
                )
                .child(Tag::new().child(format!("{count}")))
                .child(div().flex_1())
                .when(group == WorkGroup::Done, |this| {
                    this.child(
                        div()
                            .text_xs()
                            .text_color(rgb(0x5f7488))
                            .child("Cleanup actions remain in Stacks"),
                    )
                })
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
        let warning = card.has_git_environment_warning();
        let hierarchy = hierarchy_label(&card);
        let debug_card_id = card.id.clone();
        let mut row = div()
            .id(SharedString::from(format!("card-{}", card.id)))
            .debug_selector(move || format!("card-{debug_card_id}"))
            .flex()
            .flex_col()
            .justify_center()
            .gap_1()
            .h(px(ROW_HEIGHT))
            .w_full()
            .px_3()
            .bg(if focused {
                rgb(0x1e2c3b)
            } else {
                rgb(0x10161e)
            })
            .border_b_1()
            .border_color(if focused {
                rgb(0x3b5e7d)
            } else {
                rgb(0x1b2430)
            })
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

        let source = div()
            .flex()
            .flex_row()
            .items_center()
            .gap_2()
            .min_w_0()
            .child(
                div()
                    .text_xs()
                    .text_color(rgb(0x6f8498))
                    .child(format!("#{}", card.external_id)),
            )
            .child(Tag::new().child(project_name))
            .child(
                Tag::new()
                    .with_variant(tag_variant_for_status(card.status, step.action_required))
                    .child(delivery_label(&step)),
            )
            .when_some(hierarchy, |this, label| this.child(Tag::new().child(label)))
            .when(warning, |this| {
                this.child(Tag::warning().child("! environment"))
            })
            .when_some(pr, |this, pr| this.child(pr_badge(&pr)))
            .child(div().flex_1())
            .when_some(card.parent.as_ref(), |this, parent| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(rgb(0x7f95a9))
                        .child(format!("parent #{}", parent.external_id)),
                )
            });

        row.child(source)
            .child(
                div()
                    .text_sm()
                    .text_color(if focused {
                        rgb(0xf0f5fa)
                    } else {
                        rgb(0xd7e1eb)
                    })
                    .truncate()
                    .child(card.title.clone()),
            )
            .into_any_element()
    }

    fn render_detail(&self, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let Some(state) = self.detail.clone() else {
            return div().into_any_element();
        };
        let card = state.summary.clone();
        let project_name = self
            .snapshot
            .as_ref()
            .and_then(|snapshot| {
                card.project(&snapshot.projects)
                    .map(|project| project.name.clone())
            })
            .unwrap_or_else(|| "Unknown project".into());
        let step = self
            .snapshot
            .as_ref()
            .map(|snapshot| delivery_step(&card, &snapshot.projects))
            .unwrap_or_else(|| DeliveryStep {
                label: card.status.label().into(),
                action_required: false,
                pr_merge_ready: false,
            });

        let header = div()
            .flex()
            .items_center()
            .gap_2()
            .h(px(52.0))
            .px_4()
            .flex_shrink_0()
            .border_b_1()
            .border_color(rgb(0x24303d))
            .child(
                Button::new("detail-back")
                    .small()
                    .label("← Cards")
                    .on_click(cx.listener(|view, _, _, cx| view.close_detail(cx))),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(rgb(0x6f8498))
                    .child(format!("#{}", card.external_id)),
            )
            .child(
                Tag::new()
                    .with_variant(tag_variant_for_status(card.status, step.action_required))
                    .child(card.status.label()),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_lg()
                    .text_color(rgb(0xe3edf6))
                    .child(card.title.clone()),
            )
            .child(
                Button::new("detail-copy")
                    .small()
                    .label("Copy ref")
                    .on_click(cx.listener(|view, _, _, cx| {
                        let Some(state) = view.detail.as_ref() else {
                            return;
                        };
                        let reference =
                            format!("#{} {}", state.summary.external_id, state.summary.title);
                        cx.write_to_clipboard(ClipboardItem::new_string(reference));
                        view.notice = Some(("Copied card reference".into(), Instant::now()));
                        cx.notify();
                    })),
            )
            .when(
                state
                    .detail
                    .as_ref()
                    .is_some_and(|detail| !detail.card_url.is_empty()),
                |this| {
                    this.child(
                        Button::new("detail-open-url")
                            .small()
                            .label("Open URL")
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
                },
            )
            .child(
                Button::new("detail-close")
                    .small()
                    .label("Close esc")
                    .on_click(cx.listener(|view, _, _, cx| view.close_detail(cx))),
            );

        let body =
            if state.loading {
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
                            .text_color(rgb(0xe6b5bd))
                            .child("Could not load card detail"),
                    )
                    .child(
                        div()
                            .max_w(px(760.0))
                            .text_sm()
                            .text_color(rgb(0x8ea3b8))
                            .child(error),
                    )
                    .child(Button::new("detail-retry").small().label("Retry").on_click(
                        cx.listener(|view, _, _, cx| {
                            if let Some(state) = view.detail.as_ref() {
                                view.open_card(state.card_id.clone(), cx);
                            }
                        }),
                    ))
                    .into_any_element()
            } else if let Some(detail) = state.detail.clone() {
                self.render_detail_body(&detail, &project_name, &step, window, cx)
            } else {
                div().into_any_element()
            };

        div()
            .absolute()
            .top(px(0.0))
            .left(px(0.0))
            .right(px(0.0))
            .bottom(px(0.0))
            .flex()
            .flex_col()
            .bg(rgb(0x0f141b))
            .child(header)
            .child(div().flex_1().min_h_0().min_w_0().child(body))
            .into_any_element()
    }

    fn render_detail_body(
        &self,
        detail: &CardDetail,
        project_name: &str,
        step: &DeliveryStep,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let card = &detail.card;
        let mut metadata = vec![
            ("Project".to_string(), project_name.to_string()),
            ("Delivery".to_string(), step.label.clone()),
            (
                "Workflow revision".to_string(),
                card.workflow_revision.to_string(),
            ),
            (
                "Record revision".to_string(),
                card.record_revision.to_string(),
            ),
            (
                "Board / list".to_string(),
                format!("{} / {}", card.board_title, card.list_title),
            ),
            (
                "Assignees".to_string(),
                if card.assignee_names.is_empty() {
                    "Unassigned".into()
                } else {
                    card.assignee_names.join(", ")
                },
            ),
            (
                "Environment".to_string(),
                card.environment
                    .as_ref()
                    .map(|environment| {
                        format!(
                            "{}\n{}\nlifecycle: {} · target: {}\n{}",
                            environment.branch,
                            environment.worktree_path,
                            environment.lifecycle_state,
                            environment.target_branch.as_deref().unwrap_or("none"),
                            environment.id
                        )
                    })
                    .unwrap_or_else(|| "none".into()),
            ),
            (
                "PR".to_string(),
                card.pull_request
                    .as_ref()
                    .map(|pr| {
                        format!(
                            "#{} · {} · CI {} · review {}\n{}",
                            pr.number, pr.state, pr.ci_status, pr.review_state, pr.url
                        )
                    })
                    .unwrap_or_else(|| "none".into()),
            ),
        ];
        metadata.push((
            "Hierarchy".to_string(),
            if card.parent.is_some() || card.child_count > 0 {
                format!(
                    "{} children · finalized {}",
                    card.child_count, card.hierarchy_finalized
                )
            } else {
                "none".into()
            },
        ));
        if let Some(pr) = card.pull_request.as_ref()
            && !pr.blockers.is_empty()
        {
            metadata.push(("PR blockers".into(), pr.blockers.join("\n")));
        }
        if let Some(status) = detail.runtime_cleanup_status.as_deref() {
            metadata.push((
                "Runtime cleanup".into(),
                detail
                    .runtime_cleanup_error
                    .as_deref()
                    .map(|error| format!("{status}: {error}"))
                    .unwrap_or_else(|| status.to_string()),
            ));
        }
        if detail.feature_environment {
            metadata.push(("Feature environment".into(), "yes".into()));
        }

        let mut hierarchy = Vec::new();
        if let Some(parent) = card.parent.as_ref() {
            let id = parent.id.clone();
            hierarchy.push(
                Button::new(SharedString::from(format!("detail-parent-{}", parent.id)))
                    .text()
                    .label(format!("parent #{} · {}", parent.external_id, parent.title))
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.open_card(id.clone(), cx);
                    }))
                    .into_any_element(),
            );
        }
        for child in card.children.iter().take(12) {
            let id = child.id.clone();
            hierarchy.push(
                Button::new(SharedString::from(format!("detail-child-{}", child.id)))
                    .text()
                    .label(format!(
                        "#{} · {} · {}",
                        child.external_id,
                        child.title,
                        child.status.label()
                    ))
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.open_card(id.clone(), cx);
                    }))
                    .into_any_element(),
            );
        }

        let content = div()
            .id("detail-content")
            .flex_1()
            .min_w_0()
            .min_h_0()
            .overflow_y_scroll()
            .px_5()
            .py_4()
            .child(
                div()
                    .text_xs()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(rgb(0x6f8498))
                    .child("DESCRIPTION"),
            )
            .child(div().mt_2().child(if detail.content.trim().is_empty() {
                div()
                    .text_sm()
                    .text_color(rgb(0x6f8498))
                    .child("No description.")
                    .into_any_element()
            } else {
                TextView::markdown(
                    SharedString::from(format!("detail-markdown-{}", card.id)),
                    detail.content.clone(),
                    window,
                    cx,
                )
                .selectable(true)
                .into_any_element()
            }));

        let sidebar = div()
            .id("detail-sidebar")
            .w(px(340.0))
            .flex_shrink_0()
            .min_h_0()
            .overflow_y_scroll()
            .border_l_1()
            .border_color(rgb(0x24303d))
            .p_4()
            .child(
                div()
                    .text_xs()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(rgb(0x6f8498))
                    .child("CARD"),
            )
            .children(metadata.into_iter().map(|(label, value)| {
                div()
                    .mt_3()
                    .child(div().text_xs().text_color(rgb(0x6f8498)).child(label))
                    .child(
                        div()
                            .mt_1()
                            .text_sm()
                            .text_color(rgb(0xd7e1eb))
                            .child(value),
                    )
            }))
            .when(!hierarchy.is_empty(), |this| {
                this.child(
                    div()
                        .mt_5()
                        .text_xs()
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(rgb(0x6f8498))
                        .child("HIERARCHY"),
                )
                .children(
                    hierarchy
                        .into_iter()
                        .map(|entry| div().mt_1().w_full().child(entry)),
                )
            })
            .child(
                div()
                    .mt_5()
                    .text_xs()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(rgb(0x6f8498))
                    .child(format!("EVENTS ({})", detail.events.len())),
            )
            .children(detail.events.iter().take(10).map(|event| {
                div()
                    .mt_2()
                    .flex()
                    .gap_2()
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
                            .flex_1()
                            .min_w_0()
                            .text_xs()
                            .text_color(rgb(0xb9c7d4))
                            .child(
                                event
                                    .summary
                                    .clone()
                                    .unwrap_or_else(|| event.event_type.clone()),
                            ),
                    )
            }));

        div()
            .size_full()
            .flex()
            .flex_row()
            .min_h_0()
            .child(content)
            .child(sidebar)
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
            collapsed: collapsed[index],
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
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
            .key_context("StacksList")
            .on_key_down(cx.listener(Self::handle_key_down))
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
            .child(self.render_detail(window, cx))
    }
}

fn tag_variant_for_status(status: CardStatus, action_required: bool) -> TagVariant {
    if action_required {
        return TagVariant::Warning;
    }
    match status {
        CardStatus::NeedsRefinement => TagVariant::Secondary,
        CardStatus::Refining | CardStatus::AgentWorking => TagVariant::Info,
        CardStatus::NeedsRefinementInput | CardStatus::NeedsHuman => TagVariant::Warning,
        CardStatus::Ready => TagVariant::Success,
        CardStatus::Approved => TagVariant::Primary,
        CardStatus::Done => TagVariant::Secondary,
    }
}

fn group_index(group: WorkGroup) -> usize {
    WorkGroup::ALL
        .iter()
        .position(|candidate| *candidate == group)
        .unwrap_or(0)
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
    if card.child_count > 0 {
        Some(format!("{} children", card.child_count))
    } else if card.parent.is_some() {
        Some("child".into())
    } else {
        None
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
                    require_approval INTEGER NOT NULL DEFAULT 0
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

        cx.update(|window, cx| view.read(cx).focus(window));
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
