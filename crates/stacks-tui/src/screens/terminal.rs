//! Terminal panes: PTY + `vt100` screen + split layout + copy mode.
//!
//! One implementation serves card terminals and the global terminal overlay.

use std::{collections::HashMap, sync::Arc};

use ratatui::{
    Frame,
    layout::{Position, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
};
use serde::{Deserialize, Serialize};
use stacks_core::{
    pi::NativeLaunch,
    pty::{PtyEvent, PtySession, PtySink},
    terminal::{TermColor, TerminalScreen, Vt100Screen},
};

use crate::{split_tree::SplitDirection, split_tree::SplitNode, widgets::osc52};

pub struct Pane {
    pub id: String,
    pub cwd: String,
    pub command: Option<String>,
    pub managed: bool,
    pub agent: bool,
    pub session: Option<PtySession>,
    pub screen: Box<dyn TerminalScreen>,
    pub generation: Option<String>,
    pub exited: Option<Option<i32>>,
    pub copy: Option<CopyMode>,
}

pub struct CopyMode {
    pub lines: Vec<String>,
    pub row: usize,
    pub col: usize,
    pub start: Option<(usize, usize)>,
}

impl CopyMode {
    pub fn new(screen: &dyn TerminalScreen) -> Self {
        let mut lines: Vec<String> = screen.contents().split('\n').map(str::to_string).collect();
        if lines.is_empty() {
            lines.push(String::new());
        }
        let row = lines.len().saturating_sub(1);
        Self {
            lines,
            row,
            col: 0,
            start: None,
        }
    }

    pub fn selection_text(&self) -> String {
        let Some((start_row, start_col)) = self.start else {
            return self.current_line();
        };
        let end = (self.row, self.col);
        let (start, end) = if (start_row, start_col) <= end {
            ((start_row, start_col), end)
        } else {
            (end, (start_row, start_col))
        };
        if start.0 == end.0 {
            return slice_line(&self.lines[start.0], start.1, end.1);
        }
        let mut output = Vec::new();
        output.push(slice_line(&self.lines[start.0], start.1, usize::MAX));
        for index in start.0 + 1..end.0 {
            output.push(self.lines[index].clone());
        }
        output.push(slice_line(&self.lines[end.0], 0, end.1));
        output.join("\n")
    }

    fn current_line(&self) -> String {
        self.lines
            .get(self.row)
            .map(|line| line.trim_end().to_string())
            .unwrap_or_default()
    }
}

fn slice_line(line: &str, start: usize, end: usize) -> String {
    line.chars()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect()
}

impl Pane {
    fn new(
        id: String,
        cwd: String,
        command: Option<String>,
        managed: bool,
        agent: bool,
        cols: u16,
        rows: u16,
        scrollback: usize,
    ) -> Self {
        Self {
            id,
            cwd,
            command,
            managed,
            agent,
            session: None,
            screen: Box::new(Vt100Screen::new(cols, rows, scrollback)),
            generation: None,
            exited: None,
            copy: None,
        }
    }

    pub fn alive(&self) -> bool {
        self.exited.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedPane {
    pub id: String,
    pub cwd: String,
    pub command: Option<String>,
    pub managed: bool,
    #[serde(default)]
    pub agent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedWorkspace {
    pub tree: SplitNode,
    pub focused: String,
    pub maximized: bool,
    pub panes: Vec<SavedPane>,
}

pub struct TerminalWorkspace {
    pub tree: SplitNode,
    pub focused: String,
    pub panes: HashMap<String, Pane>,
    pub cols: u16,
    pub rows: u16,
    pub owner: String,
    pub maximized: bool,
    pub scrollback: usize,
}

impl TerminalWorkspace {
    pub fn new(owner: impl Into<String>) -> Self {
        Self {
            tree: SplitNode::leaf(""),
            focused: String::new(),
            panes: HashMap::new(),
            cols: 80,
            rows: 24,
            owner: owner.into(),
            maximized: false,
            scrollback: 10_000,
        }
    }

    pub fn snapshot(&self) -> Option<SavedWorkspace> {
        if self.panes.is_empty() {
            return None;
        }
        let mut panes = self
            .panes
            .values()
            .map(|pane| SavedPane {
                id: pane.id.clone(),
                cwd: pane.cwd.clone(),
                command: pane.command.clone(),
                managed: pane.managed,
                agent: pane.agent,
            })
            .collect::<Vec<_>>();
        panes.sort_by(|left, right| left.id.cmp(&right.id));
        Some(SavedWorkspace {
            tree: self.tree.clone(),
            focused: self.focused.clone(),
            maximized: self.maximized,
            panes,
        })
    }

    pub fn restore(
        &mut self,
        saved: SavedWorkspace,
        cols: u16,
        rows: u16,
        sink: PtySink,
        agent_launch: Option<&NativeLaunch>,
    ) -> Result<(), String> {
        self.close_all();
        for pane in saved.panes {
            let mut next = Pane::new(
                pane.id.clone(),
                pane.cwd.clone(),
                pane.command.clone(),
                pane.managed,
                pane.agent,
                cols,
                rows,
                self.scrollback,
            );
            let session = if pane.agent {
                let launch = agent_launch.ok_or_else(|| {
                    "The Agent launch is unavailable while restoring this layout".to_string()
                })?;
                PtySession::spawn_program(
                    pane.id.clone(),
                    &launch.program,
                    &launch.args,
                    &pane.cwd,
                    cols,
                    rows,
                    &launch.env,
                    sink.clone(),
                )?
            } else {
                PtySession::spawn_with_env(
                    pane.id.clone(),
                    &pane.cwd,
                    pane.command.as_deref(),
                    pane.managed,
                    cols,
                    rows,
                    &[],
                    sink.clone(),
                )?
            };
            next.generation = Some(session.generation.clone());
            next.session = Some(session);
            self.panes.insert(pane.id, next);
        }
        self.tree = saved.tree;
        self.focused = saved.focused;
        if !self.panes.contains_key(&self.focused) {
            if let Some(first) = self.panes.keys().next() {
                self.focused = first.clone();
            }
        }
        self.maximized = saved.maximized;
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.panes.is_empty()
    }

    pub fn focused_pane(&self) -> Option<&Pane> {
        self.panes.get(&self.focused)
    }

    pub fn focused_pane_mut(&mut self) -> Option<&mut Pane> {
        self.panes.get_mut(&self.focused)
    }

    /// Spawn the first pane, or a new pane after a split.
    pub fn open_pane(
        &mut self,
        cwd: &str,
        command: Option<&str>,
        cols: u16,
        rows: u16,
        env: &[(&str, &str)],
        sink: PtySink,
    ) -> Result<String, String> {
        self.open_pane_mode(cwd, command, false, cols, rows, env, sink)
    }

    /// Start a configured project service: the command owns the PTY and exits
    /// when it finishes instead of returning to an interactive shell.
    pub fn open_managed(
        &mut self,
        cwd: &str,
        command: &str,
        cols: u16,
        rows: u16,
        env: &[(&str, &str)],
        sink: PtySink,
    ) -> Result<String, String> {
        self.open_pane_mode(cwd, Some(command), true, cols, rows, env, sink)
    }

    fn open_pane_mode(
        &mut self,
        cwd: &str,
        command: Option<&str>,
        managed_service: bool,
        cols: u16,
        rows: u16,
        env: &[(&str, &str)],
        sink: PtySink,
    ) -> Result<String, String> {
        let id = format!("pane-{}", uuid::Uuid::new_v4());
        let mut pane = Pane::new(
            id.clone(),
            cwd.to_string(),
            command.map(str::to_string),
            managed_service,
            false,
            cols,
            rows,
            self.scrollback,
        );
        let session = PtySession::spawn_with_env(
            id.clone(),
            cwd,
            command,
            managed_service,
            cols,
            rows,
            env,
            sink,
        )?;
        pane.generation = Some(session.generation.clone());
        pane.session = Some(session);
        self.panes.insert(id.clone(), pane);
        if self.panes.len() == 1 {
            self.tree = SplitNode::leaf(id.clone());
            self.focused = id.clone();
        }
        Ok(id)
    }

    /// Spawn a native program (Pi) in its own pane.
    pub fn open_program(
        &mut self,
        cwd: &str,
        launch: &NativeLaunch,
        cols: u16,
        rows: u16,
        sink: PtySink,
    ) -> Result<String, String> {
        let id = format!("pane-{}", uuid::Uuid::new_v4());
        let mut pane = Pane::new(
            id.clone(),
            cwd.to_string(),
            None,
            false,
            true,
            cols,
            rows,
            self.scrollback,
        );
        let session = PtySession::spawn_program(
            id.clone(),
            &launch.program,
            &launch.args,
            cwd,
            cols,
            rows,
            &launch.env,
            sink,
        )?;
        pane.generation = Some(session.generation.clone());
        pane.session = Some(session);
        self.panes.insert(id.clone(), pane);
        if self.panes.len() == 1 {
            self.tree = SplitNode::leaf(id.clone());
            self.focused = id.clone();
        }
        Ok(id)
    }

    pub fn split(
        &mut self,
        direction: SplitDirection,
        cols: u16,
        rows: u16,
        env: &[(&str, &str)],
        sink: PtySink,
    ) -> Result<(), String> {
        let Some(pane) = self.panes.get(&self.focused) else {
            return Err("No terminal pane to split".to_string());
        };
        let cwd = pane.cwd.clone();
        let command = pane.command.clone();
        let id = self.open_pane(&cwd, command.as_deref(), cols, rows, env, sink)?;
        self.tree = self.tree.split(&self.focused, id.clone(), direction);
        self.focused = id;
        Ok(())
    }

    pub fn close_focused(&mut self) {
        let id = self.focused.clone();
        self.panes.remove(&id);
        let Some(tree) = self.tree.close(&id) else {
            self.tree = SplitNode::leaf("");
            self.focused.clear();
            return;
        };
        self.tree = tree;
        let next = self.tree.leaves().first().cloned().unwrap_or_default();
        self.focused = if self.tree.contains(&self.focused) {
            self.focused.clone()
        } else {
            next
        };
    }

    pub fn cycle(&mut self, forward: bool) {
        self.focused = self.tree.next_pane(&self.focused, forward);
    }

    pub fn feed(&mut self, pane: &str, generation: &str, data: &[u8]) {
        if let Some(pane) = self.panes.get_mut(pane) {
            if pane.generation.as_deref() == Some(generation) {
                pane.screen.process(data);
                if pane.copy.is_some() {
                    // Copy mode froze the visible text; leave it stable.
                }
            }
        }
    }

    pub fn exited(&mut self, pane: &str, generation: &str, status: Option<i32>) {
        if let Some(pane) = self.panes.get_mut(pane) {
            if pane.generation.as_deref() == Some(generation) {
                pane.exited = Some(status);
            }
        }
    }

    pub fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        let Some(pane) = self.panes.get_mut(&self.focused) else {
            return Err("No focused terminal pane".to_string());
        };
        match pane.session.as_mut() {
            Some(session) => session.write(bytes),
            None => Err("Terminal is not running".to_string()),
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols.max(2);
        self.rows = rows.max(1);
        let leaves = self.tree.leaves();
        let count = leaves.len().max(1) as u16;
        let per_cols = (self.cols / count).max(2);
        let per_rows = (self.rows / count).max(1);
        for pane in self.panes.values_mut() {
            let (cols, rows) = if self.maximized && pane.id == self.focused {
                (self.cols, self.rows)
            } else {
                (per_cols, per_rows)
            };
            pane.screen.resize(cols, rows);
            if let Some(session) = pane.session.as_mut() {
                let _ = session.resize(cols, rows);
            }
        }
    }

    pub fn scroll_focused(&mut self, delta: i32) {
        if let Some(pane) = self.panes.get_mut(&self.focused) {
            let len = pane.screen.scrollback_len();
            let next = if delta > 0 {
                (pane.screen.scroll_offset() + delta as usize).min(len)
            } else {
                pane.screen
                    .scroll_offset()
                    .saturating_sub((-delta) as usize)
            };
            pane.screen.scroll(next);
        }
    }

    pub fn active_copy(&self) -> Option<&CopyMode> {
        self.focused_pane().and_then(|pane| pane.copy.as_ref())
    }

    pub fn start_copy(&mut self) {
        if let Some(pane) = self.panes.get_mut(&self.focused) {
            if pane.copy.is_none() {
                pane.copy = Some(CopyMode::new(pane.screen.as_ref()));
            }
        }
    }

    pub fn stop_copy(&mut self) {
        if let Some(pane) = self.panes.get_mut(&self.focused) {
            pane.copy = None;
        }
    }

    pub fn copy_input(&mut self, key: crate::keys::Key) -> Option<(String, bool)> {
        let pane = self.panes.get_mut(&self.focused)?;
        let copy = pane.copy.as_mut()?;
        let line_count = copy.lines.len();
        let mut yanked = None;
        let mut exit = false;
        match key {
            crate::keys::Key::Char('h') | crate::keys::Key::Left => {
                copy.col = copy.col.saturating_sub(1)
            }
            crate::keys::Key::Char('l') | crate::keys::Key::Right => {
                let max = copy.lines[copy.row].chars().count().saturating_sub(1);
                copy.col = (copy.col + 1).min(max);
            }
            crate::keys::Key::Char('j') | crate::keys::Key::Down => {
                copy.row = (copy.row + 1).min(line_count.saturating_sub(1));
                copy.col = copy
                    .col
                    .min(copy.lines[copy.row].chars().count().saturating_sub(1));
            }
            crate::keys::Key::Char('k') | crate::keys::Key::Up => {
                copy.row = copy.row.saturating_sub(1);
                copy.col = copy
                    .col
                    .min(copy.lines[copy.row].chars().count().saturating_sub(1));
            }
            crate::keys::Key::Char('0') | crate::keys::Key::Home => copy.col = 0,
            crate::keys::Key::Char('$') | crate::keys::Key::End => {
                copy.col = copy.lines[copy.row].chars().count().saturating_sub(1)
            }
            crate::keys::Key::Char('g') => copy.row = 0,
            crate::keys::Key::Char('G') => copy.row = line_count.saturating_sub(1),
            crate::keys::Key::Char('v') => copy.start = Some((copy.row, copy.col)),
            crate::keys::Key::Char('y') | crate::keys::Key::Enter => {
                yanked = Some((copy.selection_text(), true));
                exit = true;
            }
            crate::keys::Key::Esc | crate::keys::Key::Char('q') => {
                exit = true;
            }
            _ => {}
        }
        if exit {
            pane.copy = None;
        }
        yanked
    }

    pub fn render(
        &mut self,
        frame: &mut Frame,
        area: Rect,
        focused: bool,
        depth: crate::theme::ColorDepth,
    ) {
        let theme = crate::theme::theme(depth, None);
        if self.panes.is_empty() {
            frame.render_widget(
                Paragraph::new("No terminal. Ctrl-W then | to start one.")
                    .style(Style::default().fg(theme.dim)),
                area,
            );
            return;
        }
        if self.maximized {
            let inner = Rect {
                width: area.width.saturating_sub(2).max(2),
                height: area.height.saturating_sub(2).max(1),
                x: area.x + 1,
                y: area.y + 1,
            };
            if let Some(pane) = self.panes.get_mut(&self.focused) {
                pane.screen.resize(inner.width, inner.height);
                if let Some(session) = pane.session.as_mut() {
                    let _ = session.resize(inner.width, inner.height);
                }
            }
            if let Some(pane) = self.panes.get(&self.focused) {
                render_pane(frame, area, pane, focused, depth, theme);
            }
            return;
        }
        let mut layouts = Vec::new();
        layout_tree(&self.tree, area, &mut layouts);
        // The PTY must match the exact pane content rectangle, not an even
        // division, or xterm/PTY width disagreement causes wrapping/gaps.
        for (pane_id, pane_area) in &layouts {
            let cols = pane_area.width.saturating_sub(2).max(2);
            let rows = pane_area.height.saturating_sub(2).max(1);
            if let Some(pane) = self.panes.get_mut(pane_id) {
                pane.screen.resize(cols, rows);
                if let Some(session) = pane.session.as_mut() {
                    let _ = session.resize(cols, rows);
                }
            }
        }
        for (pane_id, pane_area) in layouts {
            let Some(pane) = self.panes.get(&pane_id) else {
                continue;
            };
            let is_focused = focused && pane_id == self.focused;
            render_pane(frame, pane_area, pane, is_focused, depth, theme);
        }
    }
}

pub fn render_service(
    frame: &mut Frame,
    app: &mut crate::app::App,
    area: Rect,
    tab: crate::app::DetailTab,
) {
    let theme = app.theme;
    let depth = app.depth;
    let focused = app.terminal_focus;
    let workspace = match tab {
        crate::app::DetailTab::Server => &mut app.server,
        crate::app::DetailTab::Console => &mut app.console,
        _ => return,
    };
    if workspace.is_empty() {
        frame.render_widget(
            Paragraph::new(format!(
                "{} is not running. Configure it in the project settings.",
                tab.label()
            ))
            .style(Style::default().fg(theme.muted).bg(theme.canvas)),
            area,
        );
        return;
    }
    workspace.resize(area.width, area.height);
    workspace.render(frame, area, focused, depth);
}

pub fn render_card(frame: &mut Frame, app: &mut crate::app::App, area: Rect) {
    let depth = app.depth;
    let focused = app.terminal_focus;
    app.terminals.resize(area.width, area.height);
    app.terminals.render(frame, area, focused, depth);
}

fn layout_tree(node: &SplitNode, area: Rect, output: &mut Vec<(String, Rect)>) {
    match node {
        SplitNode::Leaf { pane_id } => output.push((pane_id.clone(), area)),
        SplitNode::Split {
            direction,
            ratio,
            first,
            second,
            ..
        } => {
            let gap = 1;
            match direction {
                SplitDirection::Row => {
                    let available = area.width.saturating_sub(gap);
                    let first_width = ((available as f32) * ratio).round() as u16;
                    let first_width = first_width.clamp(3, available.saturating_sub(3).max(3));
                    let second_width = available.saturating_sub(first_width);
                    let first_area = Rect {
                        width: first_width,
                        ..area
                    };
                    let second_area = Rect {
                        x: area.x + first_width + gap,
                        width: second_width,
                        ..area
                    };
                    layout_tree(first, first_area, output);
                    layout_tree(second, second_area, output);
                }
                SplitDirection::Column => {
                    let available = area.height.saturating_sub(gap);
                    let first_height = ((available as f32) * ratio).round() as u16;
                    let first_height = first_height.clamp(3, available.saturating_sub(3).max(3));
                    let second_height = available.saturating_sub(first_height);
                    let first_area = Rect {
                        height: first_height,
                        ..area
                    };
                    let second_area = Rect {
                        y: area.y + first_height + gap,
                        height: second_height,
                        ..area
                    };
                    layout_tree(first, first_area, output);
                    layout_tree(second, second_area, output);
                }
            }
        }
    }
}

fn render_pane(
    frame: &mut Frame,
    area: Rect,
    pane: &Pane,
    focused: bool,
    depth: crate::theme::ColorDepth,
    theme: crate::theme::Theme,
) {
    if area.width < 3 || area.height < 2 {
        return;
    }
    let title = if pane.copy.is_some() {
        format!(" {}  COPY ", pane.id.chars().take(8).collect::<String>())
    } else if let Some(status) = pane.exited {
        format!(
            " {}  exited {} ",
            pane.id.chars().take(8).collect::<String>(),
            status.map(|code| code.to_string()).unwrap_or_default()
        )
    } else {
        format!(" {} ", pane.cwd.rsplit('/').next().unwrap_or(&pane.cwd))
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(if focused { theme.accent } else { theme.muted }))
        .style(Style::default().bg(theme.canvas))
        .title(Span::styled(
            crate::widgets::truncate(&title, area.width.saturating_sub(2) as usize),
            Style::default().fg(if focused { theme.accent } else { theme.dim }),
        ));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.width == 0 || inner.height == 0 {
        return;
    }
    let (screen_cols, screen_rows) = pane.screen.size();
    let rows = inner.height.min(screen_rows);
    let cols = inner.width.min(screen_cols);
    let mut lines = Vec::new();
    for row in 0..rows {
        let mut spans = Vec::new();
        let mut current = String::new();
        let mut style = Style::default();
        for col in 0..cols {
            let Some(cell) = pane.screen.cell(row, col) else {
                break;
            };
            if cell.wide_continuation {
                continue;
            }
            let mut cell_style = Style::default()
                .fg(terminal_color(depth, cell.fg, theme.text))
                .bg(terminal_color(depth, cell.bg, theme.canvas));
            if cell.bold {
                cell_style = cell_style.add_modifier(Modifier::BOLD);
            }
            if cell.italic {
                cell_style = cell_style.add_modifier(Modifier::ITALIC);
            }
            if cell.underline {
                cell_style = cell_style.add_modifier(Modifier::UNDERLINED);
            }
            if cell.inverse {
                cell_style = cell_style.add_modifier(Modifier::REVERSED);
            }
            if current.is_empty() {
                style = cell_style;
            } else if cell_style != style {
                spans.push(Span::styled(std::mem::take(&mut current), style));
                style = cell_style;
            }
            let text = if cell.text.is_empty() {
                " ".to_string()
            } else {
                cell.text
            };
            current.push_str(&text);
        }
        if !current.is_empty() {
            spans.push(Span::styled(current, style));
        }
        lines.push(Line::from(spans));
    }
    frame.render_widget(
        Paragraph::new(lines).style(Style::default().bg(theme.canvas)),
        inner,
    );
    if focused && pane.copy.is_none() {
        if let Some((row, col)) = pane.screen.cursor() {
            if row < inner.height && col < inner.width {
                frame.set_cursor_position(Position {
                    x: inner.x + col,
                    y: inner.y + row,
                });
            }
        }
    }
    if let Some(copy) = pane.copy.as_ref() {
        // A one-line copy-mode status inside the frame bottom.
        let line = format!(
            " COPY  {}:{}  v select · y yank · Esc exit ",
            copy.row + 1,
            copy.col + 1
        );
        if inner.height > 0 {
            let last = Rect {
                y: inner.y + inner.height - 1,
                height: 1,
                ..inner
            };
            frame.render_widget(
                Paragraph::new(crate::widgets::truncate(&line, inner.width as usize))
                    .style(Style::default().fg(theme.canvas).bg(theme.warning)),
                last,
            );
        }
    }
}

fn terminal_color(
    depth: crate::theme::ColorDepth,
    color: TermColor,
    fallback: ratatui::style::Color,
) -> ratatui::style::Color {
    crate::theme::terminal_color(depth, color, fallback)
}

#[allow(dead_code)]
fn yank_to_clipboard(text: &str) {
    print!("{}", osc52(text));
    use std::io::Write;
    let _ = std::io::stdout().flush();
}

#[allow(dead_code)]
fn shared_sink(sender: crate::event::EventSender, pane: String) -> PtySink {
    Arc::new(move |event: PtyEvent| {
        sender.send(crate::event::CoreEvent::Pty {
            pane: pane.clone(),
            event,
        });
    })
}
