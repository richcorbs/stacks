//! Top-level frame composition.

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Paragraph},
};

use crate::{
    app::{App, Overlay, Screen},
    screens,
    theme::Theme,
    widgets::centered_message,
};

pub fn draw(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    app.cols = area.width;
    app.rows = area.height;
    frame.render_widget(
        Block::default().style(Style::default().bg(app.theme.canvas)),
        area,
    );
    if area.width < 100 || area.height < 30 {
        centered_message(
            frame,
            area,
            "Terminal too small",
            &format!(
                "Stacks TUI needs at least 100×30 cells; this terminal is {}×{}. State is preserved.",
                area.width, area.height
            ),
            app.theme,
        );
        return;
    }

    if app.overlay == Some(Overlay::GlobalTerminal) {
        screens::global_terminal::render(frame, app, area);
        if app.confirm.is_some() {
            screens::overlays::render(frame, app, area);
        }
        return;
    }

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(10),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .split(area);
    render_header(frame, app, chunks[0]);
    match app.screen {
        Screen::Board => screens::board::render(frame, app, chunks[1]),
        Screen::Detail => screens::detail::render(frame, app, chunks[1]),
    }
    render_status(frame, app, chunks[2]);
    render_hints(frame, app, chunks[3]);
    screens::overlays::render(frame, app, area);
}

fn render_header(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let mut left = vec![Span::styled(
        " Stacks ",
        Style::default()
            .fg(theme.canvas)
            .bg(theme.accent)
            .add_modifier(Modifier::BOLD),
    )];
    match app.screen {
        Screen::Board => {
            let scope = app
                .selected_project()
                .map(|project| project.name.clone())
                .unwrap_or_else(|| "All projects".into());
            let count = app
                .selected_project()
                .map(|project| app.project_count(&project.id))
                .unwrap_or_else(|| {
                    app.board
                        .as_ref()
                        .map(|board| board.cards.len())
                        .unwrap_or(0)
                });
            left.push(Span::styled(
                format!("  {scope}  ·  {count} cards"),
                Style::default().fg(theme.muted),
            ));
        }
        Screen::Detail => {
            let title = screens::detail::title(app);
            left.push(Span::styled(
                format!(
                    "  {}",
                    truncate(&title, area.width.saturating_sub(28) as usize)
                ),
                Style::default().fg(theme.text),
            ));
        }
    }
    let mode = if app.screen == Screen::Detail
        && (app.detail_tab.is_pi() || app.detail_tab == crate::app::DetailTab::Terminal)
    {
        app.session_focus()
    } else {
        ""
    };
    if !mode.is_empty() {
        left.push(Span::styled(
            format!("  {mode} "),
            Style::default().fg(theme.canvas).bg(if mode == "INPUT" {
                theme.accent
            } else {
                theme.warning
            }),
        ));
    }
    if app.is_busy() {
        left.push(Span::styled("  ●", Style::default().fg(theme.warning)));
    }
    frame.render_widget(
        Paragraph::new(Line::from(left)).style(Style::default().bg(theme.panel)),
        area,
    );
}

fn render_status(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let mut spans = Vec::new();
    if let Some(error) = &app.error {
        spans.push(Span::styled(
            format!(" ◆ {error}"),
            Style::default().fg(theme.danger),
        ));
    } else {
        spans.push(Span::styled(
            format!(" {}", app.message),
            Style::default().fg(theme.muted),
        ));
    }
    let position = match app.screen {
        Screen::Board => screens::board::position(app),
        Screen::Detail => Some(format!(
            "{} · {} · rev {}",
            app.detail_tab.label(),
            app.session_focus(),
            app.detail
                .as_ref()
                .map(|detail| detail.card.workflow_revision)
                .unwrap_or_default()
        )),
    };
    if let Some(position) = position {
        spans.push(Span::styled(
            format!("  {position}"),
            Style::default().fg(theme.dim),
        ));
    }
    if app.in_flight > 0 {
        spans.push(Span::styled(
            format!("  ● {} in flight", app.in_flight),
            Style::default().fg(theme.warning),
        ));
    }
    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(theme.panel)),
        area,
    );
}

fn render_hints(frame: &mut Frame, app: &mut App, area: Rect) {
    let hints = hint_entries(app);
    crate::widgets::hints::render_hints(frame, area, app.theme, &hints);
}

fn hint_entries(app: &App) -> Vec<(&'static str, &'static str)> {
    if app.confirm.is_some() {
        return vec![
            ("y", "confirm after delay"),
            ("n/Esc", "cancel"),
            ("Tab", "move focus"),
        ];
    }
    match app.overlay.clone() {
        Some(Overlay::Help) => vec![("j/k", "scroll"), ("Esc", "close")],
        Some(Overlay::Settings) => {
            vec![("j/k", "field"), ("h/l", "change"), ("Esc", "save & close")]
        }
        Some(Overlay::Palette) => {
            vec![("type", "fuzzy search"), ("Enter", "run"), ("Esc", "close")]
        }
        Some(Overlay::Projects) => vec![
            ("Enter", "select"),
            ("Ctrl-N", "new card"),
            ("Esc", "close"),
        ],
        Some(Overlay::Actions) => vec![("j/k", "choose"), ("Enter", "run"), ("Esc", "close")],
        Some(Overlay::NewCard) | Some(Overlay::EditCard) => vec![
            ("Tab", "field"),
            ("Enter/Ctrl-S", "submit"),
            ("Esc", "keep draft / cancel"),
        ],
        Some(Overlay::FinishRefinement) => vec![
            ("Ctrl-S", "save & finish"),
            ("Alt-Enter", "newline"),
            ("Esc", "close"),
        ],
        Some(Overlay::Filter) => vec![
            ("type", "filter"),
            ("Enter/Esc", "apply"),
            ("Ctrl-U", "clear"),
        ],
        Some(Overlay::GlobalTerminal) => vec![
            ("Ctrl-G", "close"),
            ("Ctrl-W n", "normal/tabs"),
            ("Ctrl-W [", "copy"),
        ],
        None => match app.screen {
            Screen::Board => vec![
                ("j/k", "move"),
                ("Enter", "open"),
                ("n", "new"),
                ("/", "filter"),
                ("Ctrl-F", "scope"),
                ("Ctrl-A", "done"),
                ("?", "help"),
            ],
            Screen::Detail => match app.detail_tab {
                crate::app::DetailTab::Overview => vec![
                    ("1..5", "tabs"),
                    ("e", "edit"),
                    ("a", "actions"),
                    ("Esc", "back"),
                ],
                crate::app::DetailTab::Diff => vec![
                    ("Space", "reviewed"),
                    ("n/p", "file"),
                    ("[ ]", "hunk"),
                    ("v", "select"),
                    ("Esc", "back"),
                ],
                crate::app::DetailTab::Terminal
                | crate::app::DetailTab::Chat
                | crate::app::DetailTab::Work => {
                    if app.terminal_focus {
                        vec![
                            ("Ctrl-W n", "normal mode"),
                            ("Ctrl-W [", "copy"),
                            ("Ctrl-Q", "quit"),
                        ]
                    } else {
                        vec![
                            ("i/Enter", "focus"),
                            ("Esc", "back"),
                            ("Tab", "tabs"),
                            ("Ctrl-W |/-", "split"),
                        ]
                    }
                }
            },
        },
    }
}

fn truncate(value: &str, width: usize) -> String {
    crate::widgets::truncate(value, width)
}

#[allow(dead_code)]
fn theme_name(theme: Theme) -> &'static str {
    let _ = theme;
    "stacks"
}
