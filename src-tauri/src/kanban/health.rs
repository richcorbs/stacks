use super::*;
use super::{git_effects::*, repository::*};

pub(in crate::kanban) fn validate_card_environment_project(
    connection: &Connection,
    card_id: &str,
) -> Result<(), String> {
    let (card_project, environment_project, repository_id, provider): (String, String, Option<String>, String) = connection.query_row(
        "SELECT c.project_id, e.project_id, e.repository_id, c.external_provider FROM kanban_cards c JOIN card_environments e ON e.card_id=c.id WHERE c.id=?1",
        [card_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional().map_err(db_error)?.ok_or_else(|| "The card environment or project ownership is missing".to_string())?;
    if card_project != environment_project {
        return Err("The card/environment project mismatch blocks this operation".to_string());
    }
    let (project_path, source): (String, String) = connection
        .query_row(
            "SELECT path, COALESCE(kanban_source, 'local') FROM projects WHERE id=?1",
            [&card_project],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "The card's owning project no longer exists".to_string())?;
    if (provider == "superthread") != (source == "superthread") {
        return Err("The card's owning project is not compatible with its provider".to_string());
    }
    if let Some(expected) = repository_id.filter(|value| !value.trim().is_empty()) {
        if repository_identity(&project_path)? != expected {
            return Err(
                "The owning project's configured checkout belongs to a different Git repository"
                    .to_string(),
            );
        }
    }
    Ok(())
}

pub(in crate::kanban) fn health_issue(
    code: &str,
    message: impl Into<String>,
    step: &str,
) -> EnvironmentHealthIssue {
    EnvironmentHealthIssue {
        code: code.to_string(),
        message: message.into(),
        step: step.to_string(),
    }
}

pub(in crate::kanban) fn environment_health(
    connection: &Connection,
    card_id: &str,
) -> Result<CardEnvironmentHealth, String> {
    let card = get_card(connection, card_id)?
        .ok_or_else(|| format!("Kanban card {card_id} was not found"))?;
    let mut issues = Vec::new();
    let required_step = match card.status.as_str() {
        "agent_working" => Some("work"),
        "needs_human" => Some("approval"),
        "approved" => Some("merge"),
        _ => None,
    };
    let Some(environment) = card.environment else {
        if let Some(step) = required_step {
            issues.push(health_issue(
                "environment_missing",
                format!("This card needs a usable environment before {step}."),
                step,
            ));
        }
        return Ok(CardEnvironmentHealth {
            card_id: card.id,
            issues,
        });
    };

    let source_step = match card.status.as_str() {
        "needs_human" => "approval",
        "approved" => "merge",
        "done" => "cleanup",
        _ => "work",
    };
    let target_step = if card.status == "done" {
        "cleanup"
    } else {
        "merge"
    };
    if environment.lifecycle_state != "ready" {
        issues.push(health_issue(
            "environment_not_ready",
            "The recorded environment is not ready for workflow operations.",
            source_step,
        ));
    }
    let card_project_id = card.project_id.as_deref().unwrap_or_default();
    if environment.project_id.trim().is_empty() {
        issues.push(health_issue(
            "project_metadata_missing",
            "The environment has no recorded project.",
            source_step,
        ));
    } else if environment.project_id != card_project_id {
        issues.push(health_issue(
            "environment_project_mismatch",
            "The card and its environment belong to different projects. Project-dependent operations are blocked.",
            source_step,
        ));
    }
    let project_path: Option<String> = connection
        .query_row(
            "SELECT path FROM projects WHERE id=?1",
            [card_project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    if project_path.is_none() {
        issues.push(health_issue(
            "card_project_missing",
            "The card's owning project no longer exists.",
            source_step,
        ));
    }
    if environment.branch.trim().is_empty() {
        issues.push(health_issue(
            "source_branch_missing",
            "The source branch metadata is missing.",
            source_step,
        ));
    }
    let repository_id = environment
        .repository_id
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    if repository_id.is_none() {
        issues.push(health_issue(
            "repository_metadata_missing",
            "The environment has no recorded repository. Set the merge target again.",
            if card.status == "agent_working" || card.status == "needs_human" {
                "approval"
            } else {
                target_step
            },
        ));
    }
    let target_path = environment
        .target_checkout_path
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    if target_path.is_none() {
        issues.push(health_issue(
            "target_checkout_missing",
            "The target checkout metadata is missing. Set the merge target before continuing.",
            target_step,
        ));
    }
    let target_branch = environment
        .target_branch
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    if target_branch.is_none() {
        issues.push(health_issue(
            "target_branch_missing",
            "The target branch metadata is missing. Set the merge target before continuing.",
            target_step,
        ));
    } else if target_branch == Some(environment.branch.as_str()) {
        issues.push(health_issue(
            "source_target_branch_same",
            "The source and target branches are not distinct.",
            target_step,
        ));
    }
    if card.status == "done"
        && card.completion_outcome.as_deref() == Some("merged")
        && environment
            .source_revision
            .as_deref()
            .is_none_or(str::is_empty)
    {
        issues.push(health_issue(
            "source_revision_missing",
            "The merged source revision metadata is missing.",
            "cleanup",
        ));
    }

    if let (Some(project_path), Some(expected_repository)) =
        (project_path.as_deref(), repository_id)
    {
        match repository_identity(project_path) {
            Ok(actual) if actual != expected_repository => issues.push(health_issue(
                "project_repository_mismatch",
                "The owning project's configured checkout belongs to a different repository.",
                source_step,
            )),
            Err(_) => issues.push(health_issue(
                "project_checkout_unavailable",
                "Stacks could not identify the owning project's configured repository.",
                source_step,
            )),
            _ => {}
        }
    }

    let source_path = environment.worktree_path.as_str();
    let source_canonical = match Path::new(source_path).canonicalize() {
        Ok(path) => Some(path),
        Err(_) => {
            issues.push(health_issue(
                "source_checkout_unavailable",
                format!("The source checkout is missing or inaccessible at {source_path}."),
                source_step,
            ));
            None
        }
    };
    let mut source_tip = None;
    if let Some(source) = source_canonical.as_ref().and_then(|path| path.to_str()) {
        match repository_identity(source) {
            Ok(actual) if repository_id.is_some_and(|expected| expected != actual) => {
                issues.push(health_issue(
                    "source_repository_mismatch",
                    "The source checkout belongs to a different repository.",
                    source_step,
                ))
            }
            Err(_) => issues.push(health_issue(
                "source_repository_unavailable",
                "Stacks could not identify the source repository.",
                source_step,
            )),
            _ => {}
        }
        match git_output(source, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
            Ok(branch) if !environment.branch.is_empty() && branch != environment.branch => issues
                .push(health_issue(
                    "source_branch_mismatch",
                    format!(
                        "The source checkout is on {branch}, expected {}.",
                        environment.branch
                    ),
                    source_step,
                )),
            Err(_) => issues.push(health_issue(
                "source_checkout_detached",
                "The source checkout is detached; a named branch is required.",
                source_step,
            )),
            _ => {}
        }
        match has_git_operation(source) {
            Ok(true) => issues.push(health_issue(
                "source_git_operation_in_progress",
                "The source checkout has an in-progress Git operation.",
                source_step,
            )),
            Err(_) => issues.push(health_issue(
                "source_git_state_unavailable",
                "Stacks could not determine whether the source checkout has an in-progress Git operation.",
                source_step,
            )),
            _ => {}
        }
        match git_output(source, &["rev-parse", "HEAD"]) {
            Ok(revision) => source_tip = Some(revision),
            Err(_) => issues.push(health_issue(
                "source_revision_unavailable",
                "Stacks could not read the source checkout revision.",
                source_step,
            )),
        }
    }

    let target_canonical = if let Some(target_path) = target_path {
        match Path::new(target_path).canonicalize() {
            Ok(path) => Some(path),
            Err(_) => {
                issues.push(health_issue(
                    "target_checkout_unavailable",
                    format!("The target checkout is missing or inaccessible at {target_path}."),
                    target_step,
                ));
                None
            }
        }
    } else {
        None
    };
    if let Some(target) = target_canonical.as_ref().and_then(|path| path.to_str()) {
        match repository_identity(target) {
            Ok(actual) if repository_id.is_some_and(|expected| expected != actual) => {
                issues.push(health_issue(
                    "target_repository_mismatch",
                    "The target checkout belongs to a different repository.",
                    target_step,
                ))
            }
            Err(_) => issues.push(health_issue(
                "target_repository_unavailable",
                "Stacks could not identify the target repository.",
                target_step,
            )),
            _ => {}
        }
        match git_output(target, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
            Ok(branch) if target_branch.is_some_and(|expected| expected != branch) => {
                issues.push(health_issue(
                    "target_branch_mismatch",
                    format!(
                        "The target checkout is on {branch}, expected {}.",
                        target_branch.unwrap_or_default()
                    ),
                    target_step,
                ))
            }
            Err(_) => issues.push(health_issue(
                "target_checkout_detached",
                "The target checkout is detached; a named branch is required.",
                target_step,
            )),
            _ => {}
        }
        match has_git_operation(target) {
            Ok(true) => issues.push(health_issue(
                "target_git_operation_in_progress",
                "The target checkout has an in-progress Git operation.",
                target_step,
            )),
            Err(_) => issues.push(health_issue(
                "target_git_state_unavailable",
                "Stacks could not determine whether the target checkout has an in-progress Git operation.",
                target_step,
            )),
            _ => {}
        }
    }

    if let (Some(target), Some(source)) = (
        target_canonical.as_ref().and_then(|path| path.to_str()),
        source_canonical.as_ref().and_then(|path| path.to_str()),
    ) {
        let registered = ensure_registered_distinct_worktree(target, source).is_ok();
        if !registered {
            issues.push(health_issue(
                "source_worktree_not_registered",
                "The source checkout is not a distinct registered worktree of the target repository.",
                target_step,
            ));
        }
        if card.status == "done"
            && card.completion_outcome.as_deref() == Some("merged")
            && registered
        {
            if let (Some(recorded), Some(current)) = (
                environment.source_revision.as_deref(),
                source_tip.as_deref(),
            ) {
                if recorded != current {
                    issues.push(health_issue(
                        "source_revision_changed",
                        "The source branch has new commits since merge; merge again before cleanup.",
                        "cleanup",
                    ));
                } else {
                    match git_status_success(target, &["merge-base", "--is-ancestor", current, "HEAD"]) {
                        Ok(false) => issues.push(health_issue(
                            "source_revision_not_merged",
                            "The merged source revision is no longer reachable from the target branch.",
                            "cleanup",
                        )),
                        Err(_) => issues.push(health_issue(
                            "ancestry_check_failed",
                            "Stacks could not verify that the source revision is reachable from the target branch.",
                            "cleanup",
                        )),
                        _ => {}
                    }
                }
            }
        }
    }

    Ok(CardEnvironmentHealth {
        card_id: card.id,
        issues,
    })
}

pub(in crate::kanban) fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub(in crate::kanban) fn db_error(error: rusqlite::Error) -> String {
    format!("Kanban database error: {error}")
}
