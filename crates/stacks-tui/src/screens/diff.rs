//! DIFF: collapsible file tree, review context and unified diff.

use std::collections::{BTreeMap, HashSet};

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
};
use stacks_core::diff::{DiffFile, DiffFileStatus};

use crate::{
    app::App,
    widgets::{
        diff_view::{self, DiffView},
        truncate,
    },
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffRowKind {
    Dir {
        path: String,
        name: String,
        files: usize,
        depth: usize,
        expanded: bool,
    },
    File {
        index: usize,
        depth: usize,
    },
}

pub type DiffRow = DiffRowKind;

struct Node {
    name: String,
    path: String,
    dirs: BTreeMap<String, Node>,
    files: Vec<(String, usize)>,
}

impl Node {
    fn new(name: impl Into<String>, path: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            path: path.into(),
            dirs: BTreeMap::new(),
            files: Vec::new(),
        }
    }

    fn insert(&mut self, path: &str, index: usize) {
        let parts = path.split('/').collect::<Vec<_>>();
        self.insert_parts(&parts, path, index);
    }

    fn insert_parts(&mut self, parts: &[&str], full_path: &str, index: usize) {
        match parts {
            [] => {}
            [file] => self.files.push(((*file).to_string(), index)),
            [directory, rest @ ..] => {
                let child_path = if self.path.is_empty() {
                    (*directory).to_string()
                } else {
                    format!("{}/{}", self.path, directory)
                };
                let child = self
                    .dirs
                    .entry((*directory).to_string())
                    .or_insert_with(|| Node::new(*directory, child_path));
                child.insert_parts(rest, full_path, index);
            }
        }
    }

    fn file_count(&self) -> usize {
        self.files.len() + self.dirs.values().map(Node::file_count).sum::<usize>()
    }

    fn compress(mut self) -> Self {
        self.dirs = self
            .dirs
            .into_iter()
            .map(|(key, child)| (key, child.compress()))
            .collect();
        while self.files.is_empty() && self.dirs.len() == 1 {
            let (_, child) = self.dirs.into_iter().next().expect("one directory");
            self.name = format!("{}/{}", self.name, child.name);
            self.path = child.path;
            self.dirs = child.dirs;
            self.files = child.files;
        }
        self
    }
}

pub fn diff_rows(files: &[DiffFile], collapsed: &HashSet<String>) -> Vec<DiffRow> {
    let mut root = Node::new("", "");
    for (index, file) in files.iter().enumerate() {
        root.insert(&file.path, index);
    }
    let mut rows = Vec::new();
    for (_, directory) in root.dirs {
        flatten(directory.compress(), 0, collapsed, &mut rows);
    }
    let mut root_files = root.files;
    root_files.sort_by(|left, right| left.0.cmp(&right.0));
    for (_, index) in root_files {
        rows.push(DiffRowKind::File { index, depth: 0 });
    }
    rows
}

fn flatten(node: Node, depth: usize, collapsed: &HashSet<String>, rows: &mut Vec<DiffRow>) {
    let is_collapsed = collapsed.contains(&node.path);
    let file_count = node.file_count();
    rows.push(DiffRowKind::Dir {
        path: node.path.clone(),
        name: node.name,
        files: file_count,
        depth,
        expanded: !is_collapsed,
    });
    if is_collapsed {
        return;
    }
    let mut dirs = node
        .dirs
        .into_iter()
        .map(|(_, node)| node)
        .collect::<Vec<_>>();
    dirs.sort_by(|left, right| left.name.cmp(&right.name));
    for directory in dirs {
        flatten(directory.compress(), depth + 1, collapsed, rows);
    }
    let mut files = node.files;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    for (_, index) in files {
        rows.push(DiffRowKind::File {
            index,
            depth: depth + 1,
        });
    }
}

pub fn visible_file_indices(files: &[DiffFile], collapsed: &HashSet<String>) -> Vec<usize> {
    diff_rows(files, collapsed)
        .into_iter()
        .filter_map(|row| match row {
            DiffRowKind::File { index, .. } => Some(index),
            DiffRowKind::Dir { .. } => None,
        })
        .collect()
}

pub fn parent_dir(path: &str) -> Option<String> {
    path.rsplit_once('/')
        .map(|(directory, _)| directory.to_string())
}

pub fn render(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(4)])
        .split(area);
    render_context(frame, app, chunks[0]);
    let body = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(40), Constraint::Min(40)])
        .split(chunks[1]);
    let files_block = ratatui::widgets::Block::default()
        .borders(ratatui::widgets::Borders::ALL)
        .border_style(Style::default().fg(theme.muted))
        .title(Span::styled(
            format!(" FILES {} ", app.diff.files.len()),
            Style::default().fg(theme.dim).add_modifier(Modifier::BOLD),
        ))
        .style(Style::default().bg(theme.panel));
    let files_inner = files_block.inner(body[0]);
    frame.render_widget(files_block, body[0]);
    let diff_title = app
        .diff
        .path
        .as_deref()
        .map(|path| format!(" DIFF · {path} "))
        .unwrap_or_else(|| " DIFF ".to_string());
    let diff_block = ratatui::widgets::Block::default()
        .borders(ratatui::widgets::Borders::ALL)
        .border_style(Style::default().fg(theme.muted))
        .title(Span::styled(
            truncate(&diff_title, body[1].width.saturating_sub(2) as usize),
            Style::default().fg(theme.dim).add_modifier(Modifier::BOLD),
        ))
        .style(Style::default().bg(theme.canvas));
    let diff_inner = diff_block.inner(body[1]);
    frame.render_widget(diff_block, body[1]);

    let rows = diff_rows(&app.diff.files, &app.diff.collapsed_dirs);
    let mut lines = Vec::new();
    if app.diff.files.is_empty() {
        lines.push(Line::from(Span::styled(
            "No changes against the target branch.",
            Style::default().fg(theme.dim),
        )));
    }
    for row in &rows {
        match row {
            DiffRowKind::Dir {
                name,
                files,
                depth,
                expanded,
                ..
            } => {
                lines.push(Line::from(vec![
                    Span::styled("  ".repeat(*depth), Style::default()),
                    Span::styled(
                        if *expanded { "▼ " } else { "▶ " },
                        Style::default().fg(theme.warning),
                    ),
                    Span::styled(
                        format!("{name}/"),
                        Style::default()
                            .fg(theme.muted)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(format!("  {files}"), Style::default().fg(theme.dim)),
                ]));
            }
            DiffRowKind::File { index, depth } => {
                let Some(file) = app.diff.files.get(*index) else {
                    continue;
                };
                let selected = *index == app.diff.selected;
                let reviewed = app.diff.reviewed.contains(&file.path);
                let name = file.path.rsplit('/').next().unwrap_or(&file.path);
                lines.push(Line::from(vec![
                    Span::styled("  ".repeat(*depth), Style::default()),
                    Span::styled(
                        format!("{} ", file.status.glyph()),
                        Style::default().fg(file_color(file.status, theme)),
                    ),
                    Span::styled(
                        truncate(name, 26),
                        Style::default()
                            .fg(if selected { theme.text } else { theme.muted })
                            .bg(if selected {
                                theme.selected
                            } else {
                                theme.canvas
                            }),
                    ),
                    Span::styled(
                        if reviewed { " ✓" } else { "" },
                        Style::default().fg(theme.success),
                    ),
                ]));
            }
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "Space reviewed · n/p file · h/l fold",
        Style::default().fg(theme.dim),
    )));
    let height = files_inner.height as usize;
    let selected_row = rows.iter().position(
        |row| matches!(row, DiffRowKind::File { index, .. } if *index == app.diff.selected),
    );
    let offset = selected_row
        .map(|row| row.saturating_sub(height.saturating_sub(1)))
        .unwrap_or(0);
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().bg(theme.panel))
            .scroll((offset as u16, 0)),
        files_inner,
    );

    if let Some(parsed) = app.diff.parsed.as_ref() {
        let highlighter = diff_view::shared_highlighter();
        let path = app.diff.path.clone().unwrap_or_default();
        let reviewed = app.diff.reviewed.contains(&path);
        diff_view::render(
            frame,
            diff_inner,
            DiffView {
                parsed,
                path: &path,
                reviewed,
                selected: None,
                theme,
                highlighter,
            },
            app.diff.scroll,
        );
    } else if app.diff.files.is_empty() {
        frame.render_widget(
            Paragraph::new("No diff to show.").style(Style::default().fg(theme.dim)),
            diff_inner,
        );
    } else {
        frame.render_widget(
            Paragraph::new("Loading diff…").style(Style::default().fg(theme.dim)),
            diff_inner,
        );
    }
}

fn render_context(frame: &mut Frame, app: &App, area: Rect) {
    let theme = app.theme;
    let context = app.diff.context.as_ref();
    let branch = context
        .map(|context| context.branch.clone())
        .or_else(|| {
            app.detail
                .as_ref()
                .and_then(|detail| detail.card.environment.as_ref())
                .map(|environment| environment.branch.clone())
        })
        .unwrap_or_else(|| "detached".into());
    let mut spans = vec![
        Span::styled(
            format!(" {branch} "),
            Style::default()
                .fg(theme.accent)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(" worktree ", Style::default().fg(theme.dim)),
    ];
    if let Some(context) = context {
        if context.ahead > 0 || context.behind > 0 {
            spans.push(Span::styled(
                format!("↑{} ↓{}  ", context.ahead, context.behind),
                Style::default().fg(theme.info),
            ));
        }
        spans.push(Span::styled(
            format!("target {}  ", context.target),
            Style::default().fg(theme.muted),
        ));
        spans.push(Span::styled(
            if context.conflicts {
                "◆ conflicts  "
            } else if context.dirty {
                "● dirty  "
            } else {
                "✓ clean  "
            },
            Style::default().fg(if context.conflicts {
                theme.danger
            } else if context.dirty {
                theme.warning
            } else {
                theme.success
            }),
        ));
        if let Some(head) = &context.head {
            spans.push(Span::styled(
                truncate(head, area.width.saturating_sub(60) as usize),
                Style::default().fg(theme.dim),
            ));
        }
    }
    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(theme.panel)),
        area,
    );
}

fn file_color(status: DiffFileStatus, theme: crate::theme::Theme) -> ratatui::style::Color {
    match status {
        DiffFileStatus::Deleted => theme.danger,
        DiffFileStatus::Added | DiffFileStatus::Untracked => theme.success,
        _ => theme.warning,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str) -> DiffFile {
        DiffFile {
            path: path.into(),
            status: DiffFileStatus::Modified,
        }
    }

    #[test]
    fn tree_compresses_single_child_directories_and_folds() {
        let files = vec![
            file("crates/stacks-tui/src/app.rs"),
            file("crates/stacks-tui/src/main.rs"),
            file("Cargo.toml"),
        ];
        let rows = diff_rows(&files, &HashSet::new());
        let dirs = rows
            .iter()
            .filter_map(|row| match row {
                DiffRowKind::Dir { name, .. } => Some(name.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(dirs.contains(&"crates/stacks-tui/src"), "{dirs:?}");
        let mut collapsed = HashSet::new();
        collapsed.insert("crates/stacks-tui/src".to_string());
        let folded = visible_file_indices(&files, &collapsed);
        assert_eq!(folded, vec![2], "root file remains visible: {folded:?}");
        assert_eq!(
            parent_dir("crates/stacks-tui/src/app.rs"),
            Some("crates/stacks-tui/src".into())
        );
    }
}
