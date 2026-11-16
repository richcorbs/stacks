//! SQLite read model for the native LIST surface.
//!
//! The store is intentionally narrow: one board-level read and one backlog
//! reorder write. It opens the shipped `workflow.sqlite3` without migrations or
//! Tauri state, and maps it into the `model` types. This is the reusable data
//! path the GPUI shell renders; future native surfaces should extend this crate
//! rather than add SQL to the UI.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context as _, Result, bail};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

use crate::{
    grouping::merge_filtered_lane_order,
    model::{
        CardDetail, CardEvent, CardSnapshot, CardStatus, CardSummary, DeliveryWorkflow,
        EnvironmentIndicator, Project, PullRequestIndicator, Relationship,
    },
};

pub const DATABASE_ENV: &str = "STACKS_TUI_DB";
pub const REORDER_CONFLICT_CODE: &str = "KANBAN_REORDER_CONFLICT";

#[derive(Clone, Debug)]
pub struct ScriptedDeploymentCommand {
    pub card_id: String,
    pub command: String,
    pub cwd: String,
    pub project_id: String,
    pub target_branch: String,
    pub source_revision: String,
    pub merge_revision: String,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedChildSpec {
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct SuperthreadProjectConfig {
    pub enabled: bool,
    pub spaces: String,
    pub api_token_env_var: String,
    pub workspace_slug: Option<String>,
    pub board_id: String,
    pub incoming_column_ids: Vec<String>,
    pub default_incoming_column_id: String,
    pub in_progress_column_id: String,
    pub done_column_id: String,
}

#[derive(Debug, Clone)]
pub struct ProjectSettingsUpdate {
    pub name: String,
    pub path: String,
    pub target_branch: String,
    pub start_work_command: Option<String>,
    pub server_command: Option<String>,
    pub console_command: Option<String>,
    pub releases_enabled: bool,
    pub release_config_path: String,
}

#[derive(Clone, Debug)]
pub struct CardStore {
    path: PathBuf,
}

impl CardStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Real Stacks data by default (`~/Library/Application Support/stacks`
    /// through [`crate::paths`]). `STACKS_TUI_DB` / `--db` isolate tests and
    /// development; `STACKS_GPUI_CARDS_DB` remains honoured for the native
    /// read-model fixture.
    pub fn default_store() -> Self {
        if let Some(path) = std::env::var_os("STACKS_GPUI_CARDS_DB") {
            return Self::new(path);
        }
        match crate::paths::database_path() {
            Ok(path) => Self::new(path),
            Err(_) => {
                let home = std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("."));
                Self::new(
                    home.join("Library/Application Support/stacks")
                        .join(crate::paths::DATABASE_FILE),
                )
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn exists(&self) -> bool {
        self.path.exists()
    }

    /// Read the board summary used by LIST. Opens read-only and never migrates.
    pub fn load_snapshot(&self) -> Result<CardSnapshot> {
        let connection = self.open_read_only()?;
        load_snapshot_from(&connection)
    }

    /// Read a card detail projection from real local data. This deliberately
    /// loads the board summary first so the detail reuses the same effective
    /// hierarchy status/groups as LIST; a later production pass can narrow it to
    /// one-row queries.
    pub fn load_detail(&self, card_id: &str) -> Result<CardDetail> {
        let snapshot = self.load_snapshot()?;
        let card = snapshot
            .cards
            .iter()
            .find(|card| card.id == card_id)
            .cloned()
            .ok_or_else(|| {
                anyhow::anyhow!("Card is not in scope or no longer exists: {card_id}")
            })?;
        let project = card.project(&snapshot.projects).cloned();
        let connection = self.open_read_only()?;
        let (content, card_url, feature_environment, runtime_cleanup_status, runtime_cleanup_error) =
            connection
                .query_row(
                    "SELECT content, card_url, feature_environment,
                            runtime_cleanup_status, runtime_cleanup_error
                     FROM kanban_cards WHERE id = ?1 AND in_scope = 1",
                    [card_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)? != 0,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<String>>(4)?,
                        ))
                    },
                )
                .with_context(|| format!("read detail fields for card {card_id}"))?;
        let events = load_card_events(&connection, card_id, 30)?;
        let workflow_context = load_workflow_context(
            &connection,
            &card,
            project.as_ref(),
            runtime_cleanup_status.as_deref(),
        )?;
        let capabilities = crate::workflow::present_actions(&workflow_context, false);
        Ok(CardDetail {
            card,
            content,
            card_url,
            feature_environment,
            runtime_cleanup_status,
            runtime_cleanup_error,
            events,
            workflow_context,
            capabilities,
        })
    }

    /// Apply the narrow set of local-only workflow actions whose existing
    /// backend behavior is a single transactional status change (or a local
    /// draft delete). The caller passes the workflow revision it rendered.
    pub fn apply_local_action(
        &self,
        card_id: &str,
        action: crate::workflow::WorkflowAction,
        expected_revision: i64,
    ) -> Result<()> {
        use crate::workflow::{WorkflowAction, WorkflowActor};

        if !matches!(
            action,
            WorkflowAction::OpenRefinement
                | WorkflowAction::ReturnToRefinement
                | WorkflowAction::StopRefinement
                | WorkflowAction::RequestChanges
                | WorkflowAction::Close
                | WorkflowAction::Delete
        ) {
            bail!("This workflow action is not available in the native app yet");
        }
        let detail = self.load_detail(card_id)?;
        if detail.card.workflow_revision != expected_revision {
            bail!("Card changed; reload before trying again");
        }
        let capability = detail
            .capabilities
            .iter()
            .find(|capability| capability.action == action)
            .ok_or_else(|| anyhow::anyhow!("This action is not available for the card"))?;
        if let Some(reason) = &capability.disabled_reason {
            bail!("{reason}");
        }

        let mut connection = self.open_write()?;
        let transaction = connection.transaction().context("begin workflow action")?;
        if action == WorkflowAction::Delete {
            if detail.card.provider == "superthread" {
                let binding: Option<String> = transaction
                    .query_row(
                        "SELECT binding_id FROM kanban_cards WHERE id=?1",
                        [card_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .context("read provider binding")?
                    .flatten();
                let external_id: String = transaction
                    .query_row(
                        "SELECT external_id FROM kanban_cards WHERE id=?1",
                        [card_id],
                        |row| row.get(0),
                    )
                    .context("read provider identity")?;
                if let Some(binding) = binding {
                    transaction
                        .execute(
                            "INSERT OR IGNORE INTO retired_provider_cards(binding_id,external_id,retired_at)
                             VALUES (?1,?2,unixepoch())",
                            params![binding, external_id],
                        )
                        .context("retire provider card")?;
                }
            }
            let changed = transaction
                .execute("DELETE FROM kanban_cards WHERE id=?1", [card_id])
                .context("delete card")?;
            if changed != 1 {
                bail!("Card changed; reload before trying again");
            }
            transaction.commit().context("commit delete card")?;
            return Ok(());
        }

        let transition =
            crate::workflow::transition(&detail.workflow_context, WorkflowActor::User, action)
                .map_err(anyhow::Error::msg)?;
        if transition.from == transition.to
            && transition.outcome == detail.workflow_context.completion_outcome
        {
            return Ok(());
        }
        let changed = transaction
            .execute(
                "UPDATE kanban_cards SET status=?1, completion_outcome=?2,
                    workflow_revision=workflow_revision+1, updated_at=unixepoch(),
                    sort_order=(SELECT COALESCE(MAX(sort_order), -1) + 1
                                FROM kanban_cards destination WHERE destination.status=?1)
                 WHERE id=?3 AND workflow_revision=?4",
                params![
                    transition.to,
                    transition.outcome,
                    card_id,
                    expected_revision
                ],
            )
            .context("apply workflow transition")?;
        if changed != 1 {
            bail!("Card changed; reload before trying again");
        }
        transaction
            .execute(
                "INSERT INTO card_events
                    (card_id,created_at,actor,event_type,outcome,from_status,to_status,summary)
                 VALUES (?1,unixepoch(),?2,?3,'success',?4,?5,NULL)",
                params![
                    card_id,
                    WorkflowActor::User,
                    action.as_str(),
                    transition.from,
                    transition.to
                ],
            )
            .context("record workflow event")?;
        if action == WorkflowAction::Close {
            transaction
                .execute(
                    "UPDATE kanban_cards SET delivery_operation_stage=NULL, delivery_error=NULL,
                        runtime_cleanup_status='pending', runtime_cleanup_error=NULL
                     WHERE id=?1",
                    [card_id],
                )
                .context("mark runtime cleanup pending")?;
        }
        transaction.commit().context("commit workflow action")?;
        Ok(())
    }

    /// Prepare an asynchronous deployment: push as needed, mark the operation
    /// deploying, and return the command the host should supervise.
    pub fn begin_scripted_deploy(&self, card_id: &str) -> Result<ScriptedDeploymentCommand> {
        let (initial_stage, _, _, _) = self.scripted_evidence(card_id)?;
        if !matches!(initial_stage.as_str(), "deployment_failed" | "uncertain") {
            self.push_scripted_card(card_id)?;
        }
        let detail = self.load_detail(card_id)?;
        let snapshot = self.load_snapshot()?;
        let project = detail
            .card
            .project(&snapshot.projects)
            .ok_or_else(|| anyhow::anyhow!("The card's project is missing"))?;
        let command = project
            .deployment_command
            .clone()
            .filter(|command| !command.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("The project deployment command is empty"))?;
        let (stage, path, target_branch, merge_revision, source_revision) = {
            let connection = self.open_read_only()?;
            connection
                .query_row(
                    "SELECT stage,primary_checkout_path,target_branch,merge_revision,source_revision
                     FROM scripted_delivery_operations WHERE card_id=?1",
                    [card_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    },
                )
                .context("read deployment evidence")?
        };
        if stage == "deployed" {
            bail!("The deployment is already complete");
        }
        if stage == "deploying" {
            bail!("A deployment is already running");
        }
        let mut connection = self.open_write()?;
        let transaction = connection.transaction().context("begin deployment")?;
        transaction
            .execute(
                "UPDATE scripted_delivery_operations SET stage='deploying',
                    attempt=attempt+1, failure_class=NULL, summary='Deployment command started',
                    updated_at=unixepoch(), revision=revision+1 WHERE card_id=?1",
                [card_id],
            )
            .context("mark deployment running")?;
        transaction
            .execute(
                "UPDATE kanban_cards SET delivery_operation_stage='deploying',
                    delivery_error=NULL, updated_at=unixepoch() WHERE id=?1",
                [card_id],
            )
            .context("mark card deployment running")?;
        transaction.commit().context("commit deployment start")?;
        Ok(ScriptedDeploymentCommand {
            card_id: card_id.to_string(),
            command,
            cwd: path,
            project_id: project.id.clone(),
            target_branch,
            source_revision,
            merge_revision,
        })
    }

    /// Record the supervised deployment result and complete the card if it
    /// succeeded.
    pub fn finish_scripted_deploy(
        &self,
        card_id: &str,
        success: bool,
        error: Option<String>,
    ) -> Result<()> {
        use crate::workflow::{WorkflowAction, WorkflowActor};

        if !success {
            self.record_scripted_stage(
                card_id,
                "deployment_failed",
                "deployment_failed",
                "Deployment command failed",
                error.as_deref().or(Some("Deployment command failed")),
            )?;
            return Ok(());
        }
        let detail = self.load_detail(card_id)?;
        let transition = crate::workflow::transition(
            &detail.workflow_context,
            WorkflowActor::User,
            WorkflowAction::Deploy,
        )
        .map_err(anyhow::Error::msg)?;
        let (_, path, _, _, _) = {
            let connection = self.open_read_only()?;
            connection
                .query_row(
                    "SELECT stage,primary_checkout_path,target_branch,merge_revision,source_revision
                     FROM scripted_delivery_operations WHERE card_id=?1",
                    [card_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    },
                )
                .context("read deployment evidence")?
        };
        let tip = git_text(["-C", &path, "rev-parse", "HEAD"])?;
        let tip = tip.trim().to_string();
        let mut connection = self.open_write()?;
        let transaction = connection.transaction().context("finish deployment")?;
        transaction
            .execute(
                "UPDATE scripted_delivery_operations SET stage='deployed',
                    deployed_revision=?1, failure_class=NULL,
                    summary='Deployment command succeeded', completed_at=unixepoch(),
                    updated_at=unixepoch(), revision=revision+1 WHERE card_id=?2",
                params![tip, card_id],
            )
            .context("record deployment success")?;
        transaction
            .execute(
                "UPDATE kanban_cards SET status=?1, completion_outcome=?2,
                    delivery_operation_stage=NULL, delivery_error=NULL,
                    workflow_revision=workflow_revision+1, updated_at=unixepoch(),
                    sort_order=(SELECT COALESCE(MAX(sort_order), -1) + 1
                                FROM kanban_cards destination WHERE destination.status=?1)
                 WHERE id=?3",
                params![transition.to, transition.outcome, card_id],
            )
            .context("complete deployed card")?;
        transaction
            .execute(
                "INSERT INTO card_events
                    (card_id,created_at,actor,event_type,outcome,summary)
                 VALUES (?1,unixepoch(),?2,'scripted_deploy','success',
                    'Push verified and deployment command succeeded')",
                params![card_id, WorkflowActor::User],
            )
            .context("record deployment event")?;
        transaction.commit().context("commit deployment")?;
        Ok(())
    }

    pub fn cancel_scripted_deploy(&self, card_id: &str) -> Result<()> {
        let mut connection = self.open_write()?;
        let transaction = connection.transaction().context("cancel deployment")?;
        transaction
            .execute(
                "UPDATE scripted_delivery_operations SET stage='cancelled',
                    failure_class='cancelled', summary='Deployment was cancelled',
                    updated_at=unixepoch(), revision=revision+1 WHERE card_id=?1",
                [card_id],
            )
            .context("mark deployment cancelled")?;
        transaction
            .execute(
                "UPDATE kanban_cards SET delivery_operation_stage='cancelled',
                    delivery_error='Deployment was cancelled', updated_at=unixepoch()
                 WHERE id=?1",
                [card_id],
            )
            .context("mark card deployment cancelled")?;
        transaction
            .execute(
                "INSERT INTO card_events
                    (card_id,created_at,actor,event_type,outcome,summary)
                 VALUES (?1,unixepoch(),'user','scripted_deploy','failure',
                    'Deployment was cancelled')",
                [card_id],
            )
            .context("record cancellation event")?;
        transaction.commit().context("commit deployment cancel")?;
        Ok(())
    }

    /// Push the target branch for a scripted-delivery card and verify the
    /// upstream tip.
    pub fn push_scripted_card(&self, card_id: &str) -> Result<()> {
        let (stage, path, target_branch, tip) = self.scripted_evidence(card_id)?;
        if matches!(stage.as_str(), "deploying" | "deployed") {
            bail!("Push is not available during or after deployment");
        }
        if !matches!(stage.as_str(), "merged" | "push_failed" | "pushed") {
            bail!("Push is not available from the current delivery stage");
        }
        let remote = git_text([
            "-C",
            &path,
            "config",
            "--get",
            &format!("branch.{target_branch}.remote"),
        ])?;
        let upstream = git_text([
            "-C",
            &path,
            "config",
            "--get",
            &format!("branch.{target_branch}.merge"),
        ])?;
        let remote = remote.trim();
        let upstream = upstream.trim();
        if remote.is_empty() || remote == "." || !upstream.starts_with("refs/heads/") {
            bail!("Target branch has no usable upstream remote/ref");
        }
        let remote_tip = git_text(["-C", &path, "ls-remote", "--heads", remote, upstream])?;
        let remote_tip = remote_tip.split_whitespace().next().map(str::to_string);
        let already_pushed = remote_tip.as_deref() == Some(tip.as_str());
        if !already_pushed {
            if let Some(remote_revision) = remote_tip.as_deref() {
                let ancestor = std::process::Command::new("git")
                    .args([
                        "-C",
                        &path,
                        "merge-base",
                        "--is-ancestor",
                        remote_revision,
                        &tip,
                    ])
                    .status()
                    .context("check upstream ancestry")?;
                if !ancestor.success() {
                    bail!("Upstream target has diverged; a fast-forward push is not possible");
                }
            }
            let push = std::process::Command::new("git")
                .args(["-C", &path, "push", remote, &format!("HEAD:{upstream}")])
                .output()
                .context("push scripted target")?;
            if !push.status.success() {
                self.record_scripted_stage(
                    card_id,
                    "push_failed",
                    "push_failed",
                    "Push failed; no deployment was run",
                    Some("Push failed; inspect the upstream and retry."),
                )?;
                bail!("Push failed; no deployment was run");
            }
        }
        let mut connection = self.open_write()?;
        let transaction = connection.transaction().context("begin scripted push")?;
        transaction
            .execute(
                "UPDATE scripted_delivery_operations SET stage='pushed',
                    verified_push_revision=?1, upstream_remote=?2, upstream_ref=?3,
                    failure_class=NULL, summary=?4, updated_at=unixepoch(),
                    revision=revision+1 WHERE card_id=?5",
                params![
                    tip,
                    remote,
                    upstream,
                    if already_pushed {
                        "Upstream already matched the target tip"
                    } else {
                        "Verified upstream target revision"
                    },
                    card_id
                ],
            )
            .context("record scripted push")?;
        transaction
            .execute(
                "UPDATE kanban_cards SET delivery_operation_stage='pushed',
                    delivery_error=NULL, updated_at=unixepoch() WHERE id=?1",
                [card_id],
            )
            .context("mark scripted push")?;
        transaction
            .execute(
                "INSERT INTO card_events
                    (card_id,created_at,actor,event_type,outcome,summary)
                 VALUES (?1,unixepoch(),'user','scripted_push','success',?2)",
                params![card_id, "Target branch pushed and verified"],
            )
            .context("record scripted push event")?;
        transaction.commit().context("commit scripted push")?;
        Ok(())
    }

    /// Push if needed, then run the project's deployment command. A successful
    /// command completes the card.
    pub fn deploy_scripted_card(&self, card_id: &str) -> Result<()> {
        use crate::workflow::{WorkflowAction, WorkflowActor};

        let (initial_stage, _, _, _) = self.scripted_evidence(card_id)?;
        if !matches!(initial_stage.as_str(), "deployment_failed" | "uncertain") {
            self.push_scripted_card(card_id)?;
        }
        let (stage, path, target_branch, tip) = self.scripted_evidence(card_id)?;
        if stage == "deployed" {
            bail!("The deployment is already complete");
        }
        let detail = self.load_detail(card_id)?;
        let snapshot = self.load_snapshot()?;
        let project = detail
            .card
            .project(&snapshot.projects)
            .ok_or_else(|| anyhow::anyhow!("The card's project is missing"))?;
        let command = project
            .deployment_command
            .clone()
            .filter(|command| !command.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("The project deployment command is empty"))?;
        let connection = self.open_write()?;
        connection
            .execute(
                "UPDATE scripted_delivery_operations SET stage='deploying',
                    attempt=attempt+1, failure_class=NULL, summary='Deployment command started',
                    updated_at=unixepoch(), revision=revision+1 WHERE card_id=?1",
                [card_id],
            )
            .context("mark deployment running")?;
        connection
            .execute(
                "UPDATE kanban_cards SET delivery_operation_stage='deploying',
                    delivery_error=NULL, updated_at=unixepoch() WHERE id=?1",
                [card_id],
            )
            .context("mark card deployment running")?;
        drop(connection);
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let output = std::process::Command::new(&shell)
            .args(["-lic", "eval -- \"$STACKS_DEPLOY_COMMAND\""])
            .current_dir(&path)
            .env("STACKS_DEPLOY_COMMAND", &command)
            .env("STACKS_CARD_ID", card_id)
            .env("STACKS_PROJECT_ID", &project.id)
            .env("STACKS_PROJECT_PATH", &path)
            .env("STACKS_TARGET_BRANCH", &target_branch)
            .output()
            .context("run deployment command")?;
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            self.record_scripted_stage(
                card_id,
                "deployment_failed",
                "deployment_failed",
                "Deployment command failed",
                Some(&if error.is_empty() {
                    "Deployment command failed".to_string()
                } else {
                    error
                }),
            )?;
            bail!("Deployment command failed");
        }
        let transition = crate::workflow::transition(
            &detail.workflow_context,
            WorkflowActor::User,
            WorkflowAction::Deploy,
        )
        .map_err(anyhow::Error::msg)?;
        let mut connection = self.open_write()?;
        let transaction = connection.transaction().context("finish deployment")?;
        transaction
            .execute(
                "UPDATE scripted_delivery_operations SET stage='deployed',
                    deployed_revision=?1, failure_class=NULL,
                    summary='Deployment command succeeded', completed_at=unixepoch(),
                    updated_at=unixepoch(), revision=revision+1 WHERE card_id=?2",
                params![tip, card_id],
            )
            .context("record deployment success")?;
        transaction
            .execute(
                "UPDATE kanban_cards SET status=?1, completion_outcome=?2,
                    delivery_operation_stage=NULL, delivery_error=NULL,
                    workflow_revision=workflow_revision+1, updated_at=unixepoch(),
                    sort_order=(SELECT COALESCE(MAX(sort_order), -1) + 1
                                FROM kanban_cards destination WHERE destination.status=?1)
                 WHERE id=?3",
                params![transition.to, transition.outcome, card_id],
            )
            .context("complete deployed card")?;
        transaction
            .execute(
                "INSERT INTO card_events
                    (card_id,created_at,actor,event_type,outcome,summary)
                 VALUES (?1,unixepoch(),?2,'scripted_deploy','success',
                    'Push verified and deployment command succeeded')",
                params![card_id, WorkflowActor::User],
            )
            .context("record deployment event")?;
        transaction.commit().context("commit deployment")?;
        Ok(())
    }

    /// Accept an uncertain deployment that was actually successful.
    pub fn confirm_scripted_deployed(&self, card_id: &str) -> Result<()> {
        use crate::workflow::{WorkflowAction, WorkflowActor};

        let (stage, _path, _target, tip) = self.scripted_evidence(card_id)?;
        if stage != "uncertain" {
            bail!("The deployment outcome is not uncertain");
        }
        let detail = self.load_detail(card_id)?;
        let transition = crate::workflow::transition(
            &detail.workflow_context,
            WorkflowActor::User,
            WorkflowAction::Deploy,
        )
        .map_err(anyhow::Error::msg)?;
        let mut connection = self.open_write()?;
        let transaction = connection.transaction().context("confirm deployment")?;
        transaction
            .execute(
                "UPDATE scripted_delivery_operations SET stage='deployed',
                    deployed_revision=?1, failure_class=NULL, summary='Deployment confirmed',
                    completed_at=unixepoch(), updated_at=unixepoch(), revision=revision+1
                 WHERE card_id=?2",
                params![tip, card_id],
            )
            .context("record confirmed deployment")?;
        transaction
            .execute(
                "UPDATE kanban_cards SET status=?1, completion_outcome=?2,
                    delivery_operation_stage=NULL, delivery_error=NULL,
                    workflow_revision=workflow_revision+1, updated_at=unixepoch(),
                    sort_order=(SELECT COALESCE(MAX(sort_order), -1) + 1
                                FROM kanban_cards destination WHERE destination.status=?1)
                 WHERE id=?3",
                params![transition.to, transition.outcome, card_id],
            )
            .context("complete confirmed deployment")?;
        transaction
            .execute(
                "INSERT INTO card_events
                    (card_id,created_at,actor,event_type,outcome,summary)
                 VALUES (?1,unixepoch(),?2,'scripted_deploy','success',
                    'Deployment outcome confirmed')",
                params![card_id, WorkflowActor::User],
            )
            .context("record confirmed deployment event")?;
        transaction
            .commit()
            .context("commit confirmed deployment")?;
        Ok(())
    }

    fn scripted_evidence(&self, card_id: &str) -> Result<(String, String, String, String)> {
        let connection = self.open_read_only()?;
        connection
            .query_row(
                "SELECT stage,primary_checkout_path,target_branch,merge_revision
                 FROM scripted_delivery_operations WHERE card_id=?1",
                [card_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .context("read scripted delivery evidence")?
            .ok_or_else(|| anyhow::anyhow!("Merge this Scripted delivery card locally first"))
    }

    fn record_scripted_stage(
        &self,
        card_id: &str,
        stage: &str,
        failure_class: &str,
        summary: &str,
        card_error: Option<&str>,
    ) -> Result<()> {
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction()
            .context("record delivery failure")?;
        transaction
            .execute(
                "UPDATE scripted_delivery_operations SET stage=?1, failure_class=?2,
                    summary=?3, updated_at=unixepoch(), revision=revision+1 WHERE card_id=?4",
                params![stage, failure_class, summary, card_id],
            )
            .context("record delivery stage")?;
        transaction
            .execute(
                "UPDATE kanban_cards SET delivery_operation_stage=?1, delivery_error=?2,
                    updated_at=unixepoch() WHERE id=?3",
                params![stage, card_error, card_id],
            )
            .context("record delivery error")?;
        transaction.commit().context("commit delivery failure")?;
        Ok(())
    }

    /// Remove a merged local card's worktree and branch, then delete its
    /// environment metadata. Refuses dirty/unmerged worktrees.
    pub fn cleanup_local_card(&self, card_id: &str) -> Result<()> {
        use crate::workflow::WorkflowAction;

        let detail = self.load_detail(card_id)?;
        let capability = detail
            .capabilities
            .iter()
            .find(|capability| capability.action == WorkflowAction::Cleanup)
            .ok_or_else(|| anyhow::anyhow!("Clean up is not available for this card"))?;
        if let Some(reason) = &capability.disabled_reason {
            bail!("{reason}");
        }
        let environment = detail
            .card
            .environment
            .clone()
            .ok_or_else(|| anyhow::anyhow!("The card has no environment to clean up"))?;
        let snapshot = self.load_snapshot()?;
        let project = detail
            .card
            .project(&snapshot.projects)
            .ok_or_else(|| anyhow::anyhow!("The card's project is missing"))?;
        let target = project.path.trim_end_matches('/');
        let source = environment.worktree_path.trim_end_matches('/');
        if source == target {
            bail!("Cleanup refuses to remove the project's primary checkout");
        }
        if Path::new(source).exists() {
            let status = git_text(["-C", source, "status", "--porcelain"])?;
            if !status.trim().is_empty() {
                bail!("The worktree is dirty; commit, stash, or discard changes before cleanup");
            }
            let merged = std::process::Command::new("git")
                .args([
                    "-C",
                    target,
                    "merge-base",
                    "--is-ancestor",
                    &environment.branch,
                    environment
                        .target_branch
                        .as_deref()
                        .unwrap_or(project.target_branch.as_str()),
                ])
                .output()
                .context("check branch merge status")?;
            if !merged.status.success() {
                bail!("The card branch is not merged into the target branch");
            }
            let worktrees = git_text(["-C", target, "worktree", "list", "--porcelain"])?;
            if !worktrees.lines().any(|line| {
                line.strip_prefix("worktree ")
                    .is_some_and(|path| path == source)
            }) {
                bail!("The worktree is not registered with the project repository");
            }
            let remove = std::process::Command::new("git")
                .args(["-C", target, "worktree", "remove", source])
                .output()
                .context("remove worktree")?;
            if !remove.status.success() {
                bail!(
                    "git worktree remove failed: {}",
                    String::from_utf8_lossy(&remove.stderr).trim()
                );
            }
            let branch = std::process::Command::new("git")
                .args(["-C", target, "branch", "-d", &environment.branch])
                .output()
                .context("delete merged branch")?;
            if !branch.status.success() {
                bail!(
                    "git branch -d failed: {}",
                    String::from_utf8_lossy(&branch.stderr).trim()
                );
            }
        }
        let mut connection = self.open_write()?;
        let transaction = connection.transaction().context("begin cleanup")?;
        let removed = transaction
            .execute(
                "DELETE FROM card_environments WHERE id=?1 AND card_id=?2",
                params![environment.id, card_id],
            )
            .context("delete card environment")?;
        if removed == 0 {
            bail!("Card environment changed; reload before cleanup");
        }
        transaction
            .execute("DELETE FROM card_pi_lifecycle WHERE card_id=?1", [card_id])
            .context("delete Pi lifecycle")?;
        transaction
            .execute(
                "UPDATE kanban_cards SET workflow_revision=workflow_revision+1,
                    updated_at=unixepoch() WHERE id=?1",
                [card_id],
            )
            .context("bump card after cleanup")?;
        transaction
            .execute(
                "INSERT INTO card_events
                    (card_id,created_at,actor,event_type,outcome,summary)
                 VALUES (?1,unixepoch(),'user','cleanup','success',?2)",
                params![
                    card_id,
                    format!(
                        "Removed worktree {} and branch {}",
                        environment.worktree_path, environment.branch
                    )
                ],
            )
            .context("record cleanup event")?;
        transaction.commit().context("commit cleanup")?;
        Ok(())
    }

    /// Push the card branch and create a GitHub pull request with `gh`.
    pub fn create_pull_request(&self, card_id: &str, feature_environment: bool) -> Result<()> {
        use crate::workflow::WorkflowAction;

        let detail = self.load_detail(card_id)?;
        let capability = detail
            .capabilities
            .iter()
            .find(|capability| capability.action == WorkflowAction::CreatePr)
            .ok_or_else(|| anyhow::anyhow!("Create PR is not available for this card"))?;
        if let Some(reason) = &capability.disabled_reason {
            bail!("{reason}");
        }
        let environment = detail
            .card
            .environment
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("The card has no work environment"))?;
        let snapshot = self.load_snapshot()?;
        let project = detail
            .card
            .project(&snapshot.projects)
            .ok_or_else(|| anyhow::anyhow!("The card's project is missing"))?;
        let source = environment.worktree_path.trim_end_matches('/');
        let status = git_text(["-C", source, "status", "--porcelain"])?;
        if !status.trim().is_empty() {
            bail!("The worktree must be clean before creating a pull request");
        }
        let push = std::process::Command::new("git")
            .args(["-C", source, "push", "-u", "origin", &environment.branch])
            .output()
            .context("push card branch")?;
        if !push.status.success() {
            bail!(
                "git push failed: {}",
                String::from_utf8_lossy(&push.stderr).trim()
            );
        }
        let target_branch = environment
            .target_branch
            .as_deref()
            .unwrap_or(project.target_branch.as_str());
        let body = if detail.content.trim().is_empty() {
            "Created from Stacks.".to_string()
        } else {
            detail.content.clone()
        };
        let mut title = detail.card.title.trim();
        while let Some(rest) = title.strip_prefix("[FE]") {
            title = rest.trim_start();
        }
        let title = if feature_environment {
            format!("[FE] {title}")
        } else {
            title.to_string()
        };
        let create = std::process::Command::new("gh")
            .args([
                "pr",
                "create",
                "--base",
                target_branch,
                "--head",
                &environment.branch,
                "--title",
                &title,
                "--body",
                &body,
            ])
            .current_dir(source)
            .output()
            .context("run gh pr create")?;
        if !create.status.success() {
            bail!(
                "gh pr create failed: {}",
                String::from_utf8_lossy(&create.stderr).trim()
            );
        }
        let url = String::from_utf8_lossy(&create.stdout).trim().to_string();
        let number = url
            .rsplit('/')
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| anyhow::anyhow!("Could not parse pull request number from {url}"))?;
        let (state, draft, ci_status, review_state, has_conflicts, mergeable, head_revision) =
            match std::process::Command::new("gh")
                .args([
                    "pr",
                    "view",
                    &number.to_string(),
                    "--json",
                    "state,isDraft,mergeable,mergeStateStatus,headRefOid,reviewDecision,statusCheckRollup,mergedAt",
                ])
                .current_dir(source)
                .output()
            {
                Ok(output) if output.status.success() => {
                    let value: serde_json::Value =
                        serde_json::from_slice(&output.stdout).unwrap_or_default();
                    let state = if value["mergedAt"].is_null() {
                        value["state"]
                            .as_str()
                            .unwrap_or("OPEN")
                            .to_ascii_lowercase()
                    } else {
                        "merged".to_string()
                    };
                    let checks = value["statusCheckRollup"].as_array();
                    let ci_status = match checks {
                        None => "unknown",
                        Some(values) if values.is_empty() => "no_ci",
                        Some(values)
                            if values.iter().any(|check| {
                                matches!(
                                    check["conclusion"].as_str().or(check["state"].as_str()),
                                    Some("FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT")
                                )
                            }) =>
                        {
                            "failure"
                        }
                        Some(values)
                            if values.iter().any(|check| {
                                matches!(
                                    check["status"].as_str().or(check["state"].as_str()),
                                    Some("QUEUED" | "IN_PROGRESS" | "PENDING" | "EXPECTED")
                                )
                            }) =>
                        {
                            "pending"
                        }
                        Some(_) => "success",
                    };
                    let review_state = match value["reviewDecision"].as_str() {
                        Some("APPROVED") => "approved",
                        Some("CHANGES_REQUESTED") => "changes_requested",
                        _ => "pending",
                    };
                    let has_conflicts = value["mergeable"].as_str() == Some("CONFLICTING")
                        || value["mergeStateStatus"].as_str() == Some("DIRTY");
                    let mergeable = value["mergeable"].as_str() == Some("MERGEABLE");
                    (
                        state,
                        value["isDraft"].as_bool().unwrap_or(false),
                        ci_status,
                        review_state,
                        has_conflicts,
                        mergeable,
                        value["headRefOid"].as_str().map(str::to_string),
                    )
                }
                _ => (
                    "open".to_string(),
                    false,
                    "unknown",
                    "pending",
                    false,
                    false,
                    None,
                ),
            };
        let mut connection = self.open_write()?;
        let transaction = connection.transaction().context("begin create PR")?;
        transaction
            .execute(
                "INSERT INTO card_pull_requests
                    (card_id,repository,number,title,url,state,draft,ci_status,review_state,
                     has_conflicts,mergeable,head_revision,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,unixepoch())
                 ON CONFLICT(card_id) DO UPDATE SET repository=excluded.repository,
                    number=excluded.number, title=excluded.title, url=excluded.url,
                    state=excluded.state, draft=excluded.draft, ci_status=excluded.ci_status,
                    review_state=excluded.review_state, has_conflicts=excluded.has_conflicts,
                    mergeable=excluded.mergeable, head_revision=excluded.head_revision,
                    updated_at=excluded.updated_at",
                params![
                    card_id,
                    "",
                    number as i64,
                    detail.card.title,
                    url,
                    state,
                    draft as i64,
                    ci_status,
                    review_state,
                    has_conflicts as i64,
                    mergeable as i64,
                    head_revision
                ],
            )
            .context("save pull request")?;
        transaction
            .execute(
                "UPDATE kanban_cards SET workflow_revision=workflow_revision+1,
                    feature_environment=?1, updated_at=unixepoch() WHERE id=?2",
                params![feature_environment as i64, card_id],
            )
            .context("bump card after PR creation")?;
        transaction
            .execute(
                "INSERT INTO card_events
                    (card_id,created_at,actor,event_type,outcome,summary)
                 VALUES (?1,unixepoch(),'user','create_pr','success',?2)",
                params![card_id, format!("Created pull request #{number}")],
            )
            .context("record PR creation")?;
        transaction.commit().context("commit PR creation")?;
        Ok(())
    }

    /// Merge an open pull request with GitHub CLI, then apply the Done/Merged
    /// transition. Any CI/review blockers are checked by the capability first.
    pub fn merge_pull_request(&self, card_id: &str) -> Result<()> {
        use crate::workflow::{WorkflowAction, WorkflowActor};

        let detail = self.load_detail(card_id)?;
        let capability = detail
            .capabilities
            .iter()
            .find(|capability| capability.action == WorkflowAction::MergePr)
            .ok_or_else(|| anyhow::anyhow!("Merge PR is not available for this card"))?;
        if let Some(reason) = &capability.disabled_reason {
            bail!("{reason}");
        }
        let pull_request = detail
            .card
            .pull_request
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("The card has no pull request"))?;
        let snapshot = self.load_snapshot()?;
        let project = detail
            .card
            .project(&snapshot.projects)
            .ok_or_else(|| anyhow::anyhow!("The card's project is missing"))?;
        let output = std::process::Command::new("gh")
            .args(["pr", "merge", &pull_request.number.to_string(), "--merge"])
            .current_dir(&project.path)
            .output()
            .context("run gh pr merge")?;
        if !output.status.success() {
            bail!(
                "gh pr merge failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let transition = crate::workflow::transition(
            &detail.workflow_context,
            WorkflowActor::User,
            WorkflowAction::MergePr,
        )
        .map_err(anyhow::Error::msg)?;
        let mut connection = self.open_write()?;
        let transaction = connection.transaction().context("begin merge PR")?;
        transaction
            .execute(
                "UPDATE card_pull_requests SET state='merged', updated_at=unixepoch()
                 WHERE card_id=?1",
                [card_id],
            )
            .context("update pull request state")?;
        let changed = transaction
            .execute(
                "UPDATE kanban_cards SET status=?1, completion_outcome=?2,
                    workflow_revision=workflow_revision+1, updated_at=unixepoch(),
                    sort_order=(SELECT COALESCE(MAX(sort_order), -1) + 1
                                FROM kanban_cards destination WHERE destination.status=?1)
                 WHERE id=?3 AND workflow_revision=?4",
                params![
                    transition.to,
                    transition.outcome,
                    card_id,
                    detail.card.workflow_revision
                ],
            )
            .context("apply merge PR transition")?;
        if changed != 1 {
            bail!("Card changed after the PR merge; reload before trying again");
        }
        transaction
            .execute(
                "INSERT INTO card_events
                    (card_id,created_at,actor,event_type,outcome,from_status,to_status,summary)
                 VALUES (?1,unixepoch(),?2,'merge_pr','success',?3,?4,?5)",
                params![
                    card_id,
                    WorkflowActor::User,
                    transition.from,
                    transition.to,
                    format!("Merged pull request #{}", pull_request.number)
                ],
            )
            .context("record merge PR event")?;
        transaction.commit().context("commit merge PR")?;
        Ok(())
    }

    /// Merge the project target branch into the card worktree. Conflicts are
    /// aborted and left for the Agent tab to resolve.
    pub fn merge_target_into_card(&self, card_id: &str) -> Result<()> {
        use crate::workflow::WorkflowAction;

        let detail = self.load_detail(card_id)?;
        let capability = detail
            .capabilities
            .iter()
            .find(|capability| capability.action == WorkflowAction::MergeTarget)
            .ok_or_else(|| anyhow::anyhow!("Merge target is not available for this card"))?;
        if let Some(reason) = &capability.disabled_reason {
            bail!("{reason}");
        }
        let environment = detail
            .card
            .environment
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("The card has no work environment"))?;
        let snapshot = self.load_snapshot()?;
        let project = detail
            .card
            .project(&snapshot.projects)
            .ok_or_else(|| anyhow::anyhow!("The card's project is missing"))?;
        let source = environment.worktree_path.trim_end_matches('/');
        let source_status = git_text(["-C", source, "status", "--porcelain"])?;
        if !source_status.trim().is_empty() {
            bail!("The worktree must be clean before merging the target branch");
        }
        let target_branch = environment
            .target_branch
            .as_deref()
            .unwrap_or(project.target_branch.as_str());
        let merge = std::process::Command::new("git")
            .args(["-C", source, "merge", "--no-ff", "--no-edit", target_branch])
            .output()
            .context("merge target into card worktree")?;
        if !merge.status.success() {
            let _ = std::process::Command::new("git")
                .args(["-C", source, "merge", "--abort"])
                .output();
            bail!(
                "Merge target produced conflicts and was aborted; resolve them manually in the Agent tab: {}",
                String::from_utf8_lossy(&merge.stderr).trim()
            );
        }
        let mut connection = self.open_write()?;
        let transaction = connection.transaction().context("begin target merge")?;
        transaction
            .execute(
                "UPDATE kanban_cards SET workflow_revision=workflow_revision+1,
                    updated_at=unixepoch() WHERE id=?1",
                [card_id],
            )
            .context("bump card after target merge")?;
        transaction
            .execute(
                "INSERT INTO card_events
                    (card_id,created_at,actor,event_type,outcome,summary)
                 VALUES (?1,unixepoch(),'user','merge_target','success',?2)",
                params![
                    card_id,
                    format!("Merged {target_branch} into {}", environment.branch)
                ],
            )
            .context("record target merge event")?;
        transaction.commit().context("commit target merge")?;
        Ok(())
    }

    /// Merge an approved local card branch into the project target checkout
    /// with an explicit no-ff merge commit, then mark the card Done/Merged.
    pub fn merge_local_card(&self, card_id: &str) -> Result<()> {
        use crate::workflow::{WorkflowAction, WorkflowActor};

        let detail = self.load_detail(card_id)?;
        let capability = detail
            .capabilities
            .iter()
            .find(|capability| capability.action == WorkflowAction::MergeLocal)
            .ok_or_else(|| anyhow::anyhow!("Merge locally is not available for this card"))?;
        if let Some(reason) = &capability.disabled_reason {
            bail!("{reason}");
        }
        let environment = detail
            .card
            .environment
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("The card has no work environment"))?;
        let snapshot = self.load_snapshot()?;
        let project = detail
            .card
            .project(&snapshot.projects)
            .ok_or_else(|| anyhow::anyhow!("The card's project is missing"))?;
        let target = project.path.trim_end_matches('/');
        let source = environment.worktree_path.trim_end_matches('/');
        let status = git_text(["-C", target, "status", "--porcelain"])?;
        if !status.trim().is_empty() {
            bail!("The target checkout must be clean before merging");
        }
        let source_status = git_text(["-C", source, "status", "--porcelain"])?;
        if !source_status.trim().is_empty() {
            bail!("The worktree still has uncommitted changes; commit them before merging");
        }
        let current = git_text(["-C", target, "branch", "--show-current"])?;
        let target_branch = environment
            .target_branch
            .as_deref()
            .unwrap_or(project.target_branch.as_str());
        if current.trim() != target_branch {
            bail!("The project checkout must be on target branch {target_branch}");
        }
        let source_revision_before = git_text(["-C", source, "rev-parse", "HEAD"])?;
        let source_revision_before = source_revision_before.trim().to_string();
        let merge = std::process::Command::new("git")
            .args([
                "-C",
                target,
                "merge",
                "--no-ff",
                "--no-edit",
                &environment.branch,
            ])
            .output()
            .context("run git merge")?;
        if !merge.status.success() {
            let _ = std::process::Command::new("git")
                .args(["-C", target, "merge", "--abort"])
                .output();
            bail!(
                "git merge failed: {}",
                String::from_utf8_lossy(&merge.stderr).trim()
            );
        }
        if project.delivery_workflow == DeliveryWorkflow::ScriptedDelivery {
            let merge_revision = git_text(["-C", target, "rev-parse", "HEAD"])?;
            let merge_revision = merge_revision.trim().to_string();
            let mut connection = self.open_write()?;
            let transaction = connection.transaction().context("begin scripted merge")?;
            transaction
                .execute(
                    "INSERT INTO scripted_delivery_operations
                        (card_id,project_id,environment_id,repository_id,primary_checkout_path,
                         target_branch,source_revision,merge_revision,stage,started_at,updated_at,revision)
                     VALUES (?1,?2,?3,'',?4,?5,?6,?7,'merged',unixepoch(),unixepoch(),1)
                     ON CONFLICT(card_id) DO UPDATE SET
                        project_id=excluded.project_id,environment_id=excluded.environment_id,
                        primary_checkout_path=excluded.primary_checkout_path,
                        target_branch=excluded.target_branch,source_revision=excluded.source_revision,
                        merge_revision=excluded.merge_revision,stage='merged',
                        verified_push_revision=NULL,deployed_revision=NULL,failure_class=NULL,
                        summary=NULL,completed_at=NULL,updated_at=unixepoch(),
                        revision=scripted_delivery_operations.revision+1",
                    params![
                        card_id,
                        project.id,
                        environment.id,
                        target,
                        target_branch,
                        source_revision_before,
                        merge_revision
                    ],
                )
                .context("record scripted merge evidence")?;
            transaction
                .execute(
                    "UPDATE kanban_cards SET workflow_revision=workflow_revision+1,
                        delivery_operation_stage='merged', delivery_error=NULL,
                        updated_at=unixepoch() WHERE id=?1",
                    [card_id],
                )
                .context("mark scripted merge")?;
            transaction
                .execute(
                    "INSERT INTO card_events
                        (card_id,created_at,actor,event_type,outcome,summary)
                     VALUES (?1,unixepoch(),'user','merge_local','success',?2)",
                    params![
                        card_id,
                        format!(
                            "Merged {} into {} with --no-ff",
                            environment.branch, target_branch
                        )
                    ],
                )
                .context("record scripted merge event")?;
            transaction.commit().context("commit scripted merge")?;
            return Ok(());
        }
        let transition = crate::workflow::transition(
            &detail.workflow_context,
            WorkflowActor::User,
            WorkflowAction::MergeLocal,
        )
        .map_err(anyhow::Error::msg)?;
        let mut connection = self.open_write()?;
        let transaction = connection.transaction().context("begin local merge")?;
        let changed = transaction
            .execute(
                "UPDATE kanban_cards SET status=?1, completion_outcome=?2,
                    workflow_revision=workflow_revision+1, updated_at=unixepoch(),
                    sort_order=(SELECT COALESCE(MAX(sort_order), -1) + 1
                                FROM kanban_cards destination WHERE destination.status=?1)
                 WHERE id=?3 AND workflow_revision=?4",
                params![
                    transition.to,
                    transition.outcome,
                    card_id,
                    detail.card.workflow_revision
                ],
            )
            .context("apply local merge transition")?;
        if changed != 1 {
            bail!("Card changed after the merge; reload and inspect the repository");
        }
        transaction
            .execute(
                "INSERT INTO card_events
                    (card_id,created_at,actor,event_type,outcome,from_status,to_status,summary)
                 VALUES (?1,unixepoch(),?2,'merge_local','success',?3,?4,?5)",
                params![
                    card_id,
                    WorkflowActor::User,
                    transition.from,
                    transition.to,
                    format!(
                        "Merged {} into {} with --no-ff",
                        environment.branch, target_branch
                    )
                ],
            )
            .context("record local merge event")?;
        transaction.commit().context("commit local merge")?;
        Ok(())
    }

    /// Finalize approval after the work agent has committed: require a clean
    /// worktree, then apply the Ship transition.
    pub fn approve_local_card(&self, card_id: &str) -> Result<()> {
        use crate::workflow::{WorkflowAction, WorkflowActor};

        let detail = self.load_detail(card_id)?;
        let environment = detail
            .card
            .environment
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("The card has no work environment"))?;
        let capability = detail
            .capabilities
            .iter()
            .find(|capability| capability.action == WorkflowAction::Ship)
            .ok_or_else(|| anyhow::anyhow!("Approve & commit is not available for this card"))?;
        if let Some(reason) = &capability.disabled_reason {
            bail!("{reason}");
        }
        let status = git_text(["-C", &environment.worktree_path, "status", "--porcelain"])?;
        if !status.trim().is_empty() {
            bail!("The worktree still has uncommitted changes; commit them in the Agent tab first");
        }
        let transition = crate::workflow::transition(
            &detail.workflow_context,
            WorkflowActor::User,
            WorkflowAction::Ship,
        )
        .map_err(anyhow::Error::msg)?;
        let mut connection = self.open_write()?;
        let transaction = connection.transaction().context("begin approval")?;
        let changed = transaction
            .execute(
                "UPDATE kanban_cards SET status=?1, completion_outcome=?2,
                    workflow_revision=workflow_revision+1, updated_at=unixepoch(),
                    sort_order=(SELECT COALESCE(MAX(sort_order), -1) + 1
                                FROM kanban_cards destination WHERE destination.status=?1)
                 WHERE id=?3 AND workflow_revision=?4",
                params![
                    transition.to,
                    transition.outcome,
                    card_id,
                    detail.card.workflow_revision
                ],
            )
            .context("apply approval transition")?;
        if changed != 1 {
            bail!("Card changed; reload before approving");
        }
        transaction
            .execute(
                "INSERT INTO card_events
                    (card_id,created_at,actor,event_type,outcome,from_status,to_status,summary)
                 VALUES (?1,unixepoch(),?2,'approve_and_commit','success',?3,?4,NULL)",
                params![card_id, WorkflowActor::User, transition.from, transition.to],
            )
            .context("record approval event")?;
        transaction.commit().context("commit approval")?;
        Ok(())
    }

    /// Create the built-in local Git worktree/branch for a Ready card and attach
    /// it as the card environment. Custom start-work setup commands remain
    /// owned by the Tauri environment engine.
    pub fn start_local_work(&self, card_id: &str, expected_revision: i64) -> Result<()> {
        use crate::workflow::{CardStatus as WorkflowStatus, WorkflowAction, WorkflowActor};

        let detail = self.load_detail(card_id)?;
        if detail.card.status != CardStatus::Ready {
            bail!("The card must be Ready before work can start");
        }
        if detail.card.environment.is_some() {
            bail!("This card already has an environment");
        }
        if detail.card.workflow_revision != expected_revision {
            bail!("Card changed; reload before starting work");
        }
        let start_capability = detail
            .capabilities
            .iter()
            .find(|capability| capability.action == WorkflowAction::StartWork)
            .ok_or_else(|| anyhow::anyhow!("Start work is not available for this card"))?;
        if let Some(reason) = &start_capability.disabled_reason {
            bail!("{reason}");
        }
        let snapshot = self.load_snapshot()?;
        let project = detail
            .card
            .project(&snapshot.projects)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("The card's project is missing"))?;
        if project
            .start_work_command
            .as_deref()
            .is_some_and(|command| !command.trim().is_empty())
        {
            bail!("Custom start-work commands are not available in the native app yet");
        }
        if detail.workflow_context.status != WorkflowStatus::Ready {
            bail!("Card changed; reload before starting work");
        }

        let target = project.path.trim_end_matches('/');
        let branch = local_work_branch(&detail.card.external_id, &detail.card.title);
        let worktree = format!("{target}-card-{}", detail.card.external_id);
        if Path::new(&worktree).exists() {
            bail!("The worktree path already exists: {worktree}");
        }
        let status = git_text(["-C", target, "status", "--porcelain"])?;
        if !status.trim().is_empty() {
            bail!("The project checkout must be clean before starting work");
        }
        let current = git_text(["-C", target, "branch", "--show-current"])?;
        if current.trim() != project.target_branch {
            bail!(
                "The project checkout must be on target branch {}",
                project.target_branch
            );
        }
        let target_revision = git_text(["-C", target, "rev-parse", "HEAD"])?;
        let target_revision = target_revision.trim().to_string();
        let add = std::process::Command::new("git")
            .args(["-C", target, "worktree", "add", "-b", &branch, &worktree])
            .output()
            .context("run git worktree add")?;
        if !add.status.success() {
            bail!(
                "git worktree add failed: {}",
                String::from_utf8_lossy(&add.stderr).trim()
            );
        }
        let cleanup_git = || {
            let _ = std::process::Command::new("git")
                .args(["-C", target, "worktree", "remove", "--force", &worktree])
                .output();
            let _ = std::process::Command::new("git")
                .args(["-C", target, "branch", "-D", &branch])
                .output();
        };
        let source_revision = match git_text(["-C", &worktree, "rev-parse", "HEAD"]) {
            Ok(value) => value.trim().to_string(),
            Err(error) => {
                cleanup_git();
                return Err(error);
            }
        };

        let transition = match crate::workflow::transition(
            &detail.workflow_context,
            WorkflowActor::User,
            WorkflowAction::StartWork,
        ) {
            Ok(transition) => transition,
            Err(error) => {
                cleanup_git();
                bail!(error);
            }
        };
        let environment_id = format!("environment:{card_id}");
        let shell_pane = format!("kanban-card:{card_id}:terminal:shell");
        let layout = serde_json::json!({"kind":"leaf", "terminalId": shell_pane}).to_string();
        let mut connection = self.open_write()?;
        let transaction = connection.transaction().context("begin start work")?;
        let changed = transaction
            .execute(
                "UPDATE kanban_cards SET status=?1, workflow_revision=workflow_revision+1,
                    workspace_id=NULL, updated_at=unixepoch(),
                    sort_order=(SELECT COALESCE(MAX(sort_order), -1) + 1
                                FROM kanban_cards destination WHERE destination.status=?1)
                 WHERE id=?2 AND workflow_revision=?3 AND status='ready'",
                params![transition.to, card_id, expected_revision],
            )
            .context("apply Start work transition")?;
        if changed != 1 {
            cleanup_git();
            bail!("Card changed; reload before trying again");
        }
        let write_result = (|| -> Result<()> {
            transaction
                .execute(
                    "INSERT INTO card_environments
                        (id,card_id,project_id,worktree_path,branch,repository_id,
                         target_checkout_path,target_branch,source_revision,target_revision,
                         lifecycle_state,revision,created_at,updated_at)
                     VALUES (?1,?2,?3,?4,?5,NULL,?6,?7,?8,?9,'ready',1,unixepoch(),unixepoch())",
                    params![
                        environment_id,
                        card_id,
                        project.id,
                        worktree,
                        branch,
                        target,
                        project.target_branch,
                        source_revision,
                        target_revision
                    ],
                )
                .context("insert card environment")?;
            transaction
                .execute(
                    "INSERT OR IGNORE INTO card_panes
                        (id,environment_id,role,kind,sort_order)
                     VALUES (?1,?2,'shell','terminal',0)",
                    params![shell_pane, environment_id],
                )
                .context("insert shell pane")?;
            for (index, thread) in ["planning", "work"].into_iter().enumerate() {
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO card_panes
                            (id,environment_id,role,kind,sort_order)
                         VALUES (?1,?2,?3,'pi',?4)",
                        params![
                            format!("kanban-card:{card_id}:{thread}"),
                            environment_id,
                            thread,
                            index as i64 + 1
                        ],
                    )
                    .context("insert Pi pane")?;
            }
            transaction
                .execute(
                    "INSERT OR IGNORE INTO card_layouts
                        (environment_id,split_layout,focused_pane_id,updated_at)
                     VALUES (?1,?2,?3,unixepoch())",
                    params![environment_id, layout, shell_pane],
                )
                .context("insert card layout")?;
            transaction
                .execute(
                    "INSERT INTO card_events
                        (card_id,created_at,actor,event_type,outcome,from_status,to_status,summary)
                     VALUES (?1,unixepoch(),?2,'environment_start','success',?3,?4,?5)",
                    params![
                        card_id,
                        WorkflowActor::User,
                        transition.from,
                        transition.to,
                        format!("Created source worktree {worktree} on {branch}")
                    ],
                )
                .context("record start work event")?;
            transaction.commit().context("commit start work")
        })();
        if let Err(error) = write_result {
            cleanup_git();
            return Err(error);
        }
        Ok(())
    }

    /// Apply a native Pi lifecycle transition for a card thread. Returns the
    /// new status when the transition changed the card.
    pub fn apply_agent_lifecycle(
        &self,
        card_id: &str,
        thread: &str,
        intent: &str,
    ) -> Result<Option<CardStatus>> {
        use crate::workflow::{PiLifecycleIntent, PiThread, WorkflowActor};

        let thread = thread.parse::<PiThread>().map_err(anyhow::Error::msg)?;
        let intent = intent
            .parse::<PiLifecycleIntent>()
            .map_err(anyhow::Error::msg)?;
        let detail = self.load_detail(card_id)?;
        let Some(transition) =
            crate::workflow::lifecycle_transition(&detail.workflow_context, thread, intent)
        else {
            return Ok(None);
        };
        if transition.from == transition.to {
            return Ok(None);
        }
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction()
            .context("begin Pi lifecycle transition")?;
        let changed = transaction
            .execute(
                "UPDATE kanban_cards SET status=?1, workflow_revision=workflow_revision+1,
                    updated_at=unixepoch(),
                    sort_order=(SELECT COALESCE(MAX(sort_order), -1) + 1
                                FROM kanban_cards destination WHERE destination.status=?1)
                 WHERE id=?2 AND workflow_revision=?3",
                params![transition.to, card_id, detail.card.workflow_revision],
            )
            .context("apply Pi lifecycle transition")?;
        if changed != 1 {
            bail!("Card changed; lifecycle event was not applied");
        }
        transaction
            .execute(
                "INSERT INTO card_events
                    (card_id,created_at,actor,event_type,outcome,from_status,to_status,summary)
                 VALUES (?1,unixepoch(),?2,?3,'success',?4,?5,NULL)",
                params![
                    card_id,
                    WorkflowActor::Agent,
                    intent.as_str(),
                    transition.from,
                    transition.to
                ],
            )
            .context("record Pi lifecycle event")?;
        transaction.commit().context("commit Pi lifecycle event")?;
        Ok(Some(match transition.to {
            crate::workflow::CardStatus::NeedsRefinement => CardStatus::NeedsRefinement,
            crate::workflow::CardStatus::Refining => CardStatus::Refining,
            crate::workflow::CardStatus::NeedsRefinementInput => CardStatus::NeedsRefinementInput,
            crate::workflow::CardStatus::Ready => CardStatus::Ready,
            crate::workflow::CardStatus::AgentWorking => CardStatus::AgentWorking,
            crate::workflow::CardStatus::NeedsHuman => CardStatus::NeedsHuman,
            crate::workflow::CardStatus::Approved => CardStatus::Approved,
            crate::workflow::CardStatus::Done => CardStatus::Done,
        }))
    }

    /// Finish the local portion of a closed card's runtime cleanup. The native
    /// host stops its own services/Pi sessions first, then records the outcome
    /// with the same statuses and event contract as the Tauri cleanup engine.
    pub fn complete_local_runtime_cleanup(&self, card_id: &str, errors: &[String]) -> Result<()> {
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction()
            .context("begin runtime cleanup result")?;
        let (status, event_outcome, error, summary) = if errors.is_empty() {
            (
                "complete",
                "success",
                None::<String>,
                "Card runtime cleanup completed".to_string(),
            )
        } else {
            (
                "failed",
                "failure",
                Some(errors.join("\n")),
                format!(
                    "Card runtime cleanup failed for {} resource(s)",
                    errors.len()
                ),
            )
        };
        let changed = transaction
            .execute(
                "UPDATE kanban_cards SET runtime_cleanup_status=?1, runtime_cleanup_error=?2,
                    updated_at=unixepoch() WHERE id=?3 AND status='done'",
                params![status, error, card_id],
            )
            .context("record runtime cleanup status")?;
        if changed == 1 {
            transaction
                .execute(
                    "INSERT INTO card_events
                        (card_id,created_at,actor,event_type,outcome,summary,error_code,error_detail)
                     VALUES (?1,unixepoch(),'system','runtime_cleanup',?2,?3,?4,?5)",
                    params![
                        card_id,
                        event_outcome,
                        summary,
                        if errors.is_empty() {
                            None
                        } else {
                            Some("runtime_cleanup_failed")
                        },
                        error
                    ],
                )
                .context("record runtime cleanup event")?;
        }
        transaction
            .commit()
            .context("commit runtime cleanup result")?;
        Ok(())
    }

    /// Apply a backlog drag reorder using the same conflict contract as the
    /// shipped `kanban_reorder_cards` command. `expected` and `card_ids` are the
    /// complete canonical `needs_refinement` lane, not just the filtered rows.
    pub fn reorder_backlog(&self, expected: &[String], card_ids: &[String]) -> Result<()> {
        reject_duplicates("expected_card_ids", expected)?;
        reject_duplicates("card_ids", card_ids)?;
        let expected_set = expected.iter().collect::<HashSet<_>>();
        let desired_set = card_ids.iter().collect::<HashSet<_>>();
        if expected_set != desired_set {
            bail!("Reorder expected_card_ids and card_ids must contain exactly the same IDs");
        }

        let mut connection = self.open_writable()?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .context("start backlog reorder transaction")?;
        let current_order = lane_order(&transaction, CardStatus::NeedsRefinement)?;
        let current_set = current_order.iter().collect::<HashSet<_>>();
        if expected_set != current_set {
            let missing = current_order
                .iter()
                .filter(|id| !expected_set.contains(id))
                .cloned()
                .collect::<Vec<_>>();
            bail!(
                "Reorder payload is incomplete for lane needs_refinement; missing IDs: {}",
                missing.join(", ")
            );
        }
        // An exact retry is idempotent even when the caller's expectation is stale.
        if current_order == card_ids {
            transaction.commit().context("commit idempotent reorder")?;
            return Ok(());
        }
        if current_order != expected {
            bail!("{REORDER_CONFLICT_CODE}: Lane order changed; reload the list and retry");
        }
        let now = unix_timestamp();
        for (index, id) in card_ids.iter().enumerate() {
            transaction
                .execute(
                    "UPDATE kanban_cards SET sort_order = ?1, updated_at = ?2 WHERE id = ?3",
                    params![index as i64, now, id],
                )
                .with_context(|| format!("update backlog order for {id}"))?;
        }
        transaction.commit().context("commit backlog reorder")?;
        Ok(())
    }

    /// Rebuild the complete visible backlog order after a filtered drag.
    pub fn filtered_backlog_order(
        &self,
        snapshot: &CardSnapshot,
        visible_ordered_ids: &[String],
    ) -> Vec<String> {
        merge_filtered_lane_order(
            &snapshot.cards,
            CardStatus::NeedsRefinement,
            visible_ordered_ids,
        )
    }

    /// Create a local draft card in the same lane the GUI's New Card uses.
    /// Create a card using the project's provider when configured. Local
    /// projects use the existing local sequence; Superthread projects create
    /// the remote card and then import it through the normal sync path.
    pub fn create_project_card(
        &self,
        project_id: &str,
        title: &str,
        content: &str,
        service: &crate::superthread::SuperthreadService,
    ) -> Result<String> {
        let read_connection = self.open_read_only()?;
        let source: Option<String> = read_connection
            .query_row(
                "SELECT COALESCE(kanban_source,'local') FROM projects WHERE id=?1",
                [project_id],
                |row| row.get(0),
            )
            .optional()
            .context("read project source")?;
        let source = source.ok_or_else(|| anyhow::anyhow!("The project was not found"))?;
        if source != "superthread" {
            return self.create_card(project_id, title, content);
        }
        let config = read_connection
            .query_row(
                "SELECT COALESCE(superthread_board_id,''),
                        COALESCE(superthread_default_incoming_column_id,''),
                        superthread_workspace_slug,
                        COALESCE(superthread_api_token_env_var,'ST_TOKEN'),
                        superthread_binding_id
                 FROM projects WHERE id=?1",
                [project_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .optional()
            .context("read project provider configuration")?
            .ok_or_else(|| anyhow::anyhow!("The project was not found"))?;
        drop(read_connection);
        let (board_id, list_id, workspace_slug, token_env, binding_id) = config;
        if board_id.trim().is_empty() || list_id.trim().is_empty() {
            bail!("Configure the Superthread board and incoming column first");
        }
        service
            .configure_token_env(&token_env)
            .map_err(anyhow::Error::msg)?;
        let created = service
            .create_card(
                &board_id,
                &list_id,
                title,
                content,
                workspace_slug.as_deref(),
            )
            .map_err(anyhow::Error::msg)?;
        self.sync_superthread_project(project_id, service)?;
        let connection = self.open_read_only()?;
        let local_id: Option<String> = connection
            .query_row(
                "SELECT id FROM kanban_cards WHERE binding_id=?1 AND external_id=?2",
                params![binding_id, created.id],
                |row| row.get(0),
            )
            .optional()
            .context("resolve created Superthread card")?;
        local_id.ok_or_else(|| anyhow::anyhow!("The created Superthread card was not imported"))
    }

    pub fn create_card(&self, project_id: &str, title: &str, content: &str) -> Result<String> {
        let title = title.trim();
        if title.is_empty() {
            bail!("Card title is required");
        }
        let snapshot = self.load_snapshot()?;
        let project = snapshot
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .ok_or_else(|| anyhow::anyhow!("The project was not found"))?;
        if project
            .kanban_source
            .as_deref()
            .is_some_and(|source| source == "superthread")
        {
            bail!("Cards can only be created for a local Kanban project");
        }
        let mut connection = self.open_write()?;
        let transaction = connection.transaction().context("begin create card")?;
        let number: i64 = transaction
            .query_row(
                "INSERT INTO kanban_project_sequences (project_id, next_number) VALUES (?1, 2)
                 ON CONFLICT(project_id) DO UPDATE SET next_number = next_number + 1
                 RETURNING next_number - 1",
                [project_id],
                |row| row.get(0),
            )
            .context("allocate card number")?;
        let id = format!("local:{}", uuid::Uuid::new_v4());
        transaction
            .execute(
                "INSERT INTO kanban_cards
                 (id, external_provider, external_id, title, content, board_id, board_title,
                  status, project_id, created_at, updated_at, sort_order, in_scope)
                 VALUES (?1, 'local:' || ?5, ?2, ?3, ?4, ?5, ?6, 'needs_refinement', ?5,
                         unixepoch(), unixepoch(),
                         (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards
                          WHERE status = 'needs_refinement'), 1)",
                params![
                    id,
                    number.to_string(),
                    title,
                    content.trim(),
                    project_id,
                    project.name.trim()
                ],
            )
            .context("insert local card")?;
        transaction
            .execute(
                "INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,summary)
                 VALUES (?1,unixepoch(),'user','create_card','success','Created from stacks-tui')",
                [&id],
            )
            .ok();
        transaction.commit().context("commit create card")?;
        Ok(id)
    }

    /// Edit a local card's title/description. Revision guards keep a stale TUI
    /// from clobbering a newer GUI edit.
    pub fn update_card(
        &self,
        card_id: &str,
        expected_revision: i64,
        title: Option<&str>,
        content: Option<&str>,
    ) -> Result<()> {
        if title.is_none() && content.is_none() {
            bail!("A title or description is required");
        }
        if title.is_some_and(|value| value.trim().is_empty()) {
            bail!("Card title cannot be empty");
        }
        let mut connection = self.open_write()?;
        let transaction = connection.transaction().context("begin update card")?;
        let changed = transaction
            .execute(
                "UPDATE kanban_cards SET title=COALESCE(?1,title), content=COALESCE(?2,content),
                    updated_at=unixepoch()
                 WHERE id=?3 AND external_provider LIKE 'local:%' AND hierarchy_finalized=0
                   AND workflow_revision=?4",
                params![
                    title.map(str::trim),
                    content.map(str::trim),
                    card_id,
                    expected_revision
                ],
            )
            .context("update local card")?;
        if changed != 1 {
            bail!("Card changed; reload before trying again");
        }
        transaction.commit().context("commit update card")?;
        Ok(())
    }

    /// Finish refinement from the native client: save the final plan and move
    /// the card to Ready. Child breakdown approval is included so Pi's
    /// `finish_refinement` tool works unchanged against a native host.
    /// Finish refinement for a provider parent whose children were already
    /// imported by sync. The provider children are approved as-is.
    /// Validate the authoritative Superthread parent/child hierarchy before
    /// approving a provider refinement, then persist the local refinement.
    pub fn finish_superthread_refinement(
        &self,
        card_id: &str,
        expected_revision: i64,
        content: &str,
        service: &crate::superthread::SuperthreadService,
    ) -> Result<()> {
        let read_connection = self.open_read_only()?;
        let row = read_connection
            .query_row(
                "SELECT c.external_id,c.project_id,c.workflow_revision,
                        COALESCE(p.kanban_source,'local'),p.superthread_workspace_slug,
                        COALESCE(p.superthread_board_id,''),
                        COALESCE(p.superthread_incoming_columns,'[]'),
                        COALESCE(p.superthread_api_token_env_var,'ST_TOKEN'),
                        c.binding_id
                 FROM kanban_cards c JOIN projects p ON p.id=c.project_id WHERE c.id=?1",
                [card_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, Option<String>>(8)?,
                    ))
                },
            )
            .optional()
            .context("read Superthread refinement context")?
            .ok_or_else(|| anyhow::anyhow!("The card was not found"))?;
        drop(read_connection);
        let (
            external_id,
            project_id,
            revision,
            source,
            workspace_slug,
            board_id,
            incoming_json,
            token_env,
            binding_id,
        ) = row;
        if source != "superthread" {
            bail!("This card does not belong to a Superthread project");
        }
        if revision != expected_revision {
            bail!("Card changed; reload before finishing refinement");
        }
        let incoming = serde_json::from_str::<Vec<serde_json::Value>>(&incoming_json)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|column| {
                column
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
            .collect::<std::collections::HashSet<_>>();
        service
            .configure_token_env(&token_env)
            .map_err(anyhow::Error::msg)?;
        let parent = service
            .card(&external_id, workspace_slug.as_deref())
            .map_err(anyhow::Error::msg)?;
        if parent.id != external_id || parent.board_id != board_id {
            bail!("Superthread returned a different parent card or board");
        }
        if !incoming.contains(parent.list_id.trim()) {
            bail!("The Superthread parent is no longer in a configured Incoming column");
        }
        let child_count = parent.total_task_children.ok_or_else(|| {
            anyhow::anyhow!("Superthread parent did not report total_task_children")
        })?;
        let child_ids = parent
            .task_children
            .as_ref()
            .map(|children| {
                children
                    .iter()
                    .map(|child| child.task_id.trim().to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if child_ids.len() as u64 != child_count {
            bail!("Superthread parent hierarchy is incomplete; retry");
        }
        let mut children = Vec::with_capacity(child_ids.len());
        for child_id in &child_ids {
            let child = service
                .card(child_id, workspace_slug.as_deref())
                .map_err(anyhow::Error::msg)?;
            if child.task_parent.as_ref().map(|parent| parent.id.trim())
                != Some(external_id.as_str())
                || child.board_id != board_id
                || !incoming.contains(child.list_id.trim())
            {
                bail!("Superthread child {child_id} is no longer in the configured hierarchy");
            }
            children.push(child);
        }
        self.sync_superthread_project(&project_id, service)?;
        let connection = self.open_read_only()?;
        let mut statement = connection
            .prepare("SELECT external_id FROM kanban_cards WHERE binding_id=?1 AND parent_id=?2")?;
        let local_children = statement
            .query_map(params![binding_id, card_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<std::collections::HashSet<_>>>()
            .context("read local provider children")?;
        let provider_children = child_ids
            .iter()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        if local_children != provider_children {
            bail!("Local provider children changed during validation; retry finish_refinement");
        }
        drop(statement);
        drop(connection);
        self.finish_refinement_with_linked_children(card_id, expected_revision, content)
    }

    pub fn finish_refinement_with_linked_children(
        &self,
        card_id: &str,
        expected_revision: i64,
        content: &str,
    ) -> Result<()> {
        let connection = self.open_read_only()?;
        let mut statement = connection
            .prepare("SELECT id,title,content FROM kanban_cards WHERE parent_id=?1 ORDER BY id")?;
        let children = statement
            .query_map([card_id], |row| {
                Ok(ApprovedChildSpec {
                    id: Some(row.get::<_, String>(0)?),
                    title: row.get::<_, String>(1)?,
                    content: row.get::<_, String>(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("read linked provider children")?;
        drop(statement);
        drop(connection);
        if children.is_empty() {
            self.finish_refinement(card_id, expected_revision, content)
        } else {
            self.finish_refinement_with_children(
                card_id,
                expected_revision,
                None,
                content,
                Some(&children),
            )
        }
    }

    pub fn finish_refinement(
        &self,
        card_id: &str,
        expected_revision: i64,
        content: &str,
    ) -> Result<()> {
        self.finish_refinement_with_children(card_id, expected_revision, None, content, None)
    }

    pub fn finish_refinement_with_children(
        &self,
        card_id: &str,
        expected_revision: i64,
        title: Option<&str>,
        content: &str,
        children: Option<&[ApprovedChildSpec]>,
    ) -> Result<()> {
        let content = content.trim();
        if content.is_empty() {
            bail!("A final card description is required before finishing refinement");
        }
        if title.is_some_and(|title| title.trim().is_empty()) {
            bail!("Card title cannot be empty");
        }
        let detail = self.load_detail(card_id)?;
        if detail.card.workflow_revision != expected_revision {
            bail!("Card changed; reload before trying again");
        }
        if detail.card.hierarchy_finalized {
            bail!("A finalized aggregate parent has no workflow");
        }
        let children = children.filter(|items| !items.is_empty());
        if detail.card.parent.is_some() && children.is_some() {
            bail!("A child card cannot be finalized as a parent");
        }
        let existing = {
            let connection = self.open_read_only()?;
            let mut statement = connection
                .prepare("SELECT id FROM kanban_cards WHERE parent_id=?1 ORDER BY id")
                .context("read linked children")?;
            statement
                .query_map([card_id], |row| row.get::<_, String>(0))
                .context("read linked children")?
                .collect::<rusqlite::Result<Vec<_>>>()
                .context("read linked children")?
        };
        if !existing.is_empty() && children.is_none() {
            bail!("The approved breakdown must include every existing linked child");
        }

        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction()
            .context("begin finish refinement")?;
        let project_id: String = transaction
            .query_row(
                "SELECT project_id FROM kanban_cards WHERE id=?1",
                [card_id],
                |row| row.get(0),
            )
            .context("read card project")?;

        if let Some(children) = children {
            let supplied = children
                .iter()
                .filter_map(|spec| spec.id.clone())
                .collect::<Vec<_>>();
            let unique = supplied.iter().collect::<HashSet<_>>().len() == supplied.len();
            let mut expected = existing.clone();
            expected.sort();
            let mut received = supplied.clone();
            received.sort();
            if !unique || expected != received {
                bail!(
                    "The approved breakdown must include every existing linked child and no unrelated cards"
                );
            }
            for spec in children {
                let child_title = spec.title.trim();
                let child_content = spec.content.trim();
                if child_title.is_empty() || child_content.is_empty() {
                    bail!("Every approved child needs a title and a self-contained brief");
                }
                let child_id = if let Some(child_id) = spec.id.as_deref() {
                    let (child_project, child_parent, status, provider): (
                        Option<String>,
                        Option<String>,
                        String,
                        String,
                    ) = transaction
                        .query_row(
                            "SELECT project_id, parent_id, status, external_provider
                             FROM kanban_cards WHERE id=?1",
                            [child_id],
                            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                        )
                        .optional()
                        .context("read existing child")?
                        .ok_or_else(|| {
                            anyhow::anyhow!("An approved existing child was not found")
                        })?;
                    if child_project.as_deref() != Some(project_id.as_str())
                        || child_parent.as_deref() != Some(card_id)
                        || !(provider.starts_with("local:") || provider == "superthread")
                        || status != "needs_refinement"
                    {
                        bail!(
                            "Existing children must be linked local Needs refinement cards in the parent's project"
                        );
                    }
                    transaction
                        .execute(
                            "UPDATE kanban_cards SET title=?1, content=?2 WHERE id=?3",
                            params![child_title, child_content, child_id],
                        )
                        .context("update child brief")?;
                    child_id.to_string()
                } else {
                    let number: i64 = transaction
                        .query_row(
                            "INSERT INTO kanban_project_sequences (project_id, next_number) VALUES (?1, 2)
                             ON CONFLICT(project_id) DO UPDATE SET next_number = next_number + 1
                             RETURNING next_number - 1",
                            [&project_id],
                            |row| row.get(0),
                        )
                        .context("allocate child number")?;
                    let project_name: String = transaction
                        .query_row(
                            "SELECT name FROM projects WHERE id=?1",
                            [&project_id],
                            |row| row.get(0),
                        )
                        .context("read project name")?;
                    let child_id = format!("local:{}", uuid::Uuid::new_v4());
                    transaction
                        .execute(
                            "INSERT INTO kanban_cards
                             (id, external_provider, external_id, title, content, board_id,
                              board_title, status, project_id, parent_id, created_at, updated_at,
                              sort_order, in_scope)
                             VALUES (?1, 'local:' || ?2, ?3, ?4, ?5, ?2, ?6, 'needs_refinement',
                                     ?2, ?7, unixepoch(), unixepoch(),
                                     (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards
                                      WHERE status='needs_refinement'), 1)",
                            params![
                                child_id,
                                project_id,
                                number.to_string(),
                                child_title,
                                child_content,
                                project_name,
                                card_id
                            ],
                        )
                        .context("insert approved child")?;
                    child_id
                };
                mark_card_ready(
                    &transaction,
                    &child_id,
                    "finish_refinement",
                    Some("Approved as part of card breakdown"),
                    false,
                )?;
            }
        }

        transaction
            .execute(
                "UPDATE kanban_cards SET title=COALESCE(?1,title), content=?2, updated_at=unixepoch()
                 WHERE id=?3",
                params![title.map(str::trim), content, card_id],
            )
            .context("save final brief")?;
        mark_card_ready(
            &transaction,
            card_id,
            "finish_refinement",
            if children.is_some() {
                Some("Approved card breakdown")
            } else {
                Some("Plan saved from stacks-tui")
            },
            children.is_some(),
        )?;
        transaction.commit().context("commit finish refinement")?;
        Ok(())
    }

    /// Move a Superthread-backed card to its configured in-progress/done
    /// column after a local workflow transition. Returns false for local cards
    /// or cards that are already in the target column.
    pub fn superthread_project_config(&self, project_id: &str) -> Result<SuperthreadProjectConfig> {
        let connection = self.open_read_only()?;
        let row = connection
            .query_row(
                "SELECT COALESCE(kanban_source,'local'), COALESCE(superthread_spaces,''),
                        COALESCE(superthread_api_token_env_var,'ST_TOKEN'),
                        superthread_workspace_slug, COALESCE(superthread_board_id,''),
                        COALESCE(superthread_incoming_columns,'[]'),
                        COALESCE(superthread_default_incoming_column_id,''),
                        COALESCE(superthread_in_progress_column_id,''),
                        COALESCE(superthread_done_column_id,'')
                 FROM projects WHERE id=?1",
                [project_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                    ))
                },
            )
            .optional()
            .context("read Superthread configuration")?
            .ok_or_else(|| anyhow::anyhow!("The project was not found"))?;
        let incoming_columns = serde_json::from_str::<Vec<serde_json::Value>>(&row.5)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|column| {
                column
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
            .collect::<Vec<_>>();
        Ok(SuperthreadProjectConfig {
            enabled: row.0 == "superthread",
            spaces: row.1,
            api_token_env_var: row.2,
            workspace_slug: row.3,
            board_id: row.4,
            incoming_column_ids: incoming_columns,
            default_incoming_column_id: row.6,
            in_progress_column_id: row.7,
            done_column_id: row.8,
        })
    }

    pub fn configure_superthread_project(
        &self,
        project_id: &str,
        config: &SuperthreadProjectConfig,
        service: &crate::superthread::SuperthreadService,
    ) -> Result<()> {
        let mut connection = self.open_writable()?;
        if !config.enabled {
            connection
                .execute(
                    "UPDATE projects SET kanban_source='local', superthread_binding_id=NULL WHERE id=?1",
                    [project_id],
                )
                .context("disable Superthread project")?;
            return Ok(());
        }
        let draft = crate::superthread::SuperthreadMappingDraft {
            spaces: config.spaces.clone(),
            board_id: config.board_id.clone(),
            incoming_column_ids: config.incoming_column_ids.clone(),
            default_incoming_column_id: config.default_incoming_column_id.clone(),
            in_progress_column_id: config.in_progress_column_id.clone(),
            done_column_id: config.done_column_id.clone(),
            api_token_env_var: config.api_token_env_var.clone(),
        };
        let tested = service.test_mapping(&draft).map_err(anyhow::Error::msg)?;
        let workspace_slug = config
            .workspace_slug
            .clone()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| tested.workspace_slug.clone());
        let transaction = connection
            .transaction()
            .context("begin Superthread configuration")?;
        let current_binding: Option<String> = transaction
            .query_row(
                "SELECT superthread_binding_id FROM projects WHERE id=?1",
                [project_id],
                |row| row.get(0),
            )
            .optional()
            .context("read project binding")?
            .flatten();
        let owner: Option<String> = transaction
            .query_row(
                "SELECT p.name FROM superthread_bindings b JOIN projects p ON p.id=b.project_id
                 WHERE b.workspace_id=?1 AND b.space_id=?2 AND b.board_id=?3 AND b.project_id<>?4 LIMIT 1",
                params![
                    tested.workspace_id,
                    tested.space_id,
                    tested.board_id,
                    project_id
                ],
                |row| row.get(0),
            )
            .optional()
            .context("check Superthread binding ownership")?;
        if let Some(owner) = owner {
            bail!("That Superthread workspace, space, and board are already owned by {owner}");
        }
        let binding_id = current_binding.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        transaction
            .execute(
                "UPDATE superthread_bindings SET state='retired', updated_at=unixepoch()
                 WHERE project_id=?1 AND state='active' AND id<>?2",
                params![project_id, binding_id],
            )
            .context("retire previous Superthread binding")?;
        transaction
            .execute(
                "INSERT INTO superthread_bindings
                 (id,project_id,workspace_id,workspace_name,space_id,space_name,board_id,board_name,
                  token_env_var,app_slug,validation_revision,validated_at,state,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,unixepoch(),'active',unixepoch(),unixepoch())
                 ON CONFLICT(id) DO UPDATE SET
                   workspace_id=excluded.workspace_id, workspace_name=excluded.workspace_name,
                   space_id=excluded.space_id, space_name=excluded.space_name,
                   board_id=excluded.board_id, board_name=excluded.board_name,
                   token_env_var=excluded.token_env_var, app_slug=excluded.app_slug,
                   validation_revision=superthread_bindings.validation_revision+1,
                   validated_at=unixepoch(), state='active', updated_at=unixepoch()",
                params![
                    binding_id,
                    project_id,
                    tested.workspace_id,
                    tested.workspace_name,
                    tested.space_id,
                    tested.space_name,
                    tested.board_id,
                    tested.board_name,
                    config.api_token_env_var.trim(),
                    workspace_slug,
                ],
            )
            .context("save Superthread binding")?;
        let incoming = serde_json::to_string(&tested.incoming_columns)
            .context("serialize incoming columns")?;
        transaction
            .execute(
                "UPDATE projects SET kanban_source='superthread', superthread_binding_id=?1,
                    superthread_spaces=?2, superthread_workspace_slug=?3,
                    superthread_workspace_id=?4, superthread_workspace_name=?5,
                    superthread_space_id=?6, superthread_space_name=?7,
                    superthread_board_id=?8, superthread_board_name=?9,
                    superthread_incoming_columns=?10, superthread_default_incoming_column_id=?11,
                    superthread_in_progress_column_id=?12, superthread_in_progress_column_name=?13,
                    superthread_done_column_id=?14, superthread_done_column_name=?15,
                    superthread_api_token_env_var=?16,
                    superthread_mapping_revision=superthread_mapping_revision+1
                 WHERE id=?17",
                params![
                    binding_id,
                    config.spaces.trim(),
                    workspace_slug,
                    tested.workspace_id,
                    tested.workspace_name,
                    tested.space_id,
                    tested.space_name,
                    tested.board_id,
                    tested.board_name,
                    incoming,
                    tested.default_incoming_column_id,
                    tested.in_progress_column_id,
                    tested.in_progress_column_name,
                    tested.done_column_id,
                    tested.done_column_name,
                    config.api_token_env_var.trim(),
                    project_id,
                ],
            )
            .context("save Superthread project mapping")?;
        transaction
            .execute(
                "UPDATE kanban_cards SET binding_id=?1
                 WHERE project_id=?2 AND external_provider='superthread' AND binding_id IS NULL",
                params![binding_id, project_id],
            )
            .context("adopt Superthread cards")?;
        transaction
            .commit()
            .context("commit Superthread configuration")?;
        Ok(())
    }

    pub fn sync_superthread_card_status(
        &self,
        card_id: &str,
        service: &crate::superthread::SuperthreadService,
    ) -> Result<bool> {
        let read_connection = self.open_read_only()?;
        let row = read_connection
            .query_row(
                "SELECT c.external_provider, c.external_id, c.board_id, c.list_id, c.status,
                        COALESCE(p.superthread_api_token_env_var,'ST_TOKEN'),
                        COALESCE(p.superthread_in_progress_column_id,''),
                        COALESCE(p.superthread_in_progress_column_name,''),
                        COALESCE(p.superthread_done_column_id,''),
                        COALESCE(p.superthread_done_column_name,'')
                 FROM kanban_cards c JOIN projects p ON p.id=c.project_id
                 WHERE c.id=?1",
                [card_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                    ))
                },
            )
            .optional()
            .context("read Superthread card state")?;
        drop(read_connection);
        let Some((
            provider,
            external_id,
            board_id,
            list_id,
            status,
            token_env,
            in_progress_id,
            in_progress_name,
            done_id,
            done_name,
        )) = row
        else {
            return Ok(false);
        };
        if provider != "superthread" || board_id.trim().is_empty() {
            return Ok(false);
        }
        let (target_id, target_name) = if status == "agent_working" {
            (in_progress_id, in_progress_name)
        } else if status == "done" {
            (done_id, done_name)
        } else {
            return Ok(false);
        };
        if target_id.trim().is_empty() || target_id == list_id {
            return Ok(false);
        }
        service
            .configure_token_env(&token_env)
            .map_err(anyhow::Error::msg)?;
        service
            .move_card(&external_id, &board_id, &target_id)
            .map_err(anyhow::Error::msg)?;
        let connection = self.open_writable()?;
        connection
            .execute(
                "UPDATE kanban_cards SET list_id=?1, list_title=?2, updated_at=unixepoch() WHERE id=?3",
                params![target_id, target_name, card_id],
            )
            .context("record Superthread card move")?;
        Ok(true)
    }

    /// Import/update cards from the project's configured Superthread board.
    /// Local workflow state is preserved for existing cards; new cards enter
    /// Needs refinement. Provider deletions are intentionally not turned into
    /// local deletes here.
    pub fn sync_superthread_project(
        &self,
        project_id: &str,
        service: &crate::superthread::SuperthreadService,
    ) -> Result<usize> {
        let read_connection = self.open_read_only()?;
        let config = read_connection
            .query_row(
                "SELECT COALESCE(kanban_source,'local'), COALESCE(superthread_spaces,''),
                        superthread_workspace_slug, COALESCE(superthread_board_id,''),
                        COALESCE(superthread_api_token_env_var,'ST_TOKEN'),
                        superthread_binding_id,
                        COALESCE(superthread_done_column_id,'')
                 FROM projects WHERE id=?1",
                [project_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .optional()
            .context("read Superthread project configuration")?
            .ok_or_else(|| anyhow::anyhow!("The project was not found"))?;
        drop(read_connection);
        let (source, _spaces, workspace_slug, board_id, token_env, binding_id, done_column_id) =
            config;
        if source != "superthread" {
            bail!("This project is not configured for Superthread");
        }
        if board_id.trim().is_empty() || binding_id.is_none() {
            bail!("Configure the Superthread board and binding before syncing");
        }
        service
            .configure_token_env(&token_env)
            .map_err(anyhow::Error::msg)?;
        let cards = service
            .board_cards(&board_id, workspace_slug.as_deref())
            .map_err(anyhow::Error::msg)?;
        let mut connection = self.open_writable()?;
        let transaction = connection.transaction().context("begin Superthread sync")?;
        let now = unix_timestamp();
        let mut local_ids = HashMap::<String, String>::new();
        let mut parents = HashMap::<String, Option<String>>::new();
        for card in &cards {
            let external_id = card.id.trim();
            if external_id.is_empty() || card.title.trim().is_empty() {
                continue;
            }
            if !done_column_id.is_empty() && card.list_id == done_column_id {
                continue;
            }
            let has_retired: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='retired_provider_cards')",
                    [],
                    |row| row.get(0),
                )
                .context("check retirement journal")?;
            if has_retired {
                let retired: bool = transaction
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM retired_provider_cards WHERE binding_id=?1 AND external_id=?2)",
                        params![binding_id, external_id],
                        |row| row.get(0),
                    )
                    .context("check retired provider card")?;
                if retired {
                    continue;
                }
            }
            let existing: Option<String> = transaction
                .query_row(
                    "SELECT id FROM kanban_cards WHERE binding_id=?1 AND external_id=?2",
                    params![binding_id, external_id],
                    |row| row.get(0),
                )
                .optional()
                .context("resolve Superthread card")?;
            let local_id = if let Some(id) = existing {
                id
            } else {
                let legacy = format!("superthread:{external_id}");
                let occupied: bool = transaction
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM kanban_cards WHERE id=?1)",
                        [&legacy],
                        |row| row.get(0),
                    )
                    .context("check Superthread card identity")?;
                if !occupied {
                    legacy
                } else {
                    let qualified = format!(
                        "superthread:{}:{external_id}",
                        binding_id.as_deref().unwrap_or("binding")
                    );
                    let occupied: bool = transaction
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM kanban_cards WHERE id=?1)",
                            [&qualified],
                            |row| row.get(0),
                        )
                        .context("check Superthread card identity")?;
                    if occupied {
                        bail!("Superthread card identity collision for {external_id}");
                    }
                    qualified
                }
            };
            let parent_external = card
                .task_parent
                .as_ref()
                .map(|parent| parent.id.trim().to_string());
            let parent_title = card.task_parent.as_ref().map(|parent| parent.title.clone());
            let assignees =
                serde_json::to_string(&card.assignee_names).unwrap_or_else(|_| "[]".into());
            transaction
                .execute(
                    "INSERT INTO kanban_cards
                     (id, external_provider, external_id, title, content, board_id, board_title,
                      list_id, list_title, card_url, assignee_names, status, project_id,
                      provider_parent_title, provider_child_count, hierarchy_finalized,
                      created_at, updated_at, sort_order, in_scope, binding_id)
                     VALUES (?1,'superthread',?2,?3,COALESCE(?4,''),?5,?6,?7,?8,?9,?10,
                             'needs_refinement',?11,?12,?13,0,?14,?14,
                             (SELECT COALESCE(MAX(sort_order),-1)+1 FROM kanban_cards WHERE status='needs_refinement'),
                             1,?15)
                     ON CONFLICT(id) DO UPDATE SET
                       title=excluded.title,
                       content=CASE WHEN ?4 IS NULL THEN kanban_cards.content ELSE excluded.content END,
                       board_id=excluded.board_id, board_title=excluded.board_title,
                       list_id=excluded.list_id, list_title=excluded.list_title,
                       card_url=excluded.card_url, assignee_names=excluded.assignee_names,
                       project_id=excluded.project_id,
                       provider_parent_title=excluded.provider_parent_title,
                       provider_child_count=excluded.provider_child_count,
                       in_scope=1, binding_id=excluded.binding_id, updated_at=excluded.updated_at",
                    params![
                        local_id,
                        external_id,
                        card.title.trim(),
                        card.content.as_deref(),
                        card.board_id,
                        card.board_title,
                        card.list_id,
                        card.list_title,
                        card.card_url,
                        assignees,
                        project_id,
                        parent_title,
                        card.total_task_children.unwrap_or(0) as i64,
                        now,
                        binding_id.as_deref(),
                    ],
                )
                .context("upsert Superthread card")?;
            local_ids.insert(external_id.to_string(), local_id);
            parents.insert(external_id.to_string(), parent_external);
        }
        for (external_id, parent_external) in parents {
            let Some(parent_external) = parent_external else {
                continue;
            };
            let Some(parent_id) = local_ids.get(&parent_external) else {
                continue;
            };
            let Some(local_id) = local_ids.get(&external_id) else {
                continue;
            };
            transaction
                .execute(
                    "UPDATE kanban_cards SET parent_id=?1, provider_parent_title=NULL WHERE id=?2",
                    params![parent_id, local_id],
                )
                .context("link Superthread parent card")?;
        }
        transaction
            .execute(
                "UPDATE projects SET superthread_board_id=?1 WHERE id=?2",
                params![board_id, project_id],
            )
            .context("record Superthread board")?;
        transaction.commit().context("commit Superthread sync")?;
        Ok(local_ids.len())
    }

    pub fn sync_project_pull_requests(
        &self,
        project_id: &str,
        repository: &str,
        pull_requests: &[crate::github::GithubPullRequest],
    ) -> Result<usize> {
        if pull_requests.is_empty() {
            return Ok(0);
        }
        let connection = self.open_writable()?;
        let mut statement = connection
            .prepare(
                "SELECT c.id, e.branch
                 FROM kanban_cards c
                 JOIN card_environments e ON e.card_id=c.id
                 WHERE c.project_id=?1 AND e.branch <> ''",
            )
            .context("prepare pull request sync")?;
        let cards = statement
            .query_map([project_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .context("read pull request cards")?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("collect pull request cards")?;
        drop(statement);
        let mut updated = 0usize;
        for (card_id, branch) in cards {
            let Some(pr) = pull_requests.iter().find(|pr| pr.head_ref_name == branch) else {
                continue;
            };
            connection
                .execute(
                    "INSERT INTO card_pull_requests
                     (card_id,repository,number,title,url,state,draft,ci_status,review_state,has_conflicts,mergeable,head_revision,updated_at)
                     VALUES (?1,?2,?3,?4,?5,?11,?6,?7,'unknown',?8,?9,?10,unixepoch())
                     ON CONFLICT(card_id) DO UPDATE SET
                       repository=excluded.repository, number=excluded.number, title=excluded.title,
                       url=excluded.url, state=excluded.state, draft=excluded.draft, ci_status=excluded.ci_status,
                       has_conflicts=excluded.has_conflicts, mergeable=excluded.mergeable,
                       head_revision=excluded.head_revision, updated_at=excluded.updated_at",
                    params![
                        card_id,
                        repository,
                        pr.number as i64,
                        pr.title,
                        pr.url,
                        pr.draft as i64,
                        pr.ci_status.as_str(),
                        pr.has_merge_conflicts as i64,
                        (!pr.has_merge_conflicts) as i64,
                        pr.head_revision.as_deref(),
                        if matches!(pr.state.as_str(), "open" | "closed" | "merged") {
                            pr.state.as_str()
                        } else {
                            "open"
                        },
                    ],
                )
                .context("upsert card pull request")?;
            updated += 1;
        }
        Ok(updated)
    }

    pub fn delete_project(&self, project_id: &str) -> Result<()> {
        let mut connection = self.open_writable()?;
        let transaction = connection.transaction().context("begin project deletion")?;
        let source: String = transaction
            .query_row(
                "SELECT COALESCE(kanban_source,'local') FROM projects WHERE id=?1",
                [project_id],
                |row| row.get(0),
            )
            .optional()
            .context("find project")?
            .ok_or_else(|| {
                anyhow::anyhow!("Project could not be deleted because it was not found")
            })?;
        let active: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM kanban_cards WHERE project_id=?1 AND status != 'done'",
                [project_id],
                |row| row.get(0),
            )
            .context("count active project cards")?;
        let environments: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM card_environments e JOIN kanban_cards c ON c.id=e.card_id WHERE e.project_id=?1 OR c.project_id=?1",
                [project_id],
                |row| row.get(0),
            )
            .context("count project environments")?;
        if active > 0 || environments > 0 {
            bail!(
                "Project deletion is blocked: finish its {active} active card(s) and clean up its {environments} card environment(s) first."
            );
        }
        let mut statement = transaction
            .prepare(
                "SELECT id FROM kanban_cards WHERE project_id=?1 AND external_provider != 'superthread'",
            )
            .context("list removable project cards")?;
        let removed = statement
            .query_map([project_id], |row| row.get::<_, String>(0))
            .context("read removable project cards")?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("collect removable project cards")?;
        drop(statement);
        for table in [
            "card_events",
            "card_pull_requests",
            "environment_creation_operations",
            "card_cleanup_operations",
            "scripted_delivery_operations",
        ] {
            let sql = format!(
                "DELETE FROM {table} WHERE card_id IN (SELECT id FROM kanban_cards WHERE project_id=?1 AND external_provider != 'superthread')"
            );
            transaction
                .execute(&sql, [project_id])
                .with_context(|| format!("delete {table} for project"))?;
        }
        if source == "superthread" {
            transaction
                .execute(
                    "UPDATE kanban_cards SET project_id=NULL, in_scope=0 WHERE project_id=?1 AND external_provider='superthread'",
                    [project_id],
                )
                .context("detach Superthread cards")?;
        }
        transaction
            .execute(
                "DELETE FROM kanban_cards WHERE project_id=?1 AND external_provider != 'superthread'",
                [project_id],
            )
            .context("delete project cards")?;
        transaction
            .execute(
                "DELETE FROM kanban_project_sequences WHERE project_id=?1",
                [project_id],
            )
            .context("delete project sequence")?;
        transaction
            .execute("DELETE FROM projects WHERE id=?1", [project_id])
            .context("delete project")?;
        transaction.commit().context("commit project deletion")?;
        for card_id in removed {
            if let Ok(directory) = crate::paths::card_directory(&card_id) {
                if directory.exists() {
                    std::fs::remove_dir_all(&directory)
                        .with_context(|| format!("remove card files for {card_id}"))?;
                }
            }
        }
        Ok(())
    }

    pub fn update_project(&self, project_id: &str, update: &ProjectSettingsUpdate) -> Result<()> {
        let name = update.name.trim();
        let raw_path = update.path.trim();
        let target_branch = update.target_branch.trim();
        if name.is_empty() || raw_path.is_empty() || target_branch.is_empty() {
            bail!("Project name, directory, and target branch are required");
        }
        let path = std::path::Path::new(raw_path)
            .canonicalize()
            .with_context(|| format!("Project directory does not exist: {raw_path}"))?;
        if !path.is_dir() {
            bail!("Project path must be a directory");
        }
        let path = path.to_string_lossy().into_owned();
        let release_config = if update.release_config_path.trim().is_empty() {
            ".stacks/release.json"
        } else {
            update.release_config_path.trim()
        };
        let connection = self.open_writable()?;
        let duplicate: Option<String> = connection
            .query_row(
                "SELECT id FROM projects WHERE path=?1 AND id<>?2",
                params![path, project_id],
                |row| row.get(0),
            )
            .optional()
            .context("check project path")?;
        if duplicate.is_some() {
            bail!("That project directory is already added");
        }
        let changed = connection
            .execute(
                "UPDATE projects SET name=?1, path=?2, target_branch=?3,
                    start_work_command=?4, server_command=?5, console_command=?6,
                    releases_enabled=?7, release_config_path=?8 WHERE id=?9",
                params![
                    name,
                    path,
                    target_branch,
                    update
                        .start_work_command
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty()),
                    update
                        .server_command
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty()),
                    update
                        .console_command
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty()),
                    update.releases_enabled as i64,
                    release_config,
                    project_id
                ],
            )
            .context("update project")?;
        if changed != 1 {
            bail!("Project was not found");
        }
        Ok(())
    }

    pub fn create_project(&self, name: &str, path: &str) -> Result<String> {
        let name = name.trim();
        let raw_path = path.trim();
        if name.is_empty() || raw_path.is_empty() {
            bail!("Project name and directory are required");
        }
        let path = std::path::Path::new(raw_path)
            .canonicalize()
            .with_context(|| format!("Project directory does not exist: {raw_path}"))?;
        if !path.is_dir() {
            bail!("Project path must be a directory");
        }
        let path = path.to_string_lossy().into_owned();
        let connection = self.open_writable()?;
        let exists: Option<String> = connection
            .query_row("SELECT id FROM projects WHERE path=?1", [&path], |row| {
                row.get(0)
            })
            .optional()
            .context("check project path")?;
        if exists.is_some() {
            bail!("That project directory is already added");
        }
        let sort_order: i64 = connection
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM projects",
                [],
                |row| row.get(0),
            )
            .context("next project sort order")?;
        let id = uuid::Uuid::new_v4().to_string();
        connection
            .execute(
                "INSERT INTO projects(id,name,path,sort_order,notes,kanban_source,delivery_workflow,target_branch,release_config_path)
                 VALUES (?1,?2,?3,?4,'','local','local_merge','main','.stacks/release.json')",
                params![id, name, path, sort_order],
            )
            .context("create project")?;
        Ok(id)
    }

    pub fn save_project_notes(&self, project_id: &str, notes: &str) -> Result<()> {
        let connection = self.open_writable()?;
        let changed = connection
            .execute(
                "UPDATE projects SET notes=?1 WHERE id=?2",
                params![notes, project_id],
            )
            .context("save project notes")?;
        if changed != 1 {
            bail!("Project notes could not be saved because the project was not found");
        }
        Ok(())
    }

    /// Dispatch a backend capability to its core implementation. The TUI never
    /// decides whether an action is allowed; `capabilities` owns that and this
    /// mapping only routes the chosen action.
    pub fn run_action(
        &self,
        card_id: &str,
        action: crate::workflow::WorkflowAction,
        expected_revision: i64,
        feature_environment: bool,
    ) -> Result<()> {
        use crate::workflow::WorkflowAction as Action;
        match action {
            Action::OpenRefinement
            | Action::ReturnToRefinement
            | Action::StopRefinement
            | Action::RequestChanges
            | Action::Close
            | Action::Delete => self.apply_local_action(card_id, action, expected_revision),
            Action::StartWork => self.start_local_work(card_id, expected_revision),
            Action::Ship => self.approve_local_card(card_id),
            Action::MergeLocal => self.merge_local_card(card_id),
            Action::MergeTarget => self.merge_target_into_card(card_id),
            Action::CreatePr | Action::CreatePrWithFe => {
                self.create_pull_request(card_id, feature_environment)
            }
            Action::MergePr => self.merge_pull_request(card_id),
            Action::Push | Action::RetryPush => self.push_scripted_card(card_id),
            Action::Deploy | Action::RetryDeploy | Action::RunDeploymentAgain => {
                self.deploy_scripted_card(card_id)
            }
            Action::ConfirmDeployed => self.confirm_scripted_deployed(card_id),
            Action::CancelDeployment => self.cancel_scripted_deploy(card_id),
            Action::Cleanup => self.cleanup_local_card(card_id),
            Action::RetryRuntimeCleanup => self.complete_local_runtime_cleanup(card_id, &[]),
            Action::OpenPr => {
                let detail = self.load_detail(card_id)?;
                let url = detail
                    .card
                    .pull_request
                    .as_ref()
                    .map(|pull_request| pull_request.url.clone())
                    .or_else(|| (!detail.card_url.is_empty()).then_some(detail.card_url.clone()))
                    .ok_or_else(|| anyhow::anyhow!("The card has no pull request or card URL"))?;
                open_url(&url)
            }
            Action::FinishRefinement => {
                bail!("Finish refinement needs the plan editor (press Enter on the card)")
            }
            Action::CleanupCreation => {
                bail!(
                    "Environment-creation cleanup is not available from stacks-tui yet; use the Stacks app"
                )
            }
        }
    }

    /// Run a read-only projection against this database. TUI/native services use
    /// this to share connection policy instead of duplicating SQLite flags.
    pub fn with_read_connection<T>(
        &self,
        work: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut connection = self.open_read_only().map_err(|error| error.to_string())?;
        connection
            .pragma_update(None, "query_only", "ON")
            .map_err(|error| error.to_string())?;
        work(&mut connection)
    }

    /// Run a write inside a transaction, matching the Tauri backend's
    /// `with_write_connection` contract.
    pub fn with_write_connection<T>(
        &self,
        work: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut connection = self.open_writable().map_err(|error| error.to_string())?;
        connection
            .execute_batch("BEGIN")
            .map_err(|error| error.to_string())?;
        match work(&mut connection) {
            Ok(result) => {
                connection
                    .execute_batch("COMMIT")
                    .map_err(|error| error.to_string())?;
                Ok(result)
            }
            Err(error) => {
                let _ = connection.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn open_write(&self) -> Result<Connection> {
        Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI,
        )
        .context("open Stacks database for workflow action")
    }

    fn open_read_only(&self) -> Result<Connection> {
        let connection = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_URI,
        )
        .with_context(|| {
            format!(
                "open Stacks card database read-only at {}",
                self.path.display()
            )
        })?;
        configure(&connection)?;
        Ok(connection)
    }

    fn open_writable(&self) -> Result<Connection> {
        let connection = Connection::open(&self.path).with_context(|| {
            format!(
                "open Stacks card database for backlog reorder at {}",
                self.path.display()
            )
        })?;
        configure(&connection)?;
        Ok(connection)
    }
}

fn configure(connection: &Connection) -> Result<()> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .context("configure SQLite busy timeout")?;
    Ok(())
}

fn unix_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn reject_duplicates(label: &str, ids: &[String]) -> Result<()> {
    let mut seen = HashSet::new();
    for id in ids {
        if !seen.insert(id) {
            bail!("Reorder {label} contains duplicate card ID: {id}");
        }
    }
    Ok(())
}

#[derive(Debug)]
struct LaneRow {
    id: String,
    status: CardStatus,
    finalized: bool,
    parent_id: Option<String>,
    in_scope: bool,
    sort_order: i64,
    created_at: i64,
}

fn load_snapshot_from(connection: &Connection) -> Result<CardSnapshot> {
    let projects = load_projects(connection)?;
    let mut cards = load_card_rows(connection)?;
    let mut children = load_children(connection)?;
    load_pull_requests(connection, &mut cards)?;
    apply_effective_statuses(&mut cards, &mut children);
    Ok(CardSnapshot { projects, cards })
}

fn load_projects(connection: &Connection) -> Result<Vec<Project>> {
    let mut statement = connection.prepare(
        "SELECT id, name, path, color_id, delivery_workflow, kanban_source,
                server_command, console_command, notes, releases_enabled, release_config_path,
                COALESCE(supports_feature_environments, 0),
                COALESCE(target_branch, 'main'), start_work_command, deployment_command,
                COALESCE(enable_mcp, 0), COALESCE(mcp_env_names, ''),
                superthread_api_token_env_var
         FROM projects ORDER BY sort_order ASC, name COLLATE NOCASE ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(Project {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
            color_id: row.get(3)?,
            delivery_workflow: DeliveryWorkflow::parse(&row.get::<_, String>(4)?),
            kanban_source: row.get(5)?,
            server_command: row.get(6)?,
            console_command: row.get(7)?,
            notes: row.get(8)?,
            releases_enabled: row.get::<_, i64>(9)? != 0,
            release_config_path: row.get(10)?,
            supports_feature_environments: row.get::<_, i64>(11)? != 0,
            target_branch: row.get(12)?,
            start_work_command: row.get(13)?,
            deployment_command: row.get(14)?,
            enable_mcp: row.get::<_, i64>(15)? != 0,
            mcp_env_names: row.get(16)?,
            superthread_token_env_var: row.get(17)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("read projects for LIST")
}

fn load_card_rows(connection: &Connection) -> Result<Vec<CardSummary>> {
    let mut statement = connection.prepare(
        "SELECT c.id, c.external_provider, c.external_id, c.title, c.board_id, c.board_title,
                c.list_title, c.assignee_names, c.status, c.completion_outcome,
                c.workflow_revision, c.record_revision, c.project_id, c.parent_id,
                c.hierarchy_finalized, c.provider_child_count, c.created_at, c.updated_at,
                c.sort_order, c.delivery_operation_stage, c.delivery_error,
                p.id, p.external_id, p.title, p.status,
                e.id, e.project_id, e.worktree_path, e.branch, e.target_branch,
                e.lifecycle_state, e.revision, COALESCE(l.layout_revision, 1)
         FROM kanban_cards c
         LEFT JOIN kanban_cards p ON p.id = c.parent_id AND p.in_scope = 1
         LEFT JOIN card_environments e ON e.card_id = c.id
         LEFT JOIN card_layouts l ON l.environment_id = e.id
         WHERE c.in_scope = 1
         ORDER BY c.sort_order ASC, c.created_at ASC, c.id ASC",
    )?;
    let rows = statement.query_map([], |row| {
        let status: String = row.get(8)?;
        let status = CardStatus::parse(&status).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                8,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("unknown card status {status}"),
                )),
            )
        })?;
        let assignees: String = row.get(7)?;
        let parent = row.get::<_, Option<String>>(21)?;
        Ok(CardSummary {
            id: row.get(0)?,
            provider: normalize_provider(&row.get::<_, String>(1)?),
            external_id: row.get(2)?,
            title: row.get(3)?,
            board_id: row.get(4)?,
            board_title: row.get(5)?,
            list_title: row.get(6)?,
            assignee_names: serde_json::from_str(&assignees).unwrap_or_default(),
            status,
            completion_outcome: row.get(9)?,
            workflow_revision: row.get(10)?,
            record_revision: row.get(11)?,
            project_id: row.get(12)?,
            parent: if let Some(parent_id) = parent {
                Some(Relationship {
                    id: parent_id,
                    external_id: row.get::<_, Option<String>>(22)?.unwrap_or_default(),
                    title: row.get::<_, Option<String>>(23)?.unwrap_or_default(),
                    status: row
                        .get::<_, Option<String>>(24)?
                        .as_deref()
                        .and_then(CardStatus::parse)
                        .unwrap_or(CardStatus::NeedsRefinement),
                })
            } else {
                None
            },
            child_count: row.get::<_, i64>(15)? as u64,
            children: Vec::new(),
            hierarchy_finalized: row.get::<_, i64>(14)? != 0,
            environment: row
                .get::<_, Option<String>>(25)?
                .map(|id| -> rusqlite::Result<EnvironmentIndicator> {
                    Ok(EnvironmentIndicator {
                        id,
                        project_id: row.get(26)?,
                        worktree_path: row.get(27)?,
                        branch: row.get(28)?,
                        target_branch: row.get(29)?,
                        lifecycle_state: row.get(30)?,
                        revision: row.get(31)?,
                        layout_revision: row.get(32)?,
                    })
                })
                .transpose()?,
            pull_request: None,
            delivery_operation_stage: row.get(19)?,
            delivery_error: row.get(20)?,
            created_at: row.get(16)?,
            updated_at: row.get(17)?,
            sort_order: row.get(18)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("read card summaries for LIST")
}

fn normalize_provider(provider: &str) -> String {
    if provider.starts_with("local:") {
        "local".to_string()
    } else {
        provider.to_string()
    }
}

fn load_children(connection: &Connection) -> Result<HashMap<String, Vec<Relationship>>> {
    let mut statement = connection.prepare(
        "SELECT parent_id, id, external_id, title, status
         FROM kanban_cards
         WHERE in_scope = 1 AND parent_id IS NOT NULL
         ORDER BY parent_id, created_at, CAST(external_id AS INTEGER), id",
    )?;
    let rows = statement.query_map([], |row| {
        let status: String = row.get(4)?;
        Ok((
            row.get::<_, String>(0)?,
            Relationship {
                id: row.get(1)?,
                external_id: row.get(2)?,
                title: row.get(3)?,
                status: CardStatus::parse(&status).unwrap_or(CardStatus::NeedsRefinement),
            },
        ))
    })?;
    let mut children: HashMap<String, Vec<Relationship>> = HashMap::new();
    for row in rows {
        let (parent_id, child) = row?;
        children.entry(parent_id).or_default().push(child);
    }
    Ok(children)
}

fn load_pull_requests(connection: &Connection, cards: &mut [CardSummary]) -> Result<()> {
    let indexes = cards
        .iter()
        .enumerate()
        .map(|(index, card)| (card.id.clone(), index))
        .collect::<HashMap<_, _>>();
    let mut statement = connection.prepare(
        "SELECT pr.card_id, pr.number, pr.url, pr.state, pr.draft, pr.ci_status,
                pr.review_state, pr.has_conflicts, pr.mergeable,
                p.require_passing_ci, p.require_approval, pr.head_revision, e.source_revision
         FROM card_pull_requests pr
         JOIN kanban_cards c ON c.id = pr.card_id
         LEFT JOIN projects p ON p.id = c.project_id
         LEFT JOIN card_environments e ON e.card_id = c.id
         WHERE c.in_scope = 1",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            PullRequestIndicator {
                number: row.get::<_, i64>(1)? as u64,
                url: row.get(2)?,
                state: row.get(3)?,
                draft: row.get::<_, i64>(4)? != 0,
                ci_status: row.get(5)?,
                review_state: row.get(6)?,
                has_conflicts: row.get::<_, i64>(7)? != 0,
                mergeable: row.get::<_, i64>(8)? != 0,
                blockers: Vec::new(),
            },
            (
                row.get::<_, Option<i64>>(9)?
                    .map(|value| value != 0)
                    .unwrap_or(true),
                row.get::<_, Option<i64>>(10)?
                    .map(|value| value != 0)
                    .unwrap_or(false),
            ),
            row.get::<_, Option<String>>(11)?,
            row.get::<_, Option<String>>(12)?,
        ))
    })?;
    for row in rows {
        let (card_id, mut pull_request, policies, head_revision, approved_revision) = row?;
        apply_pull_request_revision_policy(
            &mut pull_request,
            head_revision.as_deref(),
            approved_revision.as_deref(),
        );
        apply_pull_request_policy(&mut pull_request, policies);
        if let Some(index) = indexes.get(&card_id) {
            cards[*index].pull_request = Some(pull_request);
        }
    }
    Ok(())
}

fn apply_pull_request_revision_policy(
    pull_request: &mut PullRequestIndicator,
    head_revision: Option<&str>,
    approved_revision: Option<&str>,
) {
    if pull_request.state == "open"
        && head_revision.is_some()
        && approved_revision.is_some()
        && head_revision != approved_revision
    {
        pull_request.blockers.push(
            "Pull request has changes that have not been approved; commit updates before merging"
                .to_string(),
        );
    }
}

fn apply_pull_request_policy(pull_request: &mut PullRequestIndicator, policies: (bool, bool)) {
    if pull_request.state != "open" {
        pull_request.blockers.push(
            if pull_request.state == "merged" {
                "Pull request is already merged"
            } else {
                "Pull request was closed without merging"
            }
            .to_string(),
        );
    }
    if pull_request.draft {
        pull_request
            .blockers
            .push("Pull request is a draft".to_string());
    }
    if pull_request.has_conflicts {
        pull_request
            .blockers
            .push("Pull request has merge conflicts".to_string());
    }
    if !pull_request.mergeable {
        pull_request
            .blockers
            .push("GitHub merge readiness is unknown or blocked".to_string());
    }
    if policies.0 && pull_request.ci_status != "success" {
        pull_request.blockers.push(
            match pull_request.ci_status.as_str() {
                "pending" => "CI is pending",
                "failure" => "CI is failing",
                "no_ci" => "Required CI is missing",
                _ => "CI state is unknown",
            }
            .to_string(),
        );
    }
    if pull_request.review_state == "changes_requested" {
        pull_request
            .blockers
            .push("A reviewer requested changes".to_string());
    }
    if policies.1 && pull_request.review_state != "approved" {
        pull_request
            .blockers
            .push("A current approval is required".to_string());
    }
}

fn apply_effective_statuses(
    cards: &mut [CardSummary],
    children: &mut HashMap<String, Vec<Relationship>>,
) {
    for card in cards.iter_mut() {
        card.children = children.remove(&card.id).unwrap_or_default();
        card.child_count = card.child_count.max(card.children.len() as u64);
        card.hierarchy_finalized |= card.provider == "superthread" && !card.children.is_empty();
    }
    let stored = cards
        .iter()
        .map(|card| (card.id.clone(), (card.status, card.hierarchy_finalized)))
        .collect::<HashMap<_, _>>();
    let graph = cards
        .iter()
        .map(|card| {
            (
                card.id.clone(),
                card.children
                    .iter()
                    .map(|child| child.id.clone())
                    .collect::<Vec<_>>(),
            )
        })
        .collect::<HashMap<_, _>>();
    let mut effective = HashMap::new();
    for card in cards.iter() {
        effective_status_from_graph(
            &card.id,
            &stored,
            &graph,
            &mut effective,
            &mut HashSet::new(),
        );
    }
    for card in cards {
        if let Some(status) = effective.get(&card.id) {
            card.status = *status;
        }
        if let Some(parent) = card.parent.as_mut()
            && let Some(status) = effective.get(&parent.id)
        {
            parent.status = *status;
        }
        for child in &mut card.children {
            if let Some(status) = effective.get(&child.id) {
                child.status = *status;
            }
        }
    }
}

fn effective_status_from_graph(
    id: &str,
    stored: &HashMap<String, (CardStatus, bool)>,
    children: &HashMap<String, Vec<String>>,
    memo: &mut HashMap<String, CardStatus>,
    visiting: &mut HashSet<String>,
) -> CardStatus {
    if let Some(status) = memo.get(id) {
        return *status;
    }
    let Some((stored_status, finalized)) = stored.get(id).copied() else {
        return CardStatus::NeedsRefinement;
    };
    if !finalized || !visiting.insert(id.to_string()) {
        return stored_status;
    }
    let effective = children
        .get(id)
        .into_iter()
        .flatten()
        .map(|child| effective_status_from_graph(child, stored, children, memo, visiting))
        .min_by_key(|status| status.status_index())
        .unwrap_or(stored_status);
    visiting.remove(id);
    memo.insert(id.to_string(), effective);
    effective
}

fn local_work_branch(external_id: &str, title: &str) -> String {
    let slug = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(48)
        .collect::<String>();
    let slug = if slug.is_empty() { "work" } else { &slug };
    format!("stacks/card-{external_id}-{slug}")
}

fn git_text<const N: usize>(args: [&str; N]) -> Result<String> {
    let output = std::process::Command::new("git")
        .args(args)
        .output()
        .context("run git")?;
    if !output.status.success() {
        bail!(
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn load_workflow_context(
    connection: &Connection,
    card: &CardSummary,
    project: Option<&Project>,
    runtime_cleanup_status: Option<&str>,
) -> Result<crate::workflow::WorkflowContext> {
    use crate::workflow::{
        CompletionOutcome, DeliveryWorkflow as WorkflowDelivery, EnvironmentLifecycle,
        PullRequestState, WorkflowContext,
    };

    let (creation_operation, creation_cleanup_available) = connection
        .query_row(
            "SELECT cleanup_available FROM environment_creation_operations WHERE card_id=?1",
            [&card.id],
            |row| Ok(row.get::<_, i64>(0)? != 0),
        )
        .optional()
        .map(|value| (value.is_some(), value.unwrap_or(false)))
        .context("read creation operation for capabilities")?;
    let cleanup_operation_active = connection
        .query_row(
            "SELECT status FROM card_cleanup_operations WHERE card_id=?1",
            [&card.id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .context("read cleanup operation for capabilities")?
        .is_some_and(|status| status != "completed");
    let scripted_delivery_stage = connection
        .query_row(
            "SELECT stage FROM scripted_delivery_operations WHERE card_id=?1",
            [&card.id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .context("read scripted delivery stage for capabilities")?;
    let work_agent_launch_retryable = connection
        .query_row(
            "SELECT event_type FROM card_events
             WHERE card_id=?1 AND (
               event_type='agent_launch_failed'
               OR (event_type='agent_started' AND to_status='agent_working')
             )
             ORDER BY created_at DESC, id DESC LIMIT 1",
            [&card.id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .context("read agent launch outcome for capabilities")?
        .as_deref()
        == Some("agent_launch_failed");

    let project_present = project.is_some();
    let source = project
        .and_then(|project| project.kanban_source.as_deref())
        .unwrap_or("local");
    let provider_compatible =
        project_present && ((card.provider == "superthread") == (source == "superthread"));
    let delivery_workflow = match project.map(|project| project.delivery_workflow) {
        Some(DeliveryWorkflow::GithubPullRequest) => WorkflowDelivery::GithubPullRequest,
        Some(DeliveryWorkflow::ScriptedDelivery) => WorkflowDelivery::ScriptedDelivery,
        _ => WorkflowDelivery::LocalMerge,
    };
    let context = WorkflowContext {
        status: workflow_status(card.status),
        hierarchy_finalized: card.hierarchy_finalized,
        provider_compatible,
        project_present,
        delivery_workflow,
        supports_feature_environments: project
            .is_some_and(|project| project.supports_feature_environments),
        environment: card.environment.as_ref().and_then(|environment| {
            environment
                .lifecycle_state
                .parse::<EnvironmentLifecycle>()
                .ok()
        }),
        completion_outcome: card
            .completion_outcome
            .as_deref()
            .and_then(|value| value.parse::<CompletionOutcome>().ok()),
        pull_request: card
            .pull_request
            .as_ref()
            .and_then(|pull_request| pull_request.state.parse::<PullRequestState>().ok()),
        pull_request_blockers: card
            .pull_request
            .as_ref()
            .map(|pull_request| pull_request.blockers.clone())
            .unwrap_or_default(),
        resumable_operation: card.delivery_operation_stage.is_some()
            && scripted_delivery_stage.is_none(),
        scripted_delivery_stage,
        creation_operation,
        creation_cleanup_available,
        cleanup_operation_active,
        runtime_cleanup_retryable: matches!(runtime_cleanup_status, Some("pending" | "failed")),
        work_agent_launch_retryable,
        local_provider: card.provider == "local",
        has_parent: card.parent.is_some(),
        has_children: card.child_count > 0,
    };
    Ok(context)
}

fn workflow_status(status: CardStatus) -> crate::workflow::CardStatus {
    use crate::workflow::CardStatus as WorkflowStatus;
    match status {
        CardStatus::NeedsRefinement => WorkflowStatus::NeedsRefinement,
        CardStatus::Refining => WorkflowStatus::Refining,
        CardStatus::NeedsRefinementInput => WorkflowStatus::NeedsRefinementInput,
        CardStatus::Ready => WorkflowStatus::Ready,
        CardStatus::AgentWorking => WorkflowStatus::AgentWorking,
        CardStatus::NeedsHuman => WorkflowStatus::NeedsHuman,
        CardStatus::Approved => WorkflowStatus::Approved,
        CardStatus::Done => WorkflowStatus::Done,
    }
}

fn load_card_events(
    connection: &Connection,
    card_id: &str,
    limit: usize,
) -> Result<Vec<CardEvent>> {
    let mut statement = connection.prepare(
        "SELECT id, created_at, actor, event_type, outcome, from_status, to_status,
                summary, error_code, error_detail
         FROM card_events
         WHERE card_id = ?1
         ORDER BY created_at DESC, id DESC
         LIMIT ?2",
    )?;
    let rows = statement.query_map(params![card_id, limit.clamp(1, 100) as i64], |row| {
        let from_status: Option<String> = row.get(5)?;
        let to_status: Option<String> = row.get(6)?;
        Ok(CardEvent {
            id: row.get(0)?,
            created_at: row.get(1)?,
            actor: row.get(2)?,
            event_type: row.get(3)?,
            outcome: row.get(4)?,
            from_status: from_status.as_deref().and_then(CardStatus::parse),
            to_status: to_status.as_deref().and_then(CardStatus::parse),
            summary: row.get(7)?,
            error_code: row.get(8)?,
            error_detail: row.get(9)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("read card detail events")
}

fn lane_order(connection: &Connection, status: CardStatus) -> Result<Vec<String>> {
    let mut statement = connection.prepare(
        "SELECT id, status, hierarchy_finalized, parent_id, in_scope, sort_order, created_at
         FROM kanban_cards
         ORDER BY sort_order ASC, created_at ASC, id ASC",
    )?;
    let rows = statement
        .query_map([], |row| {
            let status: String = row.get(1)?;
            Ok(LaneRow {
                id: row.get(0)?,
                status: CardStatus::parse(&status).unwrap_or(CardStatus::NeedsRefinement),
                finalized: row.get::<_, i64>(2)? != 0,
                parent_id: row.get(3)?,
                in_scope: row.get::<_, i64>(4)? != 0,
                sort_order: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let stored = rows
        .iter()
        .map(|row| (row.id.clone(), (row.status, row.finalized)))
        .collect::<HashMap<_, _>>();
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for row in &rows {
        if row.in_scope
            && let Some(parent) = &row.parent_id
        {
            children
                .entry(parent.clone())
                .or_default()
                .push(row.id.clone());
        }
    }
    let mut effective = HashMap::new();
    for row in &rows {
        effective_status_from_graph(
            &row.id,
            &stored,
            &children,
            &mut effective,
            &mut HashSet::new(),
        );
    }
    let mut ids = rows
        .into_iter()
        .filter(|row| row.in_scope)
        .filter(|row| effective.get(&row.id).copied().unwrap_or(row.status) == status)
        .map(|row| (row.sort_order, row.created_at, row.id))
        .collect::<Vec<_>>();
    ids.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.cmp(&right.2))
    });
    Ok(ids.into_iter().map(|(_, _, id)| id).collect())
}

fn mark_card_ready(
    connection: &Connection,
    card_id: &str,
    event_type: &str,
    summary: Option<&str>,
    finalize: bool,
) -> Result<()> {
    let (from_status, already_ready): (String, bool) = connection
        .query_row(
            "SELECT status, status='ready' FROM kanban_cards WHERE id=?1",
            [card_id],
            |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
        )
        .context("read workflow status")?;
    if !already_ready {
        let changed = connection
            .execute(
                "UPDATE kanban_cards SET status='ready', workflow_revision=workflow_revision+1,
                    updated_at=unixepoch(),
                    sort_order=(SELECT COALESCE(MAX(sort_order), -1) + 1 FROM kanban_cards
                                destination WHERE destination.status='ready')
                 WHERE id=?1",
                [card_id],
            )
            .context("mark card ready")?;
        if changed != 1 {
            bail!("Card changed; refinement was not applied");
        }
        connection
            .execute(
                "INSERT INTO card_events
                 (card_id,created_at,actor,event_type,outcome,from_status,to_status,summary)
                 VALUES (?1,unixepoch(),'agent',?2,'success',?3,'ready',?4)",
                params![card_id, event_type, from_status, summary],
            )
            .context("record refinement event")?;
    } else if finalize {
        connection
            .execute(
                "UPDATE kanban_cards SET workflow_revision=workflow_revision+1, updated_at=unixepoch()
                 WHERE id=?1",
                [card_id],
            )
            .context("record finalized breakdown")?;
    }
    if finalize {
        connection
            .execute(
                "UPDATE kanban_cards SET hierarchy_finalized=1, updated_at=unixepoch() WHERE id=?1",
                [card_id],
            )
            .context("finalize hierarchy")?;
    }
    Ok(())
}

fn open_url(url: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(url).status();
    #[cfg(not(target_os = "macos"))]
    let status = std::process::Command::new("xdg-open").arg(url).status();
    let status = status.context("open URL")?;
    if !status.success() {
        bail!("Could not open {url}");
    }
    Ok(())
}
