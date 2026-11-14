#![cfg_attr(test, allow(dead_code, unused_mut))]

//! Native Pi agent surface for card and project workspaces.
//!
//! One persistent Pi RPC process per pane with transcript hydration, streaming
//! assistant text, tool cards, composer send/abort and model selection.
//! Extension UI, attachments and slash-command parity remain follow-up work.

use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};

use gpui::{
    Animation, AnimationExt, Context, Entity, Focusable, Hsla, IntoElement, ParentElement, Render,
    ScrollDelta, ScrollEvent, ScrollHandle, SharedString, Styled, Subscription, Window, div,
    prelude::*, px, relative, rgb,
};
use gpui_kit::component::{
    input::{InputEvent, Textarea, TextareaState},
    text::TextView,
};
use serde_json::{Value, json};

use crate::theme;

const MAX_TRANSCRIPT_MESSAGES: usize = 400;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentLifecycle {
    Started,
    Settled,
    Failed,
}

#[derive(Clone, Debug)]
pub struct AgentConfig {
    pub owner_id: String,
    pub cwd: String,
    pub project_path: String,
    pub project_id: String,
    pub session_dir: PathBuf,
    pub extension: Option<PathBuf>,
    pub trusted: bool,
    pub accent: Hsla,
    pub lifecycle: Option<async_channel::Sender<AgentLifecycle>>,
}

#[derive(Clone, Debug)]
struct AgentModel {
    id: String,
    name: String,
    provider: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ToolStatus {
    Running,
    Complete,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SendMode {
    Prompt,
    Steer,
    FollowUp,
}

#[derive(Clone, Debug)]
struct AgentTool {
    id: String,
    name: String,
    args: Value,
    label: String,
    body: String,
    status: ToolStatus,
}

#[derive(Clone, Debug)]
struct AgentMessage {
    role: String,
    text: String,
    tool: Option<AgentTool>,
}

struct AgentProcess {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Child,
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct AgentView {
    config: AgentConfig,
    accent: Hsla,
    process: Option<AgentProcess>,
    messages: Vec<AgentMessage>,
    expanded_tools: HashSet<String>,
    streaming: String,
    composer: String,
    composer_input: Option<Entity<TextareaState>>,
    composer_subscription: Option<Subscription>,
    clear_composer: bool,
    queued_steering: Vec<String>,
    queued_follow_ups: Vec<String>,
    status: String,
    model: String,
    thinking_level: String,
    context_tokens: Option<u64>,
    context_window: Option<u64>,
    context_percent: Option<f32>,
    error: Option<String>,
    models: Vec<AgentModel>,
    model_picker_open: bool,
    model_scroll: ScrollHandle,
    thinking_levels: Vec<String>,
    thinking_picker_open: bool,
    thinking_scroll: ScrollHandle,
    request_sequence: u64,
    scroll: ScrollHandle,
}

impl AgentView {
    pub fn new(cx: &mut Context<Self>, config: AgentConfig) -> Self {
        let _ = &cx;
        let mut view = Self {
            accent: config.accent,
            config,
            process: None,
            messages: Vec::new(),
            expanded_tools: HashSet::new(),
            streaming: String::new(),
            composer: String::new(),
            composer_input: None,
            composer_subscription: None,
            clear_composer: false,
            queued_steering: Vec::new(),
            queued_follow_ups: Vec::new(),
            status: "Starting Pi…".into(),
            model: String::new(),
            thinking_level: String::new(),
            context_tokens: None,
            context_window: None,
            context_percent: None,
            error: None,
            models: Vec::new(),
            model_picker_open: false,
            model_scroll: ScrollHandle::new(),
            thinking_levels: Vec::new(),
            thinking_picker_open: false,
            thinking_scroll: ScrollHandle::new(),
            request_sequence: 0,
            scroll: ScrollHandle::new(),
        };
        #[cfg(not(test))]
        view.start(cx);
        view
    }

    fn start(&mut self, cx: &mut Context<Self>) {
        let Some(pi) = find_pi() else {
            self.status = "Pi not found".into();
            self.error = Some("Pi CLI not found. Install `pi` or set PI_PATH.".into());
            return;
        };
        if let Err(error) = std::fs::create_dir_all(&self.config.session_dir) {
            self.status = "Pi startup failed".into();
            self.error = Some(format!("Could not create Pi session directory: {error}"));
            return;
        }
        let extension = self.config.extension.as_ref().filter(|path| path.is_file());
        let mut command = Command::new(pi);
        command
            .current_dir(&self.config.cwd)
            .arg("--mode")
            .arg("rpc")
            .arg(if self.config.trusted {
                "--approve"
            } else {
                "--no-approve"
            })
            .arg("--no-extensions");
        if let Some(extension) = extension {
            command.arg("--extension").arg(extension);
        }
        command
            .arg("--session-dir")
            .arg(&self.config.session_dir)
            .arg("--continue")
            .arg("--name")
            .arg("Stacks Pi GUI")
            .env("STACKS_PROJECT_ID", &self.config.project_id)
            .env("STACKS_PROJECT_NAME", &self.config.project_path)
            .env("STACKS_PI_OWNER", &self.config.owner_id)
            .env("STACKS_GPUI", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.status = "Pi startup failed".into();
                self.error = Some(format!("Could not start Pi: {error}"));
                return;
            }
        };
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            let _ = child.kill();
            self.status = "Pi startup failed".into();
            self.error = Some("Could not open Pi process streams".into());
            return;
        };
        let stdin = Arc::new(Mutex::new(stdin));
        self.process = Some(AgentProcess {
            stdin: stdin.clone(),
            child,
        });
        self.status = "Starting Pi…".into();

        let (sender, receiver) = async_channel::unbounded::<Value>();
        std::thread::Builder::new()
            .name("stacks-gpui-pi-reader".into())
            .spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().map_while(Result::ok) {
                    if let Ok(event) = serde_json::from_str::<Value>(&line) {
                        if sender.send_blocking(event).is_err() {
                            break;
                        }
                    }
                }
            })
            .ok();
        std::thread::Builder::new()
            .name("stacks-gpui-pi-stderr".into())
            .spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    eprintln!("pi: {line}");
                }
            })
            .ok();

        cx.spawn(async move |this, cx| {
            while let Ok(event) = receiver.recv().await {
                if this
                    .update(cx, |view, cx| view.on_event(event, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();

        let messages_id = self.next_id();
        self.send_command(json!({"type": "get_messages", "id": messages_id}), cx);
        let state_id = self.next_id();
        self.send_command(json!({"type": "get_state", "id": state_id}), cx);
        let models_id = self.next_id();
        self.send_command(json!({"type": "get_available_models", "id": models_id}), cx);
        let stats_id = self.next_id();
        self.send_command(json!({"type": "get_session_stats", "id": stats_id}), cx);
        let thinking_id = self.next_id();
        self.send_command(
            json!({"type": "get_available_thinking_levels", "id": thinking_id}),
            cx,
        );
        cx.notify();
    }

    fn next_id(&mut self) -> String {
        self.request_sequence += 1;
        format!("stacks-gpui-pi-{}", self.request_sequence)
    }

    fn send_command(&mut self, command: Value, cx: &mut Context<Self>) {
        let Some(process) = self.process.as_mut() else {
            return;
        };
        let Ok(mut stdin) = process.stdin.lock() else {
            self.error = Some("Pi stdin lock poisoned".into());
            return;
        };
        if let Err(error) = writeln!(stdin, "{command}") {
            self.error = Some(format!("Could not write to Pi: {error}"));
            cx.notify();
        }
    }

    fn notify_lifecycle(&self, lifecycle: AgentLifecycle) {
        if let Some(sender) = self.config.lifecycle.as_ref() {
            let _ = sender.try_send(lifecycle);
        }
    }

    fn on_event(&mut self, event: Value, cx: &mut Context<Self>) {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "response" => {
                if let Some(data) = event.get("data") {
                    if let Some(messages) = data.get("messages").and_then(Value::as_array) {
                        self.messages = parse_messages(messages);
                        self.messages.truncate(MAX_TRANSCRIPT_MESSAGES);
                    }
                    if let Some(model) = data.get("model") {
                        self.model = model
                            .get("name")
                            .and_then(Value::as_str)
                            .or_else(|| model.get("id").and_then(Value::as_str))
                            .unwrap_or_default()
                            .to_string();
                    }
                    if let Some(level) = data.get("thinkingLevel").and_then(Value::as_str) {
                        self.thinking_level = level.to_string();
                    }
                    if let Some(models) = data.get("models").and_then(Value::as_array) {
                        self.models = models.iter().filter_map(parse_model).collect();
                    }
                    if let Some(levels) = data.get("levels").and_then(Value::as_array) {
                        self.thinking_levels = levels
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect();
                    }
                    if let Some(usage) = data.get("contextUsage") {
                        self.context_tokens = usage.get("tokens").and_then(Value::as_u64);
                        self.context_window = usage.get("contextWindow").and_then(Value::as_u64);
                        self.context_percent = usage
                            .get("percent")
                            .and_then(Value::as_f64)
                            .map(|value| value as f32);
                    }
                    if let Some(is_streaming) = data.get("isStreaming").and_then(Value::as_bool) {
                        self.status = if is_streaming {
                            "Running".into()
                        } else {
                            "Ready".into()
                        };
                    }
                }
                if event.get("success").and_then(Value::as_bool) == Some(false) {
                    self.error = event
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
            }
            "agent_start" => {
                self.status = "Running".into();
                self.error = None;
                self.notify_lifecycle(AgentLifecycle::Started);
            }
            "agent_end" | "agent_settled" => {
                self.status = "Ready".into();
                self.notify_lifecycle(AgentLifecycle::Settled);
                let stats_id = self.next_id();
                self.send_command(json!({"type": "get_session_stats", "id": stats_id}), cx);
            }
            "message_update" => {
                if let Some(update) = event.get("assistantMessageEvent")
                    && update.get("type").and_then(Value::as_str) == Some("text_delta")
                    && let Some(delta) = update.get("delta").and_then(Value::as_str)
                {
                    self.streaming.push_str(delta);
                }
            }
            "message_end" => {
                if let Some(message) = event
                    .get("message")
                    .and_then(|message| parse_message(message, 0, &HashMap::new()))
                    && message.role == "assistant"
                    && !message.text.trim().is_empty()
                {
                    self.messages.push(message);
                    self.messages.truncate(MAX_TRANSCRIPT_MESSAGES);
                    self.streaming.clear();
                }
            }
            "tool_execution_start" => {
                let id = event
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let name = event
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                let args = event.get("args").cloned().unwrap_or(Value::Null);
                self.upsert_tool(make_tool(id, name, &args, "", ToolStatus::Running));
                self.status = "Running".into();
            }
            "tool_execution_end" => {
                let id = event
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let output = event
                    .get("result")
                    .and_then(|result| result.get("content"))
                    .map(content_text)
                    .unwrap_or_default();
                let is_error = event
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.finish_tool(
                    id,
                    &output,
                    if is_error {
                        ToolStatus::Error
                    } else {
                        ToolStatus::Complete
                    },
                );
                self.status = "Running".into();
            }
            "queue_update" => {
                self.queued_steering = string_array(event.get("steering"));
                self.queued_follow_ups = string_array(event.get("followUp"));
            }
            "extension_ui_request" => {
                self.status = "Waiting for extension input".into();
            }
            "error" => {
                self.error = event
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| Some("Pi reported an error".into()));
                self.status = "Error".into();
                self.notify_lifecycle(AgentLifecycle::Failed);
            }
            _ => {}
        }
        self.scroll.scroll_to_bottom();
        cx.notify();
    }

    fn upsert_tool(&mut self, tool: AgentTool) {
        if let Some(message) = self
            .messages
            .iter_mut()
            .find(|message| message.tool.as_ref().is_some_and(|item| item.id == tool.id))
        {
            message.tool = Some(tool);
        } else {
            self.messages.push(AgentMessage {
                role: "tool".into(),
                text: String::new(),
                tool: Some(tool),
            });
            self.messages.truncate(MAX_TRANSCRIPT_MESSAGES);
        }
    }

    fn finish_tool(&mut self, id: &str, output: &str, status: ToolStatus) {
        let Some(tool) = self.messages.iter().find_map(|message| {
            message
                .tool
                .as_ref()
                .filter(|tool| tool.id == id)
                .map(|tool| (tool.name.clone(), tool.args.clone()))
        }) else {
            return;
        };
        self.upsert_tool(make_tool(id.to_string(), tool.0, &tool.1, output, status));
    }

    fn is_running(&self) -> bool {
        self.status == "Running" || self.status.starts_with("Running ")
    }

    pub fn composer_focused(&self, window: &Window, cx: &gpui::App) -> bool {
        self.composer_input
            .as_ref()
            .is_some_and(|input| input.read(cx).focus_handle(cx).is_focused(window))
    }

    pub fn is_ready(&self) -> bool {
        self.status == "Ready"
    }

    pub fn prompt(&mut self, text: String, cx: &mut Context<Self>) {
        if !text.trim().is_empty() {
            self.send_text(text, SendMode::Prompt, cx);
        }
    }

    fn send(&mut self, cx: &mut Context<Self>) {
        self.submit(SendMode::Prompt, cx);
    }

    fn submit(&mut self, mode: SendMode, cx: &mut Context<Self>) {
        let text = self.composer.trim().to_string();
        if text.is_empty() {
            return;
        }
        self.composer.clear();
        self.clear_composer = true;
        self.send_text(text, mode, cx);
    }

    fn send_text(&mut self, text: String, mode: SendMode, cx: &mut Context<Self>) {
        if mode == SendMode::Prompt {
            self.messages.push(AgentMessage {
                role: "user".into(),
                text: text.clone(),
                tool: None,
            });
        }
        if !self.is_running() {
            self.status = "Running".into();
        }
        self.error = None;
        let id = self.next_id();
        let command = match mode {
            SendMode::Prompt => "prompt",
            SendMode::Steer => "steer",
            SendMode::FollowUp => "follow_up",
        };
        self.send_command(json!({"type": command, "message": text, "id": id}), cx);
        self.scroll.scroll_to_bottom();
        cx.notify();
    }

    fn send_quick_response(&mut self, text: &str, cx: &mut Context<Self>) {
        if self.status != "Ready" {
            return;
        }
        self.send_text(text.to_string(), SendMode::Prompt, cx);
    }

    fn select_model(&mut self, model: AgentModel, cx: &mut Context<Self>) {
        let id = self.next_id();
        self.send_command(
            json!({
                "type": "set_model",
                "provider": model.provider,
                "modelId": model.id,
                "id": id,
            }),
            cx,
        );
        self.model = model.name;
        self.model_picker_open = false;
        self.thinking_picker_open = false;
        let state_id = self.next_id();
        self.send_command(json!({"type": "get_state", "id": state_id}), cx);
        let levels_id = self.next_id();
        self.send_command(
            json!({"type": "get_available_thinking_levels", "id": levels_id}),
            cx,
        );
        cx.notify();
    }

    fn select_thinking_level(&mut self, level: String, cx: &mut Context<Self>) {
        let id = self.next_id();
        self.send_command(
            json!({"type": "set_thinking_level", "level": level, "id": id}),
            cx,
        );
        self.thinking_level = level;
        self.thinking_picker_open = false;
        self.model_picker_open = false;
        let state_id = self.next_id();
        self.send_command(json!({"type": "get_state", "id": state_id}), cx);
        cx.notify();
    }

    fn abort(&mut self, cx: &mut Context<Self>) {
        let clear_id = self.next_id();
        self.send_command(json!({"type": "clear_queue", "id": clear_id}), cx);
        let abort_id = self.next_id();
        self.send_command(json!({"type": "abort", "id": abort_id}), cx);
        self.queued_steering.clear();
        self.queued_follow_ups.clear();
        self.status = "Stopping…".into();
        cx.notify();
    }

    fn render_queued(&self, index: usize, label: &str, message: &str) -> gpui::AnyElement {
        div()
            .w_full()
            .mb_6()
            .flex()
            .flex_col()
            .items_start()
            .child(
                div()
                    .max_w(relative(0.88))
                    .px(px(9.0))
                    .py(px(10.0))
                    .rounded(px(10.0))
                    .border_1()
                    .border_dashed()
                    .border_color(self.accent.opacity(0.35))
                    .bg(self.accent.opacity(0.11))
                    .child(
                        div()
                            .mb_1()
                            .font_family("Menlo")
                            .text_size(px(9.0))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(self.accent.opacity(0.9))
                            .child(label.to_string()),
                    )
                    .child(
                        TextView::markdown(
                            SharedString::from(format!("agent-queued-{index}")),
                            SharedString::from(message.to_string()),
                        )
                        .selectable(true),
                    ),
            )
            .into_any_element()
    }

    fn render_message(
        &self,
        index: usize,
        message: &AgentMessage,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        if let Some(tool) = message.tool.as_ref() {
            let expanded = self.expanded_tools.contains(&tool.id);
            let toggle_id = tool.id.clone();
            return div()
                .w_full()
                .mb_3p5()
                .overflow_hidden()
                .rounded(px(7.0))
                .border_1()
                .border_color(rgb(0x304050))
                .bg(rgb(0x1b2733))
                .child(
                    div()
                        .id(SharedString::from(format!(
                            "agent-tool-{}-{index}",
                            tool.id
                        )))
                        .h(px(30.0))
                        .px(px(9.0))
                        .flex()
                        .items_center()
                        .gap_2()
                        .cursor_pointer()
                        .hover(|style| style.bg(rgb(0x243442)))
                        .on_click(cx.listener(move |view, _, _, cx| {
                            if !view.expanded_tools.insert(toggle_id.clone()) {
                                view.expanded_tools.remove(&toggle_id);
                            }
                            cx.notify();
                        }))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .font_family("Menlo")
                                .text_size(px(10.0))
                                .text_color(rgb(theme::TEXT_MUTED))
                                .child(tool.label.clone()),
                        )
                        .when(tool.status == ToolStatus::Running, |this| {
                            this.child(
                                div()
                                    .w(px(7.0))
                                    .h(px(7.0))
                                    .rounded_full()
                                    .border_2()
                                    .border_color(rgb(theme::WARNING)),
                            )
                        })
                        .when(tool.status == ToolStatus::Error, |this| {
                            this.child(
                                div()
                                    .w(px(7.0))
                                    .h(px(7.0))
                                    .rounded_full()
                                    .bg(rgb(theme::DANGER)),
                            )
                        }),
                )
                .when(expanded, |this| {
                    this.child(
                        div()
                            .w_full()
                            .border_t_1()
                            .border_color(rgb(theme::BORDER_SUBTLE))
                            .bg(rgb(0x0b1218))
                            .p(px(9.0))
                            .font_family("Menlo")
                            .text_size(px(10.0))
                            .line_height(px(14.0))
                            .text_color(rgb(theme::TEXT_MUTED))
                            .child(tool.body.clone()),
                    )
                })
                .into_any_element();
        }
        let text = TextView::markdown(
            SharedString::from(format!("agent-message-{index}")),
            message.text.clone(),
        )
        .selectable(true);
        if message.role == "user" {
            div()
                .w_full()
                .mb_6()
                .flex()
                .flex_col()
                .items_start()
                .child(
                    div()
                        .max_w(relative(0.88))
                        .px(px(9.0))
                        .py(px(10.0))
                        .rounded(px(10.0))
                        .border_1()
                        .border_color(self.accent.opacity(0.55))
                        .bg(self.accent.opacity(0.16))
                        .text_color(rgb(theme::TEXT_STRONG))
                        .child(text),
                )
                .into_any_element()
        } else {
            div()
                .w_full()
                .mb_6()
                .pl(px(9.0))
                .text_color(rgb(theme::TEXT))
                .child(text)
                .into_any_element()
        }
    }
}

impl Render for AgentView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let messages = self
            .messages
            .iter()
            .enumerate()
            .map(|(index, message)| self.render_message(index, message, cx))
            .collect::<Vec<_>>();
        let streaming = self.streaming.trim().to_string();
        let has_messages = !messages.is_empty();
        let running = self.status == "Running" || self.status.starts_with("Running ");
        let ready = self.status == "Ready";
        if self.composer_input.is_none() {
            let input = cx.new(|cx| {
                TextareaState::new(window, cx)
                    .placeholder("Message Pi…")
                    .auto_grow(1, 5)
                    .submit_on_enter(true)
                    .default_value(self.composer.clone())
            });
            let subscription = cx.subscribe(
                &input,
                |view: &mut Self,
                 input: Entity<TextareaState>,
                 event: &InputEvent,
                 cx: &mut Context<Self>| match event {
                    InputEvent::Change => {
                        view.composer = input.read(cx).value().to_string();
                        cx.notify();
                    }
                    InputEvent::PressEnter {
                        secondary,
                        shift: false,
                    } => {
                        view.composer = input.read(cx).value().to_string();
                        let mode = if view.is_running() {
                            if *secondary {
                                SendMode::FollowUp
                            } else {
                                SendMode::Steer
                            }
                        } else {
                            SendMode::Prompt
                        };
                        view.submit(mode, cx);
                        cx.notify();
                    }
                    _ => {}
                },
            );
            self.composer_input = Some(input);
            self.composer_subscription = Some(subscription);
        }
        if self.clear_composer {
            if let Some(input) = self.composer_input.as_ref() {
                input.update(cx, |state, cx| state.set_value("", window, cx));
            }
            self.clear_composer = false;
        }
        let composer_input = self
            .composer_input
            .clone()
            .expect("composer input is initialized");
        let queued = self
            .queued_steering
            .iter()
            .enumerate()
            .map(|(index, message)| self.render_queued(index, "STEERING", message))
            .chain(
                self.queued_follow_ups
                    .iter()
                    .enumerate()
                    .map(|(index, message)| {
                        self.render_queued(index + self.queued_steering.len(), "FOLLOW UP", message)
                    }),
            )
            .collect::<Vec<_>>();
        let can_send = !self.composer.trim().is_empty() && self.status != "Starting Pi…";
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(theme::CANVAS))
            .child(
                div()
                    .id("agent-transcript")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .px_5()
                    .py_4()
                    .children(messages)
                    .when(!streaming.is_empty(), |this| {
                        this.child(
                            div()
                                .w_full()
                                .mb_6()
                                .pl(px(9.0))
                                .py_3()
                                .text_color(rgb(theme::TEXT))
                                .child(
                                    TextView::markdown(
                                        "agent-streaming",
                                        SharedString::from(format!("{streaming}▌")),
                                    )
                                    .selectable(true),
                                ),
                        )
                    })
                    .when(running && streaming.is_empty(), |this| {
                        this.child(
                            div()
                                .w_full()
                                .min_h(px(24.0))
                                .mb(px(18.0))
                                .pl(px(9.0))
                                .flex()
                                .items_center()
                                .gap(px(3.0))
                                .child(thinking_dot(0))
                                .child(thinking_dot(1))
                                .child(thinking_dot(2)),
                        )
                    })
                    .when(!queued.is_empty(), |this| this.children(queued))
                    .when(!has_messages && streaming.is_empty(), |this| {
                        this.child(
                            div()
                                .flex()
                                .items_center()
                                .justify_center()
                                .py_12()
                                .text_sm()
                                .text_color(rgb(theme::TEXT_MUTED))
                                .child(if self.status == "Starting Pi…" {
                                    "Starting Pi session…"
                                } else if self.process.is_some() {
                                    "No messages yet. Send a prompt to start."
                                } else {
                                    "Pi session unavailable."
                                }),
                        )
                    }),
            )
            .when_some(self.error.clone(), |this, error| {
                this.child(
                    div()
                        .px_5()
                        .py_2()
                        .bg(rgb(0x3a2530))
                        .text_xs()
                        .text_color(rgb(theme::DANGER))
                        .child(error),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .px_4()
                    .py_3()
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_end()
                            .gap_2()
                            .child(
                                Textarea::new(&composer_input)
                                    .appearance(true)
                                    .bordered(true)
                                    .flex_1()
                                    .min_h(px(38.0))
                                    .max_h(px(140.0))
                                    .rounded_md()
                                    .bg(rgb(theme::SURFACE_RAISED))
                                    .border_color(rgb(theme::BORDER))
                                    .text_sm()
                                    .disabled(self.status == "Starting Pi…"),
                            )
                            .child(if running {
                                div()
                                    .id("agent-stop")
                                    .w(px(38.0))
                                    .h(px(38.0))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(7.0))
                                    .border_1()
                                    .border_color(rgb(theme::FOCUS))
                                    .bg(rgb(theme::ACCENT_SOFT))
                                    .cursor_pointer()
                                    .hover(|style| style.bg(rgb(0x223246)))
                                    .on_click(cx.listener(|view, _, _, cx| view.abort(cx)))
                                    .child(
                                        div()
                                            .w(px(8.0))
                                            .h(px(8.0))
                                            .rounded(px(1.0))
                                            .bg(rgb(theme::TEXT_STRONG)),
                                    )
                                    .into_any_element()
                            } else {
                                div()
                                    .id("agent-send")
                                    .w(px(38.0))
                                    .h(px(38.0))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(7.0))
                                    .border_1()
                                    .border_color(rgb(if can_send {
                                        theme::FOCUS
                                    } else {
                                        theme::BORDER
                                    }))
                                    .bg(rgb(if can_send {
                                        theme::ACCENT
                                    } else {
                                        theme::ACCENT_SOFT
                                    }))
                                    .text_color(rgb(if can_send {
                                        theme::TEXT_STRONG
                                    } else {
                                        theme::TEXT_FAINT
                                    }))
                                    .when(can_send, |this| {
                                        this.cursor_pointer()
                                            .hover(|style| style.bg(rgb(0x5c9bcb)))
                                            .on_click(cx.listener(|view, _, _, cx| view.send(cx)))
                                    })
                                    .child(
                                        div()
                                            .text_size(px(18.0))
                                            .font_weight(gpui::FontWeight::MEDIUM)
                                            .child("↑"),
                                    )
                                    .into_any_element()
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(
                                div()
                                    .w(px(220.0))
                                    .flex()
                                    .items_center()
                                    .gap_1()
                                    .pl_2()
                                    .font_family("Menlo")
                                    .child(
                                        div()
                                            .id("quick-yes")
                                            .px_1()
                                            .py(px(1.0))
                                            .rounded(px(4.0))
                                            .text_size(px(9.0))
                                            .font_weight(gpui::FontWeight::SEMIBOLD)
                                            .text_color(rgb(if ready {
                                                0x718397
                                            } else {
                                                0x3f4e5d
                                            }))
                                            .when(ready, |this| {
                                                this.cursor_pointer()
                                                    .hover(|style| {
                                                        style
                                                            .bg(rgb(theme::SURFACE_RAISED))
                                                            .text_color(rgb(0xb7c6d4))
                                                    })
                                                    .on_click(cx.listener(|view, _, _, cx| {
                                                        view.send_quick_response("yes", cx)
                                                    }))
                                            })
                                            .child("YES"),
                                    )
                                    .child(
                                        div()
                                            .id("quick-no")
                                            .px_1()
                                            .py(px(1.0))
                                            .rounded(px(4.0))
                                            .text_size(px(9.0))
                                            .font_weight(gpui::FontWeight::SEMIBOLD)
                                            .text_color(rgb(if ready {
                                                0x718397
                                            } else {
                                                0x3f4e5d
                                            }))
                                            .when(ready, |this| {
                                                this.cursor_pointer()
                                                    .hover(|style| {
                                                        style
                                                            .bg(rgb(theme::SURFACE_RAISED))
                                                            .text_color(rgb(0xb7c6d4))
                                                    })
                                                    .on_click(cx.listener(|view, _, _, cx| {
                                                        view.send_quick_response("no", cx)
                                                    }))
                                            })
                                            .child("NO"),
                                    )
                                    .child(
                                        div()
                                            .id("quick-recommend")
                                            .px_1()
                                            .py(px(1.0))
                                            .rounded(px(4.0))
                                            .text_size(px(9.0))
                                            .font_weight(gpui::FontWeight::SEMIBOLD)
                                            .text_color(rgb(if ready {
                                                0x718397
                                            } else {
                                                0x3f4e5d
                                            }))
                                            .when(ready, |this| {
                                                this.cursor_pointer()
                                                    .hover(|style| {
                                                        style
                                                            .bg(rgb(theme::SURFACE_RAISED))
                                                            .text_color(rgb(0xb7c6d4))
                                                    })
                                                    .on_click(cx.listener(|view, _, _, cx| {
                                                        view.send_quick_response(
                                                            "what do you recommend?",
                                                            cx,
                                                        )
                                                    }))
                                            })
                                            .child("RECOMMEND"),
                                    ),
                            )
                            .child(div().flex_1())
                            .child(
                                div()
                                    .relative()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .child(
                                        div()
                                            .id("agent-model")
                                            .px_2()
                                            .py_1()
                                            .rounded_md()
                                            .cursor_pointer()
                                            .bg(rgb(theme::CANVAS))
                                            .text_xs()
                                            .text_color(rgb(theme::TEXT_MUTED))
                                            .hover(|style| style.text_color(rgb(theme::TEXT)))
                                            .on_click(cx.listener(|view, _, _, cx| {
                                                view.model_picker_open = !view.model_picker_open;
                                                view.thinking_picker_open = false;
                                                cx.notify();
                                            }))
                                            .child(if self.model.is_empty() {
                                                "Select model ▾".to_string()
                                            } else {
                                                format!("{} ▾", self.model)
                                            }),
                                    )
                                    .child(
                                        div()
                                            .relative()
                                            .flex()
                                            .items_center()
                                            .child(
                                                div()
                                                    .id("agent-thinking")
                                                    .px_2()
                                                    .py_1()
                                                    .rounded_md()
                                                    .cursor_pointer()
                                                    .bg(rgb(theme::CANVAS))
                                                    .text_xs()
                                                    .text_color(rgb(theme::TEXT_MUTED))
                                                    .hover(|style| {
                                                        style.text_color(rgb(theme::TEXT))
                                                    })
                                                    .on_click(cx.listener(
                                                        |view, _, _, cx| {
                                                            view.thinking_picker_open =
                                                                !view.thinking_picker_open;
                                                            view.model_picker_open = false;
                                                            cx.notify();
                                                        },
                                                    ))
                                                    .child(if self.thinking_level.is_empty() {
                                                        "effort ▾".to_string()
                                                    } else {
                                                        format!("{} ▾", self.thinking_level)
                                                    }),
                                            )
                                            .when(self.thinking_picker_open, |this| {
                                                this.child(
                                                    div()
                                                        .id("agent-thinking-menu")
                                                        .absolute()
                                                        .bottom(px(34.0))
                                                        .left(px(-60.0))
                                                        .w(px(200.0))
                                                        .max_h(px(260.0))
                                                        .overflow_y_scroll()
                                                        .track_scroll(&self.thinking_scroll)
                                                        .flex()
                                                        .flex_col()
                                                        .gap_1()
                                                        .p_1()
                                                        .rounded_md()
                                                        .bg(rgb(theme::SURFACE))
                                                        .border_1()
                                                        .border_color(rgb(theme::BORDER))
                                                        .shadow_lg()
                                                        .on_scroll(cx.listener(
                                                            |view,
                                                             event: &ScrollEvent,
                                                             _,
                                                             cx| {
                                                                cx.stop_propagation();
                                                                let dy = match event.delta {
                                                                    ScrollDelta::Lines(delta) => {
                                                                        f32::from(delta.y) * 22.0
                                                                    }
                                                                    ScrollDelta::Pixels(delta) => {
                                                                        f32::from(delta.y)
                                                                    }
                                                                };
                                                                let offset =
                                                                    view.thinking_scroll.offset();
                                                                let max_y = view
                                                                    .thinking_scroll
                                                                    .max_offset()
                                                                    .y;
                                                                let y = (offset.y - px(dy))
                                                                    .clamp(
                                                                        px(0.0),
                                                                        max_y.max(px(0.0)),
                                                                    );
                                                                view.thinking_scroll.set_offset(
                                                                    gpui::point(offset.x, y),
                                                                );
                                                                cx.notify();
                                                            },
                                                        ))
                                                        .when(
                                                            self.thinking_levels.is_empty(),
                                                            |this| {
                                                                this.child(
                                                                    div()
                                                                        .p_2()
                                                                        .text_xs()
                                                                        .text_color(
                                                                            rgb(theme::TEXT_MUTED),
                                                                        )
                                                                        .child(
                                                                            "Loading effort…",
                                                                        ),
                                                                )
                                                            },
                                                        )
                                                        .children(
                                                            self.thinking_levels.iter().cloned().map(
                                                                |level| {
                                                                    let selected = level
                                                                        == self.thinking_level;
                                                                    let label = level.clone();
                                                                    div()
                                                                        .id(SharedString::from(
                                                                            format!(
                                                                                "agent-thinking-{level}"
                                                                            ),
                                                                        ))
                                                                        .w_full()
                                                                        .px_2()
                                                                        .py(px(5.0))
                                                                        .rounded(px(5.0))
                                                                        .text_left()
                                                                        .text_xs()
                                                                        .text_color(rgb(if selected {
                                                                            theme::TEXT_STRONG
                                                                        } else {
                                                                            theme::TEXT_MUTED
                                                                        }))
                                                                        .when(selected, |this| {
                                                                            this.bg(rgb(
                                                                                theme::ACCENT_SOFT,
                                                                            ))
                                                                        })
                                                                        .cursor_pointer()
                                                                        .hover(|style| {
                                                                            style
                                                                                .bg(rgb(
                                                                                    theme::SURFACE_RAISED,
                                                                                ))
                                                                                .text_color(rgb(
                                                                                    theme::TEXT,
                                                                                ))
                                                                        })
                                                                        .on_click(cx.listener(
                                                                            move |view,
                                                                                  _,
                                                                                  _,
                                                                                  cx| {
                                                                                view.select_thinking_level(
                                                                                    label.clone(),
                                                                                    cx,
                                                                                );
                                                                            },
                                                                        ))
                                                                        .child(level)
                                                                },
                                                            ),
                                                        ),
                                                )
                                            }),
                                    )
                                    .when_some(self.context_percent, |this, percent| {
                                        let label = format!("{:.0}%", percent);
                                        this.child(
                                            div()
                                                .font_family("Menlo")
                                                .text_xs()
                                                .text_color(rgb(theme::TEXT_FAINT))
                                                .child(label),
                                        )
                                    })
                                    .when(self.model_picker_open, |this| {
                                        this.child(
                                            div()
                                                .id("agent-model-menu")
                                                .absolute()
                                                .bottom(px(34.0))
                                                .left(px(-90.0))
                                                .w(px(300.0))
                                                .max_h(px(300.0))
                                                .overflow_y_scroll()
                                                .track_scroll(&self.model_scroll)
                                                .flex()
                                                .flex_col()
                                                .gap_1()
                                                .p_1()
                                                .rounded_md()
                                                .bg(rgb(theme::SURFACE))
                                                .border_1()
                                                .border_color(rgb(theme::BORDER))
                                                .shadow_lg()
                                                .on_scroll(cx.listener(
                                                    |view, event: &ScrollEvent, _, cx| {
                                                        cx.stop_propagation();
                                                        let dy = match event.delta {
                                                            ScrollDelta::Lines(delta) => {
                                                                f32::from(delta.y) * 22.0
                                                            }
                                                            ScrollDelta::Pixels(delta) => {
                                                                f32::from(delta.y)
                                                            }
                                                        };
                                                        let offset = view.model_scroll.offset();
                                                        let max_y =
                                                            view.model_scroll.max_offset().y;
                                                        let y = (offset.y - px(dy))
                                                            .clamp(px(0.0), max_y.max(px(0.0)));
                                                        view.model_scroll
                                                            .set_offset(gpui::point(offset.x, y));
                                                        cx.notify();
                                                    },
                                                ))
                                                .when(self.models.is_empty(), |this| {
                                                    this.child(
                                                        div()
                                                            .p_2()
                                                            .text_xs()
                                                            .text_color(rgb(theme::TEXT_MUTED))
                                                            .child("Loading models…"),
                                                    )
                                                })
                                                .children(self.models.iter().cloned().map(
                                                    |model| {
                                                        let selected = model.name == self.model;
                                                        let label = model.name.clone();
                                                        div()
                                                            .id(SharedString::from(format!(
                                                                "agent-model-{}-{}",
                                                                model.provider, model.id
                                                            )))
                                                            .w_full()
                                                            .px_2()
                                                            .py(px(5.0))
                                                            .rounded(px(5.0))
                                                            .text_left()
                                                            .text_xs()
                                                            .text_color(rgb(if selected {
                                                                theme::TEXT_STRONG
                                                            } else {
                                                                theme::TEXT_MUTED
                                                            }))
                                                            .when(selected, |this| {
                                                                this.bg(rgb(theme::ACCENT_SOFT))
                                                            })
                                                            .cursor_pointer()
                                                            .hover(|style| {
                                                                style
                                                                    .bg(rgb(theme::SURFACE_RAISED))
                                                                    .text_color(rgb(theme::TEXT))
                                                            })
                                                            .on_click(cx.listener(
                                                                move |view, _, _, cx| {
                                                                    view.select_model(
                                                                        model.clone(),
                                                                        cx,
                                                                    );
                                                                },
                                                            ))
                                                            .child(label)
                                                    },
                                                )),
                                        )
                                    }),
                            )
                            .child(div().flex_1())
                            .child(div().w(px(220.0))),
                    ),
            )
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn thinking_dot(index: usize) -> impl IntoElement {
    let offset = index as f32 * 0.16;
    div()
        .w(px(3.0))
        .h(px(3.0))
        .rounded_full()
        .bg(rgb(0x718ba3))
        .with_animation(
            SharedString::from(format!("agent-thinking-dot-{index}")),
            Animation::new(Duration::from_millis(1200))
                .repeat()
                .with_easing(move |phase| {
                    let phase = (phase + offset) % 1.0;
                    if phase < 0.3 {
                        0.3 + (phase / 0.3) * 0.7
                    } else if phase < 0.6 {
                        1.0 - ((phase - 0.3) / 0.3) * 0.7
                    } else {
                        0.3
                    }
                }),
            |dot, value| dot.opacity(value),
        )
}

fn parse_messages(messages: &[Value]) -> Vec<AgentMessage> {
    let mut args_by_id = HashMap::new();
    for message in messages {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(blocks) = message.get("content").and_then(Value::as_array) else {
            continue;
        };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("toolCall") {
                continue;
            }
            if let Some(id) = block.get("id").and_then(Value::as_str) {
                args_by_id.insert(
                    id.to_string(),
                    block.get("arguments").cloned().unwrap_or(Value::Null),
                );
            }
        }
    }
    messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| parse_message(message, index, &args_by_id))
        .collect()
}

fn parse_message(
    message: &Value,
    index: usize,
    args_by_id: &HashMap<String, Value>,
) -> Option<AgentMessage> {
    let role = message.get("role")?.as_str()?.to_string();
    if role == "toolResult" {
        let id = message
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("tool-{index}"));
        let name = message
            .get("toolName")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let args = args_by_id.get(&id).cloned().unwrap_or(Value::Null);
        let output = message.get("content").map(content_text).unwrap_or_default();
        let status = if message.get("isError").and_then(Value::as_bool) == Some(true) {
            ToolStatus::Error
        } else {
            ToolStatus::Complete
        };
        return Some(AgentMessage {
            role: "tool".into(),
            text: String::new(),
            tool: Some(make_tool(id, name, &args, &output, status)),
        });
    }
    let text = message.get("content").map(content_text).unwrap_or_default();
    (!text.trim().is_empty()).then_some(AgentMessage {
        role,
        text,
        tool: None,
    })
}

fn make_tool(
    id: String,
    name: String,
    args: &Value,
    output: &str,
    status: ToolStatus,
) -> AgentTool {
    AgentTool {
        label: tool_label(&name, args, matches!(status, ToolStatus::Running)),
        body: tool_body(&name, args, output),
        id,
        name,
        args: args.clone(),
        status,
    }
}

fn tool_label(name: &str, args: &Value, running: bool) -> String {
    let normalized = name.to_ascii_lowercase();
    let string = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("");
    let path = || {
        let path = string("path");
        if path.is_empty() {
            string("file_path")
        } else {
            path
        }
    };
    match normalized.as_str() {
        "edit" => format!("editing {}", file_name(path())),
        "read" => format!(
            "{} {}",
            if running { "reading" } else { "read" },
            file_name(path())
        ),
        "write" => format!(
            "{} {}",
            if running { "writing" } else { "wrote" },
            file_name(path())
        ),
        "bash" => {
            let command = string("command");
            let preview = command.lines().next().unwrap_or("command").trim();
            let preview = if preview.chars().count() > 140 {
                format!("{}…", preview.chars().take(137).collect::<String>())
            } else {
                preview.to_string()
            };
            format!("{}: {preview}", if running { "running" } else { "ran" })
        }
        _ => normalized,
    }
}

fn tool_body(name: &str, args: &Value, output: &str) -> String {
    if name.eq_ignore_ascii_case("bash") {
        return output.to_string();
    }
    let input = if args.is_null() {
        String::new()
    } else {
        serde_json::to_string_pretty(args).unwrap_or_default()
    };
    [input, output.to_string()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn file_name(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or("file")
        .to_string()
}

fn parse_model(model: &Value) -> Option<AgentModel> {
    let id = model.get("id")?.as_str()?.to_string();
    let provider = model.get("provider")?.as_str()?.to_string();
    let name = model
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_string();
    Some(AgentModel { id, name, provider })
}

fn content_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    let mut parts = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    parts.push(text.to_string());
                }
            }
            _ => {}
        }
    }
    parts.join("\n\n")
}

pub fn safe_session_key(owner_id: &str) -> String {
    owner_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

pub fn card_pi_session_dir(card_id: &str, thread: &str) -> PathBuf {
    pi_sessions_dir()
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("cards")
        .join(safe_session_key(card_id))
        .join("pi-sessions")
        .join(safe_session_key(thread))
}

pub fn pi_sessions_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("STACKS_GPUI_PI_SESSIONS") {
        return PathBuf::from(path);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join("Library/Application Support/stacks/pi-sessions")
}

pub fn extension_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("STACKS_GPUI_PI_EXTENSION") {
        return Some(PathBuf::from(path));
    }
    let bundled = std::env::current_exe().ok().and_then(|exe| {
        exe.parent()
            .map(|parent| parent.join("../Resources/stacks-cards.ts"))
    });
    if let Some(path) = bundled.as_ref()
        && path.is_file()
    {
        return Some(path.clone());
    }
    let development =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/resources/stacks-cards.ts");
    development.is_file().then_some(development)
}

pub fn project_trusted(project_path: &str) -> bool {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let path = home.join("Library/Application Support/stacks/pi-trusted-projects.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    serde_json::from_str::<Vec<String>>(&text)
        .map(|projects| projects.iter().any(|path| path == project_path))
        .unwrap_or(false)
}

fn find_pi() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PI_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let output = Command::new(shell)
        .args(["-lic", "command -v pi"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then_some(PathBuf::from(path))
}
