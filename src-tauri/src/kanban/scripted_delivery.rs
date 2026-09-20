use super::*;
use super::{
    cards::apply_workflow_transition,
    environment::coordinate_card_repository,
    git_effects::{git_output, git_status_success, validate_checkout},
    github_delivery::project_delivery_settings,
    health::{db_error, unix_timestamp, validate_card_environment_project},
    repository::get_card,
};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
};
use uuid::Uuid;

const MAX_OUTPUT_BYTES: usize = 256 * 1024;
static DEPLOYMENTS: OnceLock<Mutex<HashMap<String, (String, u32)>>> = OnceLock::new();
static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
pub struct ScriptedDeliveryResult {
    pub card: KanbanCard,
    pub message: String,
}

#[derive(Debug)]
struct Evidence {
    project_id: String,
    repository_id: String,
    path: String,
    target_branch: String,
    source_revision: String,
    merge_revision: String,
    stage: String,
    revision: i64,
}

fn evidence(connection: &Connection, id: &str) -> Result<Evidence, String> {
    connection.query_row(
        "SELECT project_id,repository_id,primary_checkout_path,target_branch,source_revision,merge_revision,stage,revision FROM scripted_delivery_operations WHERE card_id=?1",
        [id],
        |row| Ok(Evidence { project_id: row.get(0)?, repository_id: row.get(1)?, path: row.get(2)?, target_branch: row.get(3)?, source_revision: row.get(4)?, merge_revision: row.get(5)?, stage: row.get(6)?, revision: row.get(7)? }),
    ).optional().map_err(db_error)?.ok_or_else(|| "Merge this Scripted delivery card locally first".to_string())
}

fn is_ancestor(path: &str, ancestor: &str, descendant: &str) -> Result<bool, String> {
    git_status_success(path, &["merge-base", "--is-ancestor", ancestor, descendant])
}

fn validate(
    connection: &Connection,
    id: &str,
) -> Result<(Evidence, String, String, String), String> {
    validate_card_environment_project(connection, id)?;
    let settings = project_delivery_settings(connection, id)?;
    if settings.workflow != DeliveryWorkflow::ScriptedDelivery {
        return Err("This project does not use Scripted delivery".into());
    }
    let op = evidence(connection, id)?;
    let canonical = Path::new(&settings.path)
        .canonicalize()
        .map_err(|error| format!("Project primary checkout does not exist: {error}"))?;
    let canonical = canonical
        .to_str()
        .ok_or_else(|| "Project path is not valid UTF-8".to_string())?
        .to_string();
    if canonical != op.path {
        return Err("Project primary checkout changed after the merge".into());
    }
    if settings.target_branch != op.target_branch {
        return Err("Project target branch changed after the merge".into());
    }
    let target = validate_checkout(&canonical, Some(&op.repository_id))?;
    if target.target_branch != op.target_branch {
        return Err(format!(
            "Primary checkout is on {}, expected {}",
            target.target_branch, op.target_branch
        ));
    }
    if !is_ancestor(&canonical, &op.source_revision, &op.merge_revision)? {
        return Err("Captured merge evidence no longer contains the card source revision".into());
    }
    if !is_ancestor(&canonical, &op.source_revision, &target.target_revision)? {
        return Err("Current target branch no longer contains the card source revision".into());
    }
    let remote = git_output(
        &canonical,
        &[
            "config",
            "--get",
            &format!("branch.{}.remote", op.target_branch),
        ],
    )
    .map_err(|_| "Target branch has no configured upstream remote".to_string())?;
    let upstream_ref = git_output(
        &canonical,
        &[
            "config",
            "--get",
            &format!("branch.{}.merge", op.target_branch),
        ],
    )
    .map_err(|_| "Target branch has no configured upstream ref".to_string())?;
    if remote.trim().is_empty() || remote == "." || !upstream_ref.starts_with("refs/heads/") {
        return Err("Target branch has no usable upstream remote/ref".into());
    }
    Ok((op, target.target_revision, remote, upstream_ref))
}

fn remote_tip(path: &str, remote: &str, upstream_ref: &str) -> Result<Option<String>, String> {
    let output = Command::new("git")
        .args(["-C", path, "ls-remote", "--heads", remote, upstream_ref])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("Could not resolve the configured upstream target".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .next()
        .map(str::to_string))
}

fn reconcile_push(connection: &mut Connection, id: &str) -> Result<(String, bool), String> {
    let (op, tip, remote, upstream_ref) = validate(connection, id)?;
    if matches!(op.stage.as_str(), "deploying" | "deployed") {
        return Err("Push is not available during or after deployment".into());
    }
    let before = remote_tip(&op.path, &remote, &upstream_ref)?;
    if before.as_deref() == Some(&tip) {
        record_pushed(
            connection,
            id,
            &tip,
            &remote,
            &upstream_ref,
            "Upstream already matched the target tip",
        )?;
        return Ok((tip, true));
    }
    if let Some(remote_revision) = before.as_deref() {
        if !is_ancestor(&op.path, remote_revision, &tip)? {
            return Err(
                "Upstream target has diverged; a normal fast-forward push is not possible".into(),
            );
        }
    }
    let now = unix_timestamp();
    let changed = connection.execute(
        "UPDATE scripted_delivery_operations SET stage='pushing',attempt=attempt+1,attempt_token=?2,failure_class=NULL,summary='Push prepared',upstream_remote=?3,upstream_ref=?4,updated_at=?5,revision=revision+1 WHERE card_id=?1 AND revision=?6",
        params![id, Uuid::new_v4().to_string(), remote, upstream_ref, now, op.revision],
    ).map_err(db_error)?;
    if changed != 1 {
        return Err("Delivery operation changed; reload and retry".into());
    }
    connection.execute("UPDATE kanban_cards SET delivery_operation_stage='pushing',delivery_error=NULL WHERE id=?1", [id]).map_err(db_error)?;
    let output = Command::new("git")
        .args([
            "-C",
            &op.path,
            "push",
            &remote,
            &format!("HEAD:{upstream_ref}"),
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        connection.execute("UPDATE scripted_delivery_operations SET stage='push_failed',failure_class='push_failed',summary='Push failed; no deployment was run',updated_at=?2,revision=revision+1 WHERE card_id=?1", params![id, unix_timestamp()]).map_err(db_error)?;
        connection.execute("UPDATE kanban_cards SET delivery_operation_stage='push_failed',delivery_error='Push failed; inspect the upstream and retry.' WHERE id=?1", [id]).map_err(db_error)?;
        return Err("Push failed; no deployment was run".into());
    }
    if remote_tip(&op.path, &remote, &upstream_ref)?.as_deref() != Some(&tip) {
        connection.execute("UPDATE scripted_delivery_operations SET stage='push_failed',failure_class='verification_failed',summary='Upstream verification did not match the pushed target tip',updated_at=?2,revision=revision+1 WHERE card_id=?1", params![id, unix_timestamp()]).map_err(db_error)?;
        connection.execute("UPDATE kanban_cards SET delivery_operation_stage='push_failed',delivery_error='Push could not be verified.' WHERE id=?1", [id]).map_err(db_error)?;
        return Err("Push returned successfully, but the upstream target did not resolve to the pushed revision".into());
    }
    record_pushed(
        connection,
        id,
        &tip,
        &remote,
        &upstream_ref,
        "Verified upstream target revision",
    )?;
    Ok((tip, false))
}

fn record_pushed(
    connection: &Connection,
    id: &str,
    tip: &str,
    remote: &str,
    upstream_ref: &str,
    summary: &str,
) -> Result<(), String> {
    connection.execute("UPDATE scripted_delivery_operations SET stage='pushed',verified_push_revision=?2,upstream_remote=?3,upstream_ref=?4,failure_class=NULL,summary=?5,updated_at=?6,revision=revision+1 WHERE card_id=?1", params![id, tip, remote, upstream_ref, summary, unix_timestamp()]).map_err(db_error)?;
    connection.execute("UPDATE kanban_cards SET delivery_operation_stage='pushed',delivery_error=NULL WHERE id=?1", [id]).map_err(db_error)?;
    Ok(())
}

pub async fn push(id: String) -> Result<ScriptedDeliveryResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        coordinate_card_repository(&id, true, || {
            with_board_mutation(|connection| {
                let (_, already) = reconcile_push(connection, &id)?;
                let card = get_card(connection, &id)?
                    .ok_or_else(|| "Kanban card was not found".to_string())?;
                Ok(ScriptedDeliveryResult {
                    card,
                    message: if already {
                        "Upstream already contains the current target tip".into()
                    } else {
                        "Target branch pushed and verified".into()
                    },
                })
            })
        })
    })
    .await
    .map_err(|error| format!("Push worker failed: {error}"))?
}

fn emit_output(card_id: &str, attempt: &str, stream: &str, text: String) {
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit("scripted-delivery-output", serde_json::json!({ "card_id": card_id, "attempt_id": attempt, "stream": stream, "text": text }));
    }
}

fn finish_deployment(
    connection: &mut Connection,
    id: &str,
    token: &str,
    success: bool,
    cancelled: bool,
    exit_code: Option<i32>,
) -> Result<ScriptedDeliveryResult, String> {
    let now = unix_timestamp();
    if success {
        let tip = git_output(&evidence(connection, id)?.path, &["rev-parse", "HEAD"])?;
        connection.execute("UPDATE scripted_delivery_operations SET stage='deployed',deployed_revision=?2,failure_class=NULL,summary='Deployment command succeeded',completed_at=?3,updated_at=?3,revision=revision+1 WHERE card_id=?1 AND attempt_token=?4", params![id, tip, now, token]).map_err(db_error)?;
        connection.execute("UPDATE kanban_cards SET delivery_operation_stage=NULL,delivery_error=NULL WHERE id=?1", [id]).map_err(db_error)?;
        apply_workflow_transition(
            connection,
            id,
            WorkflowActor::User,
            WorkflowAction::Deploy,
            None,
            "scripted_deploy",
            Some("Push verified and deployment command succeeded"),
        )?;
    } else {
        let stage = if cancelled {
            "cancelled"
        } else {
            "deployment_failed"
        };
        let summary = if cancelled {
            "Deployment was cancelled".to_string()
        } else {
            format!(
                "Deployment command exited unsuccessfully ({})",
                exit_code
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "signal".into())
            )
        };
        connection.execute("UPDATE scripted_delivery_operations SET stage=?2,failure_class=?2,summary=?3,updated_at=?4,revision=revision+1 WHERE card_id=?1 AND attempt_token=?5", params![id, stage, summary, now, token]).map_err(db_error)?;
        connection
            .execute(
                "UPDATE kanban_cards SET delivery_operation_stage=?2,delivery_error=?3 WHERE id=?1",
                params![id, stage, summary],
            )
            .map_err(db_error)?;
    }
    let card = get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string())?;
    Ok(ScriptedDeliveryResult {
        card,
        message: if success {
            "Deployment succeeded".into()
        } else if cancelled {
            "Deployment cancelled".into()
        } else {
            "Deployment failed".into()
        },
    })
}

pub async fn deploy(id: String, rerun_uncertain: bool) -> Result<ScriptedDeliveryResult, String> {
    tauri::async_runtime::spawn_blocking(move || coordinate_card_repository(&id, true, || {
        let (command, op, _tip) = with_board_mutation(|connection| {
            let before = evidence(connection, &id)?;
            if before.stage == "uncertain" && !rerun_uncertain { return Err("Deployment outcome is uncertain; confirm it or explicitly run the deployment again".into()); }
            let (tip, _) = reconcile_push(connection, &id)?;
            let settings = project_delivery_settings(connection, &id)?;
            let command = settings.deployment_command.filter(|value| !value.trim().is_empty()).ok_or_else(|| "The current project deployment command is empty".to_string())?;
            let op = evidence(connection, &id)?;
            let token = Uuid::new_v4().to_string();
            connection.execute("UPDATE scripted_delivery_operations SET stage='deploying',attempt=attempt+1,attempt_token=?2,failure_class=NULL,summary='Deployment command started',updated_at=?3,revision=revision+1 WHERE card_id=?1", params![id, token, unix_timestamp()]).map_err(db_error)?;
            connection.execute("UPDATE kanban_cards SET delivery_operation_stage='deploying',delivery_error=NULL WHERE id=?1", [&id]).map_err(db_error)?;
            Ok((command, (op, token), tip))
        })?;
        let (op, token) = op;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut child = Command::new(&shell);
        child.args(if shell.ends_with("zsh") || shell.ends_with("bash") { vec!["-lic", "eval -- \"$STACKS_DEPLOY_COMMAND\""] } else { vec!["-lc", "eval -- \"$STACKS_DEPLOY_COMMAND\""] })
            .current_dir(&op.path).env("STACKS_DEPLOY_COMMAND", command)
            .env("STACKS_CARD_ID", &id).env("STACKS_PROJECT_ID", &op.project_id).env("STACKS_PROJECT_PATH", &op.path)
            .env("STACKS_TARGET_BRANCH", &op.target_branch).env("STACKS_SOURCE_REVISION", &op.source_revision).env("STACKS_MERGE_REVISION", &op.merge_revision)
            .stdout(Stdio::piped()).stderr(Stdio::piped());
        crate::process_group::configure_detached(&mut child);
        let mut child = match child.spawn() {
            Ok(child) => child,
            Err(error) => return with_board_mutation(|connection| {
                let mut result = finish_deployment(connection, &id, &token, false, false, None)?;
                result.message = format!("Could not start deployment command: {error}");
                Ok(result)
            }),
        };
        DEPLOYMENTS.get_or_init(Default::default).lock().map_err(|_| "Deployment registry failed".to_string())?.insert(id.clone(), (token.clone(), child.id()));
        let mut readers = Vec::new();
        if let Some(pipe) = child.stdout.take() { let card = id.clone(); let attempt = token.clone(); readers.push(std::thread::spawn(move || { let mut total = 0; for line in BufReader::new(pipe).lines().map_while(Result::ok) { if total >= MAX_OUTPUT_BYTES { break; } let text = format!("{line}\n"); total += text.len(); emit_output(&card, &attempt, "stdout", text); } })); }
        if let Some(pipe) = child.stderr.take() { let card = id.clone(); let attempt = token.clone(); readers.push(std::thread::spawn(move || { let mut total = 0; for line in BufReader::new(pipe).lines().map_while(Result::ok) { if total >= MAX_OUTPUT_BYTES { break; } let text = format!("{line}\n"); total += text.len(); emit_output(&card, &attempt, "stderr", text); } })); }
        let status = child.wait().map_err(|error| error.to_string())?;
        for reader in readers { let _ = reader.join(); }
        DEPLOYMENTS.get_or_init(Default::default).lock().ok().map(|mut values| values.remove(&id));
        let cancelled = CANCELLED.get_or_init(Default::default).lock().map(|mut values| values.remove(&token)).unwrap_or(false);
        with_board_mutation(|connection| finish_deployment(connection, &id, &token, status.success(), cancelled, status.code()))
    })).await.map_err(|error| format!("Deployment worker failed: {error}"))?
}

pub fn cancel(id: String) -> Result<(), String> {
    let (token, pid) = DEPLOYMENTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Deployment registry failed".to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "No supervised deployment is running for this card".to_string())?;
    CANCELLED
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Deployment registry failed".to_string())?
        .insert(token.clone());
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        let card_id = id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(750));
            let still_running = DEPLOYMENTS
                .get_or_init(Default::default)
                .lock()
                .ok()
                .and_then(|values| values.get(&card_id).cloned())
                .is_some_and(|(active_token, _)| active_token == token);
            if still_running {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
        });
    }
    Ok(())
}

pub fn confirm(id: String) -> Result<ScriptedDeliveryResult, String> {
    with_board_mutation(|connection| {
        let op = evidence(connection, &id)?;
        if op.stage != "uncertain" {
            return Err("Only an uncertain deployment can be confirmed".into());
        }
        let now = unix_timestamp();
        let tip = git_output(&op.path, &["rev-parse", "HEAD"])?;
        connection.execute("UPDATE scripted_delivery_operations SET stage='deployed',deployed_revision=?2,failure_class=NULL,summary='User confirmed deployment after uncertain outcome',completed_at=?3,updated_at=?3,revision=revision+1 WHERE card_id=?1", params![id, tip, now]).map_err(db_error)?;
        connection.execute("INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,summary) VALUES (?1,?2,'user','confirm_deployed','success','User confirmed an uncertain deployment succeeded')", params![id, now]).map_err(db_error)?;
        connection.execute("UPDATE kanban_cards SET delivery_operation_stage=NULL,delivery_error=NULL WHERE id=?1", [&id]).map_err(db_error)?;
        apply_workflow_transition(
            connection,
            &id,
            WorkflowActor::User,
            WorkflowAction::ConfirmDeployed,
            None,
            "confirm_deployed",
            Some("User reconciled uncertain deployment as successful"),
        )?;
        Ok(ScriptedDeliveryResult {
            card: get_card(connection, &id)?.unwrap(),
            message: "Deployment confirmed".into(),
        })
    })
}
