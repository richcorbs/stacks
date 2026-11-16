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
    theme::{Theme, status_color, status_glyph},
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

    // The board already carries scope/count in its CARDS panel border; do not
    // spend a row repeating it above the project sidebar.
    let header_height = if app.screen == Screen::Board { 0 } else { 1 };
    let status_height = if app.screen == Screen::Board
        || app.error.is_some()
        || app.in_flight > 0
        || (!app.message.is_empty() && app.message != "Ready")
    {
        1
    } else {
        0
    };
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(header_height),
            Constraint::Min(10),
            Constraint::Length(status_height),
            Constraint::Length(1),
        ])
        .split(area);
    if header_height > 0 {
        render_header(frame, app, chunks[0]);
    }
    match app.screen {
        Screen::Board => screens::board::render(frame, app, chunks[1]),
        Screen::Detail => screens::detail::render(frame, app, chunks[1]),
        Screen::Project => screens::project::render(frame, app, chunks[1]),
    }
    if status_height > 0 {
        render_status(frame, app, chunks[2]);
    }
    render_hints(frame, app, chunks[3]);
    screens::overlays::render(frame, app, area);
}

fn render_header(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let mut left = Vec::new();
    match app.screen {
        Screen::Board => {
            left.push(Span::styled(
                " Stacks ",
                Style::default()
                    .fg(theme.canvas)
                    .bg(theme.accent)
                    .add_modifier(Modifier::BOLD),
            ));
            let scope = app
                .selected_project()
                .map(|project| project.name.clone())
                .unwrap_or_else(|| "All projects".into());
            left.push(Span::styled(
                format!("  {scope}"),
                Style::default().fg(theme.muted),
            ));
        }
        Screen::Project => {
            let project = app.project.as_ref().and_then(|state| {
                app.board.as_ref().and_then(|board| {
                    board
                        .projects
                        .iter()
                        .find(|project| project.id == state.project_id)
                })
            });
            if let Some(project) = project {
                left.push(Span::styled(
                    format!(" {}", truncate(&project.name, 36)),
                    Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
                ));
                left.push(Span::styled(
                    format!(
                        "  {}",
                        truncate(&project.path, area.width.saturating_sub(46) as usize)
                    ),
                    Style::default().fg(theme.muted),
                ));
            } else {
                left.push(Span::styled(" Project", Style::default().fg(theme.text)));
            }
        }
        Screen::Detail => {
            if let Some(detail) = app.detail.as_ref() {
                let (glyph, _) = status_glyph(detail.card.status);
                left.push(Span::styled(
                    glyph.to_string(),
                    Style::default()
                        .fg(status_color(theme, detail.card.status))
                        .add_modifier(Modifier::BOLD),
                ));
                left.push(Span::styled(" ", Style::default()));
            }
            let title = screens::detail::title(app);
            left.push(Span::styled(
                format!(
                    "{}",
                    truncate(&title, area.width.saturating_sub(6) as usize)
                ),
                Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
            ));
        }
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
        Screen::Detail | Screen::Project => None,
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
            ("1 / y", "confirm after delay"),
            ("2 / n", "cancel"),
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
        Some(Overlay::NewProject) => {
            vec![("Tab", "field"), ("Enter/Ctrl-S", "add"), ("Esc", "cancel")]
        }
        Some(Overlay::EditProject) => vec![("Tab", "field"), ("Ctrl-S", "save"), ("Esc", "cancel")],
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
        Some(Overlay::DiffComment) => vec![
            ("type", "feedback"),
            ("Alt-Enter", "newline"),
            ("Ctrl-S", "save"),
            ("Esc", "cancel"),
        ],
        Some(Overlay::GlobalTerminal) => vec![
            ("Ctrl-G", "close"),
            ("Ctrl-W Ctrl-W", "release / tabs"),
            ("Ctrl-W [", "copy"),
        ],
        None => match app.screen {
            Screen::Board if app.focus == crate::app::Focus::Sidebar => vec![
                ("j/k", "project"),
                ("Enter", "filter"),
                ("n", "new"),
                ("e", "edit"),
                ("D", "delete"),
                ("w", "workspace"),
                ("Ctrl-F", "cycle"),
            ],
            Screen::Board => {
                let group = app
                    .board_rows
                    .get(app.board_cursor)
                    .is_some_and(|row| row.kind == crate::app::BoardRowKind::Group);
                vec![
                    ("j/k", "move"),
                    ("Enter", if group { "collapse" } else { "open" }),
                    ("h/l", "fold"),
                    ("n", "new"),
                    ("w", "workspace"),
                    ("/", "filter"),
                    ("Ctrl-F", "scope"),
                    ("Ctrl-A", "done"),
                    ("?", "help"),
                ]
            }
            Screen::Project => {
                let tab = app
                    .project
                    .as_ref()
                    .map(|state| state.tab)
                    .unwrap_or(crate::app::ProjectTab::Notes);
                let editing = app
                    .project
                    .as_ref()
                    .is_some_and(|state| state.notes_editing);
                match tab {
                    crate::app::ProjectTab::Notes if editing => {
                        vec![("type", "notes"), ("Ctrl-S", "save"), ("Esc", "done")]
                    }
                    crate::app::ProjectTab::Notes => vec![
                        ("e/Enter", "edit"),
                        ("j/k", "scroll"),
                        ("Esc", "back"),
                        ("Tab", "tabs"),
                    ],
                    crate::app::ProjectTab::Diff => vec![
                        ("c/C", "comment"),
                        ("s", "send Agent"),
                        ("n/p", "file"),
                        ("Space", "reviewed"),
                        ("r", "refresh"),
                        ("Esc", "back"),
                    ],
                    crate::app::ProjectTab::Release => vec![
                        ("e", "version"),
                        ("r", "release"),
                        ("b", "build & test"),
                        ("p", "publish"),
                        ("R", "refresh"),
                        ("Esc", "back"),
                    ],
                    _ if app.terminal_focus => vec![
                        ("Ctrl-W Ctrl-W", "release"),
                        ("Ctrl-W [", "copy"),
                        ("Ctrl-Q", "quit"),
                    ],
                    _ => vec![
                        ("i/Enter", "focus"),
                        ("Esc", "back"),
                        ("Tab", "tabs"),
                        ("Ctrl-W |/-", "split"),
                    ],
                }
            }
            Screen::Detail => match app.detail_tab {
                crate::app::DetailTab::Overview => vec![
                    ("1..6", "tabs"),
                    ("e", "edit"),
                    ("a", "actions"),
                    ("Esc", "back"),
                ],
                crate::app::DetailTab::Diff => vec![
                    ("Space", "reviewed"),
                    ("c/C", "comment"),
                    ("s", "send Agent"),
                    ("n/p", "file"),
                    ("[ ]", "hunk"),
                    ("h/l", "fold"),
                    ("Esc", "back"),
                ],
                crate::app::DetailTab::Agent => {
                    if app.terminal_focus {
                        vec![("Ctrl-W Ctrl-W", "release"), ("Ctrl-Q", "quit")]
                    } else {
                        vec![("i/Enter", "focus"), ("Esc", "back"), ("Tab", "tabs")]
                    }
                }
                crate::app::DetailTab::Terminal
                | crate::app::DetailTab::Server
                | crate::app::DetailTab::Console => {
                    if app.terminal_focus {
                        vec![
                            ("Ctrl-W Ctrl-W", "release"),
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
