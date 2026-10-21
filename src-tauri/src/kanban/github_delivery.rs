use super::*;
#[allow(unused_imports)]
use super::{
    cards::*, cleanup::*, domain::*, environment::*, git_effects::*, health::*, local_delivery::*,
    repository::*, sync::*,
};

#[cfg(test)]
#[path = "github_delivery_tests.rs"]
mod tests;

#[derive(Deserialize)]
pub(in crate::kanban) struct PrMetadata {
    pub(in crate::kanban) title: String,
    pub(in crate::kanban) body: String,
}

#[derive(Debug)]
pub(in crate::kanban) struct ProjectDeliverySettings {
    pub(in crate::kanban) path: String,
    pub(in crate::kanban) workflow: DeliveryWorkflow,
    pub(in crate::kanban) target_branch: String,
    pub(in crate::kanban) merge_strategy: String,
    pub(in crate::kanban) deployment_command: Option<String>,
}

pub(in crate::kanban) fn project_delivery_settings(
    connection: &Connection,
    card_id: &str,
) -> Result<ProjectDeliverySettings, String> {
    connection.query_row(
        "SELECT p.path, p.delivery_workflow, p.target_branch, p.github_merge_strategy, p.deployment_command
         FROM kanban_cards c JOIN projects p ON p.id=c.project_id WHERE c.id=?1", [card_id], |row| Ok(ProjectDeliverySettings {
            path: row.get(0)?, workflow: row.get(1)?, target_branch: row.get(2)?, merge_strategy: row.get(3)?, deployment_command: row.get(4)?,
        }),
    ).map_err(|error| match error { rusqlite::Error::QueryReturnedNoRows => "The card's project was not found".to_string(), other => db_error(other) })
}

/// Conservative compare-and-swap token. Record revision also invalidates a
/// response when another refresh (including a same-second refresh) commits.
fn refresh_identity(connection: &Connection, id: &str) -> Result<String, String> {
    connection.query_row(
        "SELECT json_array(c.project_id,c.external_provider,c.external_id,c.record_revision,c.workflow_revision,
          c.in_scope,c.feature_environment,p.path,p.delivery_workflow,p.target_branch,
          p.github_merge_strategy,p.require_passing_ci,p.require_approval,p.config_revision,
          p.kanban_source,p.supports_feature_environments,p.superthread_binding_id,p.superthread_mapping_revision,
          e.id,e.project_id,e.worktree_path,e.branch,e.repository_id,e.target_checkout_path,e.target_branch,
          e.source_revision,e.target_revision,e.lifecycle_state,e.revision,
          pr.repository,pr.number,pr.state,pr.head_revision,pr.updated_at)
         FROM kanban_cards c JOIN projects p ON p.id=c.project_id
         LEFT JOIN card_environments e ON e.card_id=c.id
         LEFT JOIN card_pull_requests pr ON pr.card_id=c.id WHERE c.id=?1",
        [id], |row| row.get(0),
    ).map_err(db_error)
}

struct PullRequestRefresh {
    identity: String,
    repository: String,
    values: Vec<serde_json::Value>,
    target_branch: String,
}

struct PreparedPullRequestRefresh {
    identity: String,
    settings: ProjectDeliverySettings,
    branch: String,
    feature_environment: bool,
}

fn prepare_pull_request_refresh(connection: &Connection, id: &str) -> Result<Option<PreparedPullRequestRefresh>, String> {
    let transaction = connection.unchecked_transaction().map_err(db_error)?;
    let connection = &*transaction;
    let settings = project_delivery_settings(connection, id)?;
    if settings.workflow != DeliveryWorkflow::GithubPullRequest {
        return Ok(None);
    }
    let (branch, feature_environment): (String, bool) = connection.query_row(
        "SELECT e.branch, c.feature_environment FROM kanban_cards c JOIN card_environments e ON e.card_id=c.id WHERE c.id=?1",
        [id], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
    ).map_err(db_error)?;
    Ok(Some(PreparedPullRequestRefresh { identity: refresh_identity(connection, id)?, settings, branch, feature_environment }))
}

// No database connection or board lock may be held by the caller during fetch.
fn fetch_pull_request(
    input: PreparedPullRequestRefresh,
) -> Result<PullRequestRefresh, String> {
    fetch_pull_request_with(input, crate::github::run_gh)
}

fn fetch_pull_request_with(
    input: PreparedPullRequestRefresh,
    run_gh: impl Fn(Option<&Path>, &[&str]) -> Result<String, String>,
) -> Result<PullRequestRefresh, String> {
    let PreparedPullRequestRefresh { identity, settings, branch, feature_environment } = input;
    let repository = crate::github::repository_name(&settings.path)?;
    let output = run_gh(Some(Path::new(&settings.path)), &[
        "pr", "list", "--repo", &repository, "--state", "all", "--head", &branch, "--limit", "20",
        "--json", "number,title,url,isDraft,state,mergedAt,statusCheckRollup,mergeable,mergeStateStatus,reviews,headRefOid,baseRefName",
    ])?;
    let values: Vec<serde_json::Value> = serde_json::from_str(&output)
        .map_err(|error| format!("Invalid GitHub pull request response: {error}"))?;
    // Title normalization is external I/O too; keep it outside the mutation.
    let mut values = values;
    if let Some(value) = select_pull_request(&values, &settings.target_branch) {
        let title = value["title"].as_str().unwrap_or("Untitled pull request");
        let normalized = pull_request_title(title, feature_environment);
        if value["state"].as_str() == Some("OPEN") && title != normalized {
            let number = value["number"].as_u64().ok_or("Pull request number is missing")?;
            run_gh(Some(Path::new(&settings.path)), &[
                "pr", "edit", &number.to_string(), "--repo", &repository, "--title", &normalized,
            ])?;
            for value in &mut values {
                if value["number"].as_u64() == Some(number) { value["title"] = normalized.clone().into(); }
            }
        }
    }
    // Repository remotes can be changed outside Stacks' repository coordinator.
    if crate::github::repository_name(&settings.path)? != repository {
        return Err("GitHub repository changed during refresh; retry".into());
    }
    Ok(PullRequestRefresh { identity, repository, values, target_branch: settings.target_branch })
}

fn select_pull_request<'a>(values: &'a [serde_json::Value], target: &str) -> Option<&'a serde_json::Value> {
    // Branch and target identify the pull request. Its head revision is mutable:
    // retain the association when new commits arrive, then let card policy block
    // merging until that exact revision has been approved.
    let matches_target = |value: &&serde_json::Value| {
        value["baseRefName"].as_str() == Some(target)
    };
    values
        .iter()
        .filter(matches_target)
        .find(|value| value["state"].as_str() == Some("OPEN"))
        .or_else(|| {
            values
                .iter()
                .filter(matches_target)
                .find(|value| !value["mergedAt"].is_null())
        })
        .or_else(|| values.iter().filter(matches_target).next())
}

fn apply_pull_request_refresh(connection: &mut Connection, id: &str, refresh: PullRequestRefresh) -> Result<Option<CardPullRequest>, String> {
    if refresh_identity(connection, id)? != refresh.identity {
        return Err("Card or pull request changed during GitHub refresh; retry".into());
    }
    let PullRequestRefresh { repository, values, target_branch, .. } = refresh;
    let Some(value) = select_pull_request(&values, &target_branch) else {
        connection
            .execute("DELETE FROM card_pull_requests WHERE card_id=?1", [id])
            .map_err(db_error)?;
        if !values.is_empty() {
            connection.execute("UPDATE kanban_cards SET delivery_error='No pull request matches the configured target branch.' WHERE id=?1", [id]).map_err(db_error)?;
        }
        return Ok(None);
    };
    let number = value["number"]
        .as_u64()
        .ok_or("Pull request number is missing")?;
    let title = value["title"]
        .as_str()
        .unwrap_or("Untitled pull request")
        .to_string();
    let state = if value["mergedAt"].is_null() {
        value["state"]
            .as_str()
            .unwrap_or("CLOSED")
            .to_ascii_lowercase()
    } else {
        "merged".to_string()
    };
    let checks = value["statusCheckRollup"].as_array();
    let ci_status = match checks {
        None => "unknown",
        Some(values) if values.is_empty() => "no_ci",
        Some(values)
            if values.iter().any(|v| {
                matches!(
                    v["conclusion"].as_str().or(v["state"].as_str()),
                    Some("FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT")
                )
            }) =>
        {
            "failure"
        }
        Some(values)
            if values.iter().any(|v| {
                matches!(
                    v["status"].as_str().or(v["state"].as_str()),
                    Some("QUEUED" | "IN_PROGRESS" | "PENDING" | "EXPECTED")
                )
            }) =>
        {
            "pending"
        }
        Some(values)
            if values.iter().all(|v| {
                matches!(
                    v["conclusion"]
                        .as_str()
                        .or(v["state"].as_str())
                        .or(v["status"].as_str()),
                    Some("SUCCESS" | "COMPLETED" | "NEUTRAL" | "SKIPPED")
                )
            }) =>
        {
            "success"
        }
        Some(_) => "unknown",
    };
    let mut latest_reviews = HashMap::<String, &serde_json::Value>::new();
    for review in value["reviews"].as_array().into_iter().flatten() {
        let author = review["author"]["login"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        let replace = latest_reviews.get(&author).is_none_or(|current| {
            review["submittedAt"].as_str().unwrap_or("")
                >= current["submittedAt"].as_str().unwrap_or("")
        });
        if replace {
            latest_reviews.insert(author, review);
        }
    }
    let review_state = if latest_reviews
        .values()
        .any(|v| v["state"].as_str() == Some("CHANGES_REQUESTED"))
    {
        "changes_requested"
    } else if latest_reviews
        .values()
        .any(|v| v["state"].as_str() == Some("APPROVED"))
    {
        "approved"
    } else {
        "pending"
    };
    let has_conflicts = value["mergeable"].as_str() == Some("CONFLICTING")
        || value["mergeStateStatus"].as_str() == Some("DIRTY");
    let mergeable = value["mergeable"].as_str() == Some("MERGEABLE");
    connection.execute(
        "INSERT INTO card_pull_requests (card_id, repository, number, title, url, state, draft, ci_status, review_state, has_conflicts, mergeable, head_revision, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
         ON CONFLICT(card_id) DO UPDATE SET repository=excluded.repository, number=excluded.number, title=excluded.title, url=excluded.url,
          state=excluded.state, draft=excluded.draft, ci_status=excluded.ci_status, review_state=excluded.review_state,
          has_conflicts=excluded.has_conflicts, mergeable=excluded.mergeable, head_revision=excluded.head_revision, updated_at=excluded.updated_at",
        params![id, repository, number as i64, title, value["url"].as_str().unwrap_or_default(), state, value["isDraft"].as_bool().unwrap_or(false) as i64,
            ci_status, review_state, has_conflicts as i64, mergeable as i64, value["headRefOid"].as_str(), unix_timestamp()],
    ).map_err(db_error)?;
    if state == "open" {
        connection.execute("UPDATE kanban_cards SET delivery_error=NULL, delivery_operation_stage=CASE WHEN delivery_operation_stage='pr_created' THEN NULL ELSE delivery_operation_stage END WHERE id=?1", [id]).map_err(db_error)?;
    } else if state == "merged" {
        let current =
            get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string())?;
        if current.completion_outcome != Some(CompletionOutcome::Closed)
            && current.status != CardStatus::Done
        {
            apply_workflow_transition(
                connection,
                id,
                WorkflowActor::System,
                WorkflowAction::MergePr,
                None,
                "merge_pr",
                Some("Observed merged pull request"),
            )?;
        }
        connection.execute("UPDATE kanban_cards SET delivery_operation_stage=NULL,delivery_error=NULL WHERE id=?1", [id]).map_err(db_error)?;
    } else if state == "closed" {
        connection.execute("UPDATE kanban_cards SET delivery_error='The associated pull request was closed without merging. Create or associate a replacement PR.', delivery_operation_stage=NULL WHERE id=?1", [id]).map_err(db_error)?;
    }
    let card = get_card(connection, id)?.ok_or_else(|| "Kanban card was not found".to_string())?;
    Ok(card.pull_request)
}

fn apply_delivery_failure(connection: &Connection, id: &str, identity: &str, event_type: &str, error_code: &str, error: &str) -> Result<(), String> {
    // Deletion, reassignment and newer refreshes also invalidate failures.
    if refresh_identity(connection, id).ok().as_deref() == Some(identity) {
        connection.execute("UPDATE kanban_cards SET delivery_error=?1 WHERE id=?2", params![error, id]).map_err(db_error)?;
        connection.execute("INSERT INTO card_events (card_id,created_at,actor,event_type,outcome,error_code,error_detail) VALUES (?1,?2,'user',?3,'failure',?4,?5)", params![id,unix_timestamp(),event_type,error_code,error]).map_err(db_error)?;
    }
    Ok(())
}

#[cfg(test)]
fn apply_refresh_failure(connection: &Connection, id: &str, identity: &str, error: &str) -> Result<(), String> {
    apply_delivery_failure(connection, id, identity, "refresh_pr", "refresh_pr_failed", error)
}

fn with_pull_request_preflight<T>(
    id: &str,
    event_type: &str,
    error_code: &str,
    work: impl FnOnce(&mut Connection, Option<PullRequestRefresh>) -> Result<T, String>,
) -> Result<T, String> {
    let input = with_read_connection(|connection| prepare_pull_request_refresh(connection, id))?;
    let identity = input.as_ref().map(|input| input.identity.clone());
    let result = input.map(fetch_pull_request).transpose()
        .and_then(|refresh| with_board_mutation(|connection| work(connection, refresh)));
    if let (Err(error), Some(identity)) = (&result, identity) {
        let _ = with_board_mutation(|connection| apply_delivery_failure(connection, id, &identity, event_type, error_code, error));
    }
    result
}

pub(in crate::kanban) fn refresh_pull_request(id: &str) -> Result<Option<CardPullRequest>, String> {
    let started = std::time::Instant::now();
    let result = with_pull_request_preflight(id, "refresh_pr", "refresh_pr_failed", |connection, refresh| {
        refresh.map(|refresh| apply_pull_request_refresh(connection, id, refresh)).transpose().map(Option::flatten)
    });
    if std::env::var_os("STACKS_PROFILE_KANBAN").is_some() {
        eprintln!("Kanban PR refresh {id}: request_to_update_ms={}", started.elapsed().as_millis());
    }
    result
}

pub(in crate::kanban) async fn kanban_refresh_pull_request_operation(
    id: String,
) -> Result<KanbanPullRequestRefreshResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let refresh_result = coordinate_card_repository(&id, true, || refresh_pull_request(&id));
        let error = refresh_result.err();
        let card = with_read_connection(|connection| {
            get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
        })?;
        Ok(KanbanPullRequestRefreshResult { card, error })
    })
    .await
    .map_err(|error| format!("GitHub refresh worker failed: {error}"))?
}

pub(in crate::kanban) fn begin_pull_request_creation(
    connection: &Connection,
    id: &str,
    feature_environment: bool,
) -> Result<(), String> {
    let action = if feature_environment {
        WorkflowAction::CreatePrWithFe
    } else {
        WorkflowAction::CreatePr
    };
    require_structural_capability(connection, id, action)?;
    connection
        .execute(
            "UPDATE kanban_cards SET feature_environment=?1, delivery_operation_stage='creating_pr', delivery_error=NULL WHERE id=?2",
            params![feature_environment as i64, id],
        )
        .map_err(db_error)?;
    Ok(())
}

pub(in crate::kanban) async fn kanban_create_pull_request_operation(
    id: String,
    expected_workflow_revision: i64,
    feature_environment: bool,
) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        coordinate_card_repository(&id, true, || {
            with_pull_request_preflight(&id, "create_pr", "create_pr_failed", |connection, refresh| {
            let settings = project_delivery_settings(connection, &id)?;
            if settings.workflow != DeliveryWorkflow::GithubPullRequest { return Err("This project uses Local merge delivery".to_string()); }
            let (revision, title, content, source_path, branch, source_revision): (i64, String, String, String, String, Option<String>) = connection.query_row(
                "SELECT c.workflow_revision,c.title,c.content,e.worktree_path,e.branch,e.source_revision FROM kanban_cards c JOIN card_environments e ON e.card_id=c.id WHERE c.id=?1",
                [&id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
            ).map_err(db_error)?;
            if revision != expected_workflow_revision { return Err("Card changed; reload before creating a pull request".to_string()); }
            let existing_pr = refresh.map(|refresh| apply_pull_request_refresh(connection, &id, refresh)).transpose()?.flatten();
            begin_pull_request_creation(connection, &id, feature_environment)?;
            let source = validate_checkout(&source_path, None)?;
            if source.target_branch != branch || source_revision.as_deref() != Some(source.target_revision.as_str()) { return Err("The source branch changed after Commit; commit updates before creating a PR".to_string()); }
            if existing_pr.is_some_and(|pr| pr.state == PullRequestState::Open) {
                connection.execute("UPDATE kanban_cards SET delivery_operation_stage=NULL,delivery_error=NULL WHERE id=?1", [&id]).map_err(db_error)?;
                return get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string());
            }
            let repository = crate::github::repository_name(&settings.path)?;
            let push = Command::new("git").args(["-C", &source_path, "push", "--set-upstream", "origin", &branch]).output().map_err(|error| error.to_string())?;
            if !push.status.success() { return Err(format!("Could not push the card branch: {}", String::from_utf8_lossy(&push.stderr).trim())); }
            connection.execute("UPDATE kanban_cards SET delivery_operation_stage='branch_pushed' WHERE id=?1", [&id]).map_err(db_error)?;
            let git_dir = git_output(&source_path, &["rev-parse", "--git-dir"])?;
            let metadata_path = { let path = PathBuf::from(git_dir); if path.is_absolute() { path } else { Path::new(&source_path).join(path) }.join("stacks-pr-metadata.json") };
            let metadata = fs::read_to_string(&metadata_path).ok().and_then(|text| serde_json::from_str::<PrMetadata>(&text).ok());
            let _ = fs::remove_file(metadata_path);
            let pr_title = pull_request_title(
                &metadata.as_ref().map(|m| m.title.trim().to_string()).filter(|v| !v.is_empty()).unwrap_or(title),
                feature_environment,
            );
            let body = metadata.map(|m| m.body).filter(|v| !v.trim().is_empty()).unwrap_or(content);
            crate::github::run_gh(Some(Path::new(&source_path)), &["pr", "create", "--repo", &repository, "--base", &settings.target_branch, "--head", &branch, "--title", &pr_title, "--body", &body])?;
            // Persist successful creation before the independent refresh. A failed
            // refresh can be retried by discovering the PR, without creating another.
            connection.execute("UPDATE kanban_cards SET delivery_operation_stage='pr_created' WHERE id=?1", [&id]).map_err(db_error)?;
            get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
            })?;
            refresh_pull_request(&id)?;
            with_read_connection(|connection| get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string()))
        })
    }).await.map_err(|error| format!("Create PR worker failed: {error}"))?
}

pub(in crate::kanban) async fn kanban_merge_pull_request_operation(
    id: String,
    expected_workflow_revision: i64,
) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        coordinate_card_repository(&id, true, || {
            let card = with_pull_request_preflight(&id, "merge_pr", "merge_pr_failed", |connection, refresh| {
            let settings = project_delivery_settings(connection, &id)?;
            if settings.workflow != DeliveryWorkflow::GithubPullRequest { return Err("This project uses Local merge delivery".to_string()); }
            let (status, revision): (CardStatus, i64) = connection.query_row("SELECT status,workflow_revision FROM kanban_cards WHERE id=?1", [&id], |row| Ok((row.get(0)?,row.get(1)?))).map_err(db_error)?;
            if revision != expected_workflow_revision { return Err("Card changed; reload before merging the pull request".to_string()); }
            let _ = status;
            if let Some(refresh) = refresh { apply_pull_request_refresh(connection, &id, refresh)?; }
            require_structural_capability(connection, &id, WorkflowAction::MergePr)?;
            let card = get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())?;
            let pr = card.pull_request.ok_or("No open pull request is associated with this card")?;
            if !pr.blockers.is_empty() { return Err(format!("Pull request is not ready: {}", pr.blockers.join("; "))); }
            connection.execute("UPDATE kanban_cards SET delivery_operation_stage='merging_pr', delivery_error=NULL WHERE id=?1", [&id]).map_err(db_error)?;
            let number = pr.number.to_string();
            // Pin the remote tip between preflight and merge. GitHub rejects a
            // merge if another actor pushes after checks/review were verified.
            let head: String = connection.query_row(
                "SELECT head_revision FROM card_pull_requests WHERE card_id=?1", [&id], |row| row.get(0),
            ).map_err(db_error)?;
            if head.is_empty() { return Err("Pull request head is unknown; refresh before merging".to_string()); }
            let flag = match settings.merge_strategy.as_str() { "squash" => "--squash", "rebase" => "--rebase", _ => "--merge" };
            crate::github::run_gh(Some(Path::new(&settings.path)), &["pr", "merge", &number, "--repo", &pr.repository, flag, "--match-head-commit", &head])?;
            let transaction=connection.savepoint().map_err(db_error)?;
            apply_workflow_transition(&transaction, &id, WorkflowActor::User, WorkflowAction::MergePr, Some(expected_workflow_revision), "merge_pr", Some("Merged pull request"))?;
            transaction.execute("UPDATE card_pull_requests SET state='merged', updated_at=?1 WHERE card_id=?2", params![unix_timestamp(), id]).map_err(db_error)?;
            transaction.execute("UPDATE kanban_cards SET delivery_operation_stage='deleting_remote_branch' WHERE id=?1", [&id]).map_err(db_error)?;
            transaction.commit().map_err(db_error)?;
            let branch: String = connection.query_row("SELECT branch FROM card_environments WHERE card_id=?1", [&id], |row| row.get(0)).map_err(db_error)?;
            let deletion = Command::new("git").args(["-C", &settings.path, "push", "origin", "--delete", &branch]).output();
            match deletion {
                Ok(output) if output.status.success() => { connection.execute("UPDATE kanban_cards SET delivery_operation_stage=NULL WHERE id=?1", [&id]).map_err(db_error)?; }
                Ok(output) => { connection.execute("UPDATE kanban_cards SET delivery_error=?1 WHERE id=?2", params![format!("PR merged, but remote branch deletion needs retry: {}", String::from_utf8_lossy(&output.stderr).trim()), id]).map_err(db_error)?; }
                Err(error) => { connection.execute("UPDATE kanban_cards SET delivery_error=?1 WHERE id=?2", params![format!("PR merged, but remote branch deletion needs retry: {error}"), id]).map_err(db_error)?; }
            }
            get_card(connection, &id)?.ok_or_else(|| "Kanban card was not found".to_string())
            })?;
            Ok(card)
        })
    }).await.map_err(|error| format!("Merge PR worker failed: {error}"))?
}

pub(in crate::kanban) fn record_operation_failure(
    card_id: &str,
    event_type: &str,
    error_code: &str,
    detail: &str,
) {
    let _ = with_board_mutation(|connection| {
        if matches!(
            event_type,
            "create_pr" | "merge_pr" | "refresh_pr" | "merge"
        ) {
            connection
                .execute(
                    "UPDATE kanban_cards SET delivery_error=?1 WHERE id=?2",
                    params![detail, card_id],
                )
                .map_err(db_error)?;
        }
        connection.execute(
        "INSERT INTO card_events (card_id, created_at, actor, event_type, outcome, error_code, error_detail) VALUES (?1, ?2, 'user', ?3, 'failure', ?4, ?5)",
        params![card_id, unix_timestamp(), event_type, error_code, detail],
    ).map(|_| ()).map_err(db_error)
    });
}
