//! Board hygiene: detect and safely reconcile card/resource invariants.
//!
//! Only stale aggregate metadata is repaired automatically. Every other finding
//! is reported with the evidence needed for an explicit user action. The pass is
//! deliberately read-only unless the caller asks for automatic repair, and all
//! card mutations go through `with_board_mutation` so revisions and board-change
//! events stay authoritative.
use super::*;
#[allow(unused_imports)]
use super::{
    cards::*, cleanup::*, domain::*, environment::*, git_effects::*, github_delivery::*, health::*,
    local_delivery::*, repository::*, sync::*,
};

pub(in crate::kanban) const FINALIZED_WITHOUT_CHILDREN: &str = "finalized_parent_without_children";
pub(in crate::kanban) const STALE_PARENT_CHILD_COUNT: &str = "stale_parent_child_count";
pub(in crate::kanban) const ORPHANED_ENVIRONMENT: &str = "environment_worktree_missing";
pub(in crate::kanban) const DONE_RETENTION_BLOCKED: &str = "done_card_retention_blocked";
pub(in crate::kanban) const UNACTIONABLE_CARD: &str = "unactionable_card";

const ACTION_REPAIR_PARENT: &str = "repair_parent_metadata";
const ACTION_CLEANUP_ENVIRONMENT: &str = "cleanup_environment";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BoardHealthFinding {
    pub invariant: String,
    pub card_id: String,
    pub card_title: String,
    pub status: String,
    pub project_id: Option<String>,
    pub environment_id: Option<String>,
    pub environment_revision: Option<i64>,
    pub workflow_revision: i64,
    pub summary: String,
    pub reasons: Vec<String>,
    pub repaired: bool,
    pub action: Option<String>,
    pub action_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BoardHealthReport {
    pub findings: Vec<BoardHealthFinding>,
    pub repaired: usize,
    pub board_revision: i64,
    pub scanned_at: i64,
}

#[derive(Debug, Clone, Copy)]
struct ScanOptions {
    inspect_environments: bool,
    inspect_capabilities: bool,
}

#[derive(Debug, Clone)]
struct StaleParentRow {
    id: String,
    title: String,
    status: String,
    project_id: Option<String>,
    workflow_revision: i64,
    finalized: bool,
    child_count: i64,
}

#[derive(Debug, Clone)]
struct EnvironmentRow {
    id: String,
    card_id: String,
    project_id: String,
    worktree_path: String,
    branch: String,
    repository_id: Option<String>,
    target_checkout_path: Option<String>,
    target_branch: Option<String>,
    source_revision: Option<String>,
    revision: i64,
    card_title: String,
    card_status: String,
    workflow_revision: i64,
    project_path: Option<String>,
    project_target_branch: Option<String>,
}

#[derive(Debug, Clone)]
struct EnvironmentEvidence {
    reasons: Vec<String>,
    cleanup_available: bool,
    branch_exists: bool,
    branch_tip: Option<String>,
}

fn finding(
    invariant: &str,
    card_id: &str,
    card_title: &str,
    status: &str,
    project_id: Option<&str>,
    workflow_revision: i64,
    summary: impl Into<String>,
    reasons: Vec<String>,
) -> BoardHealthFinding {
    BoardHealthFinding {
        invariant: invariant.to_string(),
        card_id: card_id.to_string(),
        card_title: card_title.to_string(),
        status: status.to_string(),
        project_id: project_id.map(str::to_string),
        environment_id: None,
        environment_revision: None,
        workflow_revision,
        summary: summary.into(),
        reasons,
        repaired: false,
        action: None,
        action_label: None,
    }
}

fn stale_parent_rows(connection: &Connection) -> Result<Vec<StaleParentRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT c.id,c.title,c.status,c.project_id,c.workflow_revision,
                    c.hierarchy_finalized,c.provider_child_count
             FROM kanban_cards c
             WHERE c.in_scope=1
               AND (c.hierarchy_finalized!=0 OR c.provider_child_count!=0)
               AND NOT EXISTS(SELECT 1 FROM kanban_cards child WHERE child.parent_id=c.id)
             ORDER BY c.id",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(StaleParentRow {
                id: row.get(0)?,
                title: row.get(1)?,
                status: row.get(2)?,
                project_id: row.get(3)?,
                workflow_revision: row.get(4)?,
                finalized: row.get::<_, i64>(5)? != 0,
                child_count: row.get(6)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(rows)
}

fn stale_parent_finding(row: &StaleParentRow, repaired: bool) -> Vec<BoardHealthFinding> {
    let mut findings = Vec::new();
    if row.finalized {
        let mut item = finding(
            FINALIZED_WITHOUT_CHILDREN,
            &row.id,
            &row.title,
            &row.status,
            row.project_id.as_deref(),
            row.workflow_revision,
            "A finalized aggregate has no linked children.",
            vec![
                "hierarchy_finalized was set after the card's children were removed.".into(),
                "Clearing the flag restores the ordinary leaf workflow; it is safe to re-run."
                    .into(),
            ],
        );
        item.repaired = repaired;
        item.action = (!repaired).then(|| ACTION_REPAIR_PARENT.to_string());
        item.action_label = (!repaired).then(|| "Repair".to_string());
        findings.push(item);
    }
    if row.child_count != 0 {
        let mut item = finding(
            STALE_PARENT_CHILD_COUNT,
            &row.id,
            &row.title,
            &row.status,
            row.project_id.as_deref(),
            row.workflow_revision,
            "An aggregate still records a provider child count but has no linked children.",
            vec![format!(
                "provider_child_count is {} while linked children are gone.",
                row.child_count
            )],
        );
        item.repaired = repaired;
        item.action = (!repaired).then(|| ACTION_REPAIR_PARENT.to_string());
        item.action_label = (!repaired).then(|| "Repair".to_string());
        findings.push(item);
    }
    findings
}

/// Clear aggregate metadata that can only describe children which no longer
/// exist. This is the one automatic repair: it is deterministic, local, and
/// leaves every provider, Git, environment, and card record untouched.
fn repair_stale_parent_metadata(
    connection: &mut Connection,
) -> Result<Vec<BoardHealthFinding>, String> {
    let rows = stale_parent_rows(connection)?;
    let mut findings = Vec::new();
    for row in rows {
        let changed = connection
            .execute(
                "UPDATE kanban_cards
                 SET hierarchy_finalized=0,provider_child_count=0,updated_at=?1
                 WHERE id=?2 AND (hierarchy_finalized!=0 OR provider_child_count!=0)",
                params![unix_timestamp(), row.id],
            )
            .map_err(db_error)?;
        if changed == 0 {
            continue;
        }
        let mut row_findings = stale_parent_finding(&row, true);
        let summary = if row.finalized && row.child_count != 0 {
            "Board hygiene cleared stale hierarchy_finalized and provider_child_count metadata"
        } else if row.finalized {
            "Board hygiene cleared stale hierarchy_finalized metadata"
        } else {
            "Board hygiene cleared stale provider_child_count metadata"
        };
        connection
            .execute(
                "INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,summary)
                 VALUES (?1,?2,'system','board_hygiene_repair','success',?3)",
                params![row.id, unix_timestamp(), summary],
            )
            .map_err(db_error)?;
        findings.append(&mut row_findings);
    }
    Ok(findings)
}

fn environment_rows(connection: &Connection) -> Result<Vec<EnvironmentRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT e.id,e.card_id,e.project_id,e.worktree_path,e.branch,e.repository_id,
                    e.target_checkout_path,e.target_branch,e.source_revision,e.revision,
                    c.title,c.status,c.workflow_revision,p.path,p.target_branch
             FROM card_environments e
             JOIN kanban_cards c ON c.id=e.card_id
             LEFT JOIN projects p ON p.id=e.project_id
             WHERE c.in_scope=1
             ORDER BY c.id,e.id",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(EnvironmentRow {
                id: row.get(0)?,
                card_id: row.get(1)?,
                project_id: row.get(2)?,
                worktree_path: row.get(3)?,
                branch: row.get(4)?,
                repository_id: row.get(5)?,
                target_checkout_path: row.get(6)?,
                target_branch: row.get(7)?,
                source_revision: row.get(8)?,
                revision: row.get(9)?,
                card_title: row.get(10)?,
                card_status: row.get(11)?,
                workflow_revision: row.get(12)?,
                project_path: row.get(13)?,
                project_target_branch: row.get(14)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(rows)
}

fn comparable_path(path: &Path) -> Option<PathBuf> {
    if let Ok(canonical) = path.canonicalize() {
        return Some(canonical);
    }
    let parent = path.parent()?.canonicalize().ok()?;
    Some(parent.join(path.file_name()?))
}

fn inspect_environment(
    connection: &Connection,
    row: &EnvironmentRow,
) -> Result<Option<EnvironmentEvidence>, String> {
    if Path::new(&row.worktree_path).exists() {
        // A checkout that is present is not dead, even if its registration moved.
        return Ok(None);
    }
    let target_path = row
        .target_checkout_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or(row.project_path.as_deref());
    let Some(target_path) = target_path else {
        return Ok(Some(EnvironmentEvidence {
            reasons: vec![
                "The recorded checkout is missing and there is no target checkout to verify it against."
                    .into(),
            ],
            cleanup_available: false,
            branch_exists: false,
            branch_tip: None,
        }));
    };
    if let Some(recorded) = row
        .repository_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        match repository_identity(target_path) {
            Ok(actual) if actual != recorded => {
                return Ok(Some(EnvironmentEvidence {
                    reasons: vec![
                        "The recorded environment repository does not match the target checkout; human review is required."
                            .into(),
                    ],
                    cleanup_available: false,
                    branch_exists: false,
                    branch_tip: None,
                }));
            }
            Err(error) => {
                return Ok(Some(EnvironmentEvidence {
                    reasons: vec![format!(
                        "Stacks could not verify the target repository, so the missing checkout is not treated as dead: {error}"
                    )],
                    cleanup_available: false,
                    branch_exists: false,
                    branch_tip: None,
                }));
            }
            _ => {}
        }
    }
    let configured_target = row
        .target_branch
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or(row.project_target_branch.as_deref())
        .unwrap_or("main");
    match git_output(target_path, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
        Ok(actual) if actual == configured_target => {}
        Ok(actual) => {
            return Ok(Some(EnvironmentEvidence {
                reasons: vec![format!(
                    "The target checkout is on {actual}, expected {configured_target}; merge safety cannot be proven."
                )],
                cleanup_available: false,
                branch_exists: false,
                branch_tip: None,
            }));
        }
        Err(_) => {
            return Ok(Some(EnvironmentEvidence {
                reasons: vec![
                    "The target checkout is detached; merge safety cannot be proven.".into(),
                ],
                cleanup_available: false,
                branch_exists: false,
                branch_tip: None,
            }));
        }
    }
    let inventory = match worktree_inventory(target_path) {
        Ok(inventory) => inventory,
        Err(error) => {
            return Ok(Some(EnvironmentEvidence {
                reasons: vec![format!(
                    "Stacks could not inspect registered worktrees, so a missing path is not treated as dead: {error}"
                )],
                cleanup_available: false,
                branch_exists: false,
                branch_tip: None,
            }));
        }
    };
    let registered = inventory.iter().any(|worktree| {
        worktree.path == row.worktree_path
            || comparable_path(Path::new(&worktree.path))
                == comparable_path(Path::new(&row.worktree_path))
    });
    if registered {
        // Missing but still registered may be temporarily unmounted or moved.
        return Ok(None);
    }
    let branch_checked_out_elsewhere = inventory
        .iter()
        .any(|worktree| worktree.branch.as_deref() == Some(row.branch.as_str()));
    let branch_tip = if row.branch.trim().is_empty() {
        None
    } else {
        match local_ref_tip(target_path, &row.branch) {
            Ok(tip) => tip,
            Err(error) => {
                return Ok(Some(EnvironmentEvidence {
                    reasons: vec![format!(
                        "Stacks could not verify the recorded branch tip: {error}"
                    )],
                    cleanup_available: false,
                    branch_exists: false,
                    branch_tip: None,
                }));
            }
        }
    };
    let branch_exists = branch_tip.is_some();
    let tip = branch_tip.clone().or_else(|| row.source_revision.clone());
    let target_branch = row
        .target_branch
        .as_deref()
        .or(row.project_target_branch.as_deref())
        .unwrap_or("the target branch");
    if row.branch == target_branch {
        return Ok(Some(EnvironmentEvidence {
            reasons: vec![
                "The recorded source branch is the target branch and cannot be treated as an orphaned card checkout."
                    .into(),
            ],
            cleanup_available: false,
            branch_exists,
            branch_tip,
        }));
    }
    if branch_checked_out_elsewhere {
        return Ok(Some(EnvironmentEvidence {
            reasons: vec![
                "The recorded source branch is checked out in another registered worktree; review it before cleanup."
                    .into(),
            ],
            cleanup_available: false,
            branch_exists,
            branch_tip,
        }));
    }
    let pending_cleanup = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM card_cleanup_operations WHERE card_id=?1 AND status!='completed')",
            [&row.card_id],
            |r| r.get::<_, i64>(0),
        )
        .map_err(db_error)?
        != 0;
    if pending_cleanup {
        return Ok(Some(EnvironmentEvidence {
            reasons: vec![
                "The recorded worktree path is missing and is not a registered worktree."
                    .into(),
                "An incomplete cleanup operation must be resumed instead of deleting its environment metadata."
                    .into(),
            ],
            cleanup_available: false,
            branch_exists,
            branch_tip,
        }));
    }
    let Some(tip) = tip else {
        return Ok(Some(EnvironmentEvidence {
            reasons: vec![
                "The recorded worktree path is missing and is not a registered worktree.".into(),
                "The recorded source revision is missing, so merge safety cannot be proven.".into(),
            ],
            cleanup_available: false,
            branch_exists,
            branch_tip,
        }));
    };
    let merged_by_ancestry =
        git_status_success(target_path, &["merge-base", "--is-ancestor", &tip, "HEAD"])
            .unwrap_or(false);
    let merged_by_pr = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM card_pull_requests WHERE card_id=?1 AND state='merged' AND head_revision=?2)",
            params![row.card_id, tip],
            |r| r.get::<_, i64>(0),
        )
        .map_err(db_error)?
        != 0;
    let merged = merged_by_ancestry || merged_by_pr;
    let mut reasons =
        vec!["The recorded worktree path is missing and is not a registered worktree.".into()];
    if merged_by_ancestry {
        reasons.push(format!(
            "The recorded branch tip is an ancestor of {target_branch}; only cleanup metadata remains."
        ));
    } else if merged_by_pr {
        reasons.push(
            "A merged pull request has the exact recorded head revision; only cleanup metadata remains."
                .into(),
        );
    } else {
        reasons.push("Exact source revision is not authoritatively merged.".into());
    }
    Ok(Some(EnvironmentEvidence {
        reasons,
        cleanup_available: merged,
        branch_exists,
        branch_tip,
    }))
}

fn environment_findings(connection: &Connection) -> Result<Vec<BoardHealthFinding>, String> {
    let mut findings = Vec::new();
    for row in environment_rows(connection)? {
        let Some(evidence) = inspect_environment(connection, &row)? else {
            continue;
        };
        let mut item = finding(
            ORPHANED_ENVIRONMENT,
            &row.card_id,
            &row.card_title,
            &row.card_status,
            Some(&row.project_id),
            row.workflow_revision,
            "The card environment's worktree is gone.",
            evidence.reasons,
        );
        item.environment_id = Some(row.id.clone());
        item.environment_revision = Some(row.revision);
        if evidence.cleanup_available {
            item.action = Some(ACTION_CLEANUP_ENVIRONMENT.to_string());
            item.action_label = Some("Clean up environment".to_string());
        }
        findings.push(item);
    }
    Ok(findings)
}

fn done_retention_findings(connection: &Connection) -> Result<Vec<BoardHealthFinding>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,title,status,project_id,workflow_revision
             FROM kanban_cards
             WHERE status='done' AND in_scope=1 AND scope_suspended=0
             ORDER BY id",
        )
        .map_err(db_error)?;
    let cards = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let mut findings = Vec::new();
    for (id, title, status, project_id, workflow_revision) in cards {
        let mut reasons = Vec::new();
        if connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM card_environments WHERE card_id=?1)",
                [&id],
                |r| r.get::<_, i64>(0),
            )
            .map_err(db_error)?
            != 0
        {
            reasons.push("owning environment".to_string());
        }
        if connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM card_cleanup_operations WHERE card_id=?1 AND status!='completed') OR EXISTS(SELECT 1 FROM card_retirements WHERE card_id=?1)",
                [&id],
                |r| r.get::<_, i64>(0),
            )
            .map_err(db_error)?
            != 0
        {
            reasons.push("incomplete cleanup operation".to_string());
        }
        if connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM kanban_cards WHERE parent_id=?1)",
                [&id],
                |r| r.get::<_, i64>(0),
            )
            .map_err(db_error)?
            != 0
        {
            reasons.push("retained hierarchy".to_string());
        }
        if connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM environment_creation_operations WHERE card_id=?1)
                    OR EXISTS(SELECT 1 FROM card_target_merge_operations WHERE card_id=?1)
                    OR EXISTS(SELECT 1 FROM scripted_delivery_operations WHERE card_id=?1)
                    OR EXISTS(SELECT 1 FROM provider_sync_operations WHERE card_id=?1 AND state IN ('pending','running','failed'))
                    OR EXISTS(SELECT 1 FROM kanban_cards WHERE id=?1 AND delivery_operation_stage IS NOT NULL)
                    OR EXISTS(SELECT 1 FROM card_pull_requests WHERE card_id=?1 AND state!='merged')",
                [&id],
                |r| r.get::<_, i64>(0),
            )
            .map_err(db_error)?
            != 0
        {
            reasons.push("unresolved provider/delivery operation".to_string());
        }
        if reasons.is_empty() {
            continue;
        }
        findings.push(finding(
            DONE_RETENTION_BLOCKED,
            &id,
            &title,
            &status,
            project_id.as_deref(),
            workflow_revision,
            "Done retention cannot retire this card while these resources or operations remain.",
            reasons,
        ));
    }
    Ok(findings)
}

fn card_capabilities_reason(
    connection: &Connection,
    id: &str,
) -> Result<Option<(String, String, Vec<String>)>, String> {
    let Some(card) = get_card_detail(connection, id)? else {
        return Ok(None);
    };
    if !matches!(
        card.status,
        CardStatus::NeedsRefinement
            | CardStatus::NeedsRefinementInput
            | CardStatus::Ready
            | CardStatus::NeedsHuman
            | CardStatus::Approved
            | CardStatus::Refining
    ) {
        return Ok(None);
    }
    let context = workflow_context_for_card(connection, &card)?;
    let capabilities = workflow::capabilities(&context);
    let available = capabilities.iter().filter(|item| item.available).count();
    if !context.project_present {
        return Ok(Some((
            card.title,
            card.status.to_string(),
            vec!["Assign a project first".into()],
        )));
    }
    if !context.provider_compatible {
        return Ok(Some((
            card.title,
            card.status.to_string(),
            vec!["The card provider is incompatible with its project".into()],
        )));
    }
    if available == 0 {
        let mut reasons = capabilities
            .iter()
            .filter_map(|item| item.disabled_reason.clone())
            .collect::<Vec<_>>();
        reasons.sort();
        reasons.dedup();
        if reasons.is_empty() {
            reasons
                .push("No workflow action is available for the stored status and context.".into());
        }
        return Ok(Some((card.title, card.status.to_string(), reasons)));
    }
    Ok(None)
}

fn unactionable_findings(
    connection: &Connection,
    options: ScanOptions,
    stale_ids: &std::collections::HashSet<String>,
) -> Result<Vec<BoardHealthFinding>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,title,status,project_id,workflow_revision,external_provider
             FROM kanban_cards WHERE in_scope=1 ORDER BY id",
        )
        .map_err(db_error)?;
    let cards = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let mut findings = Vec::new();
    for (id, title, status, project_id, workflow_revision, provider) in cards {
        let mut reasons = Vec::new();
        let project = project_id.as_deref().and_then(|project_id| {
            connection
                .query_row(
                    "SELECT COALESCE(kanban_source,'local') FROM projects WHERE id=?1",
                    [project_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .ok()
                .flatten()
        });
        if project.is_none() {
            reasons.push("Assign a project first".to_string());
        } else if project.as_deref()
            != Some(if provider == "superthread" {
                "superthread"
            } else {
                "local"
            })
        {
            reasons.push("The card provider is incompatible with its project".to_string());
        }
        if stale_ids.contains(&id) {
            reasons.push(
                "Stored aggregate metadata conflicts with the card's linked children.".into(),
            );
        }
        if options.inspect_capabilities {
            if let Some((_, _, capability_reasons)) = card_capabilities_reason(connection, &id)? {
                reasons.extend(capability_reasons);
                reasons.sort();
                reasons.dedup();
            }
        }
        if reasons.is_empty() {
            continue;
        }
        findings.push(finding(
            UNACTIONABLE_CARD,
            &id,
            &title,
            &status,
            project_id.as_deref(),
            workflow_revision,
            "This card is unactionable with its current stored status and derived context.",
            reasons,
        ));
    }
    Ok(findings)
}

fn scan_board_health(
    connection: &Connection,
    options: ScanOptions,
) -> Result<BoardHealthReport, String> {
    let stale = stale_parent_rows(connection)?;
    let stale_ids = stale
        .iter()
        .map(|row| row.id.clone())
        .collect::<std::collections::HashSet<_>>();
    let mut findings = Vec::new();
    for row in &stale {
        findings.extend(stale_parent_finding(row, false));
    }
    findings.extend(unactionable_findings(connection, options, &stale_ids)?);
    findings.extend(done_retention_findings(connection)?);
    if options.inspect_environments {
        findings.extend(environment_findings(connection)?);
    }
    findings.sort_by(|left, right| {
        left.invariant
            .cmp(&right.invariant)
            .then_with(|| left.card_id.cmp(&right.card_id))
            .then_with(|| left.environment_id.cmp(&right.environment_id))
    });
    Ok(BoardHealthReport {
        repaired: 0,
        findings,
        board_revision: board_revision(connection)?,
        scanned_at: unix_timestamp(),
    })
}

#[cfg(test)]
fn pass_on(
    connection: &mut Connection,
    automatic_repairs: bool,
    options: ScanOptions,
) -> Result<BoardHealthReport, String> {
    let repaired = if automatic_repairs {
        execute_board_mutation(connection, repair_stale_parent_metadata)?.0
    } else {
        Vec::new()
    };
    let mut report = scan_board_health(connection, options)?;
    report.repaired = repaired.len();
    if !repaired.is_empty() {
        let mut findings = repaired;
        findings.append(&mut report.findings);
        report.findings = findings;
    }
    Ok(report)
}

pub(in crate::kanban) fn board_health_pass(
    automatic_repairs: bool,
) -> Result<BoardHealthReport, String> {
    if automatic_repairs {
        let repaired = with_board_mutation(repair_stale_parent_metadata)?;
        let mut report = with_read_connection(|connection| {
            scan_board_health(
                connection,
                ScanOptions {
                    inspect_environments: true,
                    inspect_capabilities: true,
                },
            )
        })?;
        report.repaired = repaired.len();
        if !repaired.is_empty() {
            let mut findings = repaired;
            findings.append(&mut report.findings);
            report.findings = findings;
        }
        Ok(report)
    } else {
        with_read_connection(|connection| {
            scan_board_health(
                connection,
                ScanOptions {
                    inspect_environments: false,
                    inspect_capabilities: false,
                },
            )
        })
    }
}

/// Startup uses the cheap read-only projection, off the first-frame path.
pub(crate) fn startup_board_health_report() -> Result<BoardHealthReport, String> {
    board_health_pass(false)
}

fn branch_is_claimed_elsewhere(
    connection: &Connection,
    environment_id: &str,
    branch: &str,
) -> Result<bool, String> {
    let claimed: i64 = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM card_environments WHERE id!=?1 AND branch=?2)
                OR EXISTS(SELECT 1 FROM environment_creation_operations WHERE source_branch=?2)
                OR EXISTS(SELECT 1 FROM card_target_merge_operations WHERE source_branch=?2)
                OR EXISTS(SELECT 1 FROM card_cleanup_operations WHERE source_branch=?2)
                OR EXISTS(SELECT 1 FROM card_retirements,json_each(card_retirements.resources) WHERE json_extract(value,'$.branch')=?2)",
            params![environment_id, branch],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    Ok(claimed != 0)
}

fn cleanup_orphaned_environment(
    card_id: &str,
    environment_id: &str,
    expected_environment_revision: i64,
    confirmed: bool,
) -> Result<(), String> {
    with_board_mutation(|connection| {
        cleanup_orphaned_environment_in(
            connection,
            card_id,
            environment_id,
            expected_environment_revision,
            confirmed,
        )
    })
}

fn cleanup_orphaned_environment_in(
    connection: &mut Connection,
    card_id: &str,
    environment_id: &str,
    expected_environment_revision: i64,
    confirmed: bool,
) -> Result<(), String> {
    if !confirmed {
        return Err("Explicit confirmation is required before cleaning up an environment".into());
    }
    let row = environment_rows(connection)?
        .into_iter()
        .find(|row| row.card_id == card_id && row.id == environment_id)
        .ok_or_else(|| "The environment is already gone; refresh board health.".to_string())?;
    if row.revision != expected_environment_revision {
        return Err("The environment changed after inspection; refresh board health.".into());
    }
    let evidence = inspect_environment(connection, &row)?.ok_or_else(|| {
        "The environment is still present or cannot be treated as orphaned.".to_string()
    })?;
    if !evidence.cleanup_available {
        return Err(format!(
            "Environment cleanup is not available: {}",
            evidence.reasons.join("; ")
        ));
    }
    let target_path = row
        .target_checkout_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or(row.project_path.as_deref())
        .ok_or_else(|| "The environment has no target checkout to verify.".to_string())?;
    let target_branch = row
        .target_branch
        .as_deref()
        .or(row.project_target_branch.as_deref())
        .unwrap_or("main");
    let mut branch_disposition = "no local branch remained";
    if evidence.branch_exists && row.branch != target_branch {
        let checked_out = worktree_inventory(target_path)?
            .iter()
            .any(|worktree| worktree.branch.as_deref() == Some(row.branch.as_str()));
        if checked_out {
            branch_disposition = "local branch retained: checked out in another worktree";
        } else if branch_is_claimed_elsewhere(connection, &row.id, &row.branch)? {
            branch_disposition = "local branch retained: another resource ledger still claims it";
        } else if let Some(tip) = evidence.branch_tip.as_deref() {
            git_output(
                target_path,
                &[
                    "update-ref",
                    "-d",
                    &format!("refs/heads/{}", row.branch),
                    tip,
                ],
            )?;
            branch_disposition = "local branch deleted with exact-tip merge proof";
        }
    }
    let removed = connection
        .execute(
            "DELETE FROM card_environments WHERE id=?1 AND card_id=?2 AND revision=?3",
            params![row.id, row.card_id, row.revision],
        )
        .map_err(db_error)?;
    if removed != 1 {
        return Err("The environment changed during cleanup; refresh board health.".into());
    }
    connection
        .execute(
            "DELETE FROM card_pi_lifecycle WHERE card_id=?1",
            [&row.card_id],
        )
        .map_err(db_error)?;
    let updated = connection
        .execute(
            "UPDATE kanban_cards SET workflow_revision=workflow_revision+1,updated_at=?1 WHERE id=?2",
            params![unix_timestamp(), row.card_id],
        )
        .map_err(db_error)?;
    if updated != 1 {
        return Err("The card changed during environment cleanup; refresh board health.".into());
    }
    connection
        .execute(
            "INSERT INTO card_events(card_id,created_at,actor,event_type,outcome,summary)
             VALUES (?1,?2,'user','board_hygiene_cleanup_environment','success',?3)",
            params![
                row.card_id,
                unix_timestamp(),
                format!(
                    "Board hygiene removed orphaned environment {} ({branch_disposition})",
                    row.id
                )
            ],
        )
        .map_err(db_error)?;
    Ok(())
}

#[tauri::command]
pub async fn kanban_board_health() -> Result<BoardHealthReport, String> {
    tauri::async_runtime::spawn_blocking(|| board_health_pass(true))
        .await
        .map_err(|error| format!("Board health worker failed: {error}"))?
}

#[tauri::command]
pub async fn kanban_board_health_cleanup_environment(
    app: AppHandle,
    card_id: String,
    environment_id: String,
    expected_environment_revision: i64,
    confirmed: bool,
) -> Result<BoardHealthReport, String> {
    let pty = app.state::<Mutex<PtyRegistry>>();
    if !crate::pty::card_pty_runtime_ids(pty.inner(), &card_id)?.is_empty() {
        return Err(
            "Card terminal processes are running; stop them before cleaning up the environment."
                .to_string(),
        );
    }
    let pi = app.state::<Mutex<PiRpcRegistry>>();
    if !crate::pi_rpc::card_pi_runtime_ids(pi.inner(), &card_id)?.is_empty() {
        return Err(
            "Card Pi processes are running; stop them before cleaning up the environment."
                .to_string(),
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        cleanup_orphaned_environment(
            &card_id,
            &environment_id,
            expected_environment_revision,
            confirmed,
        )?;
        board_health_pass(true)
    })
    .await
    .map_err(|error| format!("Board health cleanup worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::super::repository::initialize_connection;
    use super::*;

    fn database() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        initialize_connection(&mut connection).unwrap();
        connection
    }

    fn project(connection: &Connection, id: &str, path: &str) {
        connection
            .execute(
                "INSERT INTO projects(id,name,path,kanban_source) VALUES (?1,?1,?2,'local')",
                params![id, path],
            )
            .unwrap();
    }

    fn card(
        connection: &Connection,
        id: &str,
        project_id: Option<&str>,
        status: &str,
        finalized: bool,
        child_count: i64,
    ) {
        connection
            .execute(
                "INSERT INTO kanban_cards(id,external_provider,external_id,title,project_id,status,hierarchy_finalized,provider_child_count,created_at,updated_at,in_scope)
                 VALUES (?1,'local:p',?1,?1,?2,?3,?4,?5,1,1,1)",
                params![id, project_id, status, finalized as i64, child_count],
            )
            .unwrap();
    }

    fn git(path: &Path, args: &[&str]) -> String {
        git_output(path.to_str().unwrap(), args).unwrap()
    }

    fn git_fixture() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target");
        fs::create_dir(&target).unwrap();
        git(&target, &["init", "-b", "main"]);
        git(&target, &["config", "user.name", "Test"]);
        git(&target, &["config", "user.email", "test@example.invalid"]);
        fs::write(target.join("base"), "base").unwrap();
        git(&target, &["add", "."]);
        git(&target, &["commit", "-m", "base"]);
        (root, target)
    }

    fn merged_branch(target: &Path, branch: &str, worktree: &Path) -> String {
        git(
            target,
            &["worktree", "add", "-b", branch, worktree.to_str().unwrap()],
        );
        fs::write(worktree.join("card"), "card work").unwrap();
        git(worktree, &["add", "."]);
        git(worktree, &["commit", "-m", "card work"]);
        let tip = git(worktree, &["rev-parse", "HEAD"]);
        git(target, &["merge", "--no-ff", branch, "-m", "merge card"]);
        git(target, &["worktree", "remove", worktree.to_str().unwrap()]);
        tip
    }

    #[test]
    fn finalized_parent_is_detected_repaired_and_second_run_is_clean() {
        let mut db = database();
        project(&db, "p", "/repo");
        card(&db, "parent", Some("p"), "ready", true, 2);
        let before_revision = board_revision(&db).unwrap();
        let loaded = get_card(&db, "parent").unwrap().unwrap();
        let context = workflow_context_for_card(&db, &loaded).unwrap();
        // The workflow must derive aggregate state from linked children, not the stale flag.
        assert!(!context.hierarchy_finalized);
        assert!(!workflow::capabilities(&context).is_empty());
        let first = pass_on(
            &mut db,
            true,
            ScanOptions {
                inspect_environments: true,
                inspect_capabilities: true,
            },
        )
        .unwrap();
        assert_eq!(first.repaired, 2);
        assert!(first
            .findings
            .iter()
            .any(|finding| finding.invariant == FINALIZED_WITHOUT_CHILDREN && finding.repaired));
        assert!(first
            .findings
            .iter()
            .any(|finding| finding.invariant == STALE_PARENT_CHILD_COUNT && finding.repaired));
        let (finalized, count): (i64, i64) = db
            .query_row(
                "SELECT hierarchy_finalized,provider_child_count FROM kanban_cards WHERE id='parent'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((finalized, count), (0, 0));
        assert!(board_revision(&db).unwrap() > before_revision);
        let event: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM card_events WHERE card_id='parent' AND event_type='board_hygiene_repair'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event, 1);
        let second = pass_on(
            &mut db,
            true,
            ScanOptions {
                inspect_environments: true,
                inspect_capabilities: true,
            },
        )
        .unwrap();
        assert!(second.findings.is_empty(), "{:?}", second.findings);
        assert_eq!(second.repaired, 0);
    }

    #[test]
    fn stale_child_count_without_finalized_flag_is_repaired_for_local_cards() {
        let mut db = database();
        project(&db, "p", "/repo");
        card(&db, "parent", Some("p"), "ready", false, 3);
        let report = pass_on(
            &mut db,
            true,
            ScanOptions {
                inspect_environments: false,
                inspect_capabilities: false,
            },
        )
        .unwrap();
        assert_eq!(report.repaired, 1);
        assert_eq!(
            db.query_row(
                "SELECT provider_child_count FROM kanban_cards WHERE id='parent'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn missing_unregistered_environment_requires_merge_proof_and_cleans_idempotently() {
        let (_root, target) = git_fixture();
        let worktree = target.parent().unwrap().join("card-worktree");
        let tip = merged_branch(&target, "card-331", &worktree);
        let mut db = database();
        project(&db, "p", target.to_str().unwrap());
        card(&db, "local:331", Some("p"), "done", false, 0);
        db.execute(
            "UPDATE kanban_cards SET completion_outcome='merged' WHERE id='local:331'",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO card_environments(id,card_id,project_id,worktree_path,branch,repository_id,target_checkout_path,target_branch,source_revision,created_at,updated_at)
             VALUES ('env','local:331','p',?1,'card-331',?2,?3,'main',?4,1,1)",
            params![
                worktree.to_str().unwrap(),
                repository_identity(target.to_str().unwrap()).unwrap(),
                target.to_str().unwrap(),
                tip
            ],
        )
        .unwrap();
        let revision = db
            .query_row(
                "SELECT revision FROM card_environments WHERE id='env'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        let before_revision = board_revision(&db).unwrap();
        let first = pass_on(
            &mut db,
            true,
            ScanOptions {
                inspect_environments: true,
                inspect_capabilities: true,
            },
        )
        .unwrap();
        let finding = first
            .findings
            .iter()
            .find(|finding| finding.invariant == ORPHANED_ENVIRONMENT)
            .unwrap();
        assert_eq!(finding.action.as_deref(), Some(ACTION_CLEANUP_ENVIRONMENT));
        assert!(finding
            .reasons
            .iter()
            .any(|reason| reason.contains("ancestor")));
        execute_board_mutation(&mut db, |connection| {
            cleanup_orphaned_environment_in(connection, "local:331", "env", revision, true)
        })
        .unwrap();
        assert!(board_revision(&db).unwrap() > before_revision);
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM card_environments", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            local_ref_tip(target.to_str().unwrap(), "card-331").unwrap(),
            None
        );
        let event: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM card_events WHERE card_id='local:331' AND event_type='board_hygiene_cleanup_environment'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event, 1);
        let second = pass_on(
            &mut db,
            true,
            ScanOptions {
                inspect_environments: true,
                inspect_capabilities: true,
            },
        )
        .unwrap();
        assert!(second.findings.is_empty(), "{:?}", second.findings);
        assert!(execute_board_mutation(&mut db, |connection| {
            cleanup_orphaned_environment_in(connection, "local:331", "env", revision, true)
        })
        .is_err());
    }

    #[test]
    fn unmerged_orphaned_environment_is_reported_but_never_offered_for_cleanup() {
        let (_root, target) = git_fixture();
        let worktree = target.parent().unwrap().join("unmerged-worktree");
        git(
            &target,
            &[
                "worktree",
                "add",
                "-b",
                "unmerged-331",
                worktree.to_str().unwrap(),
            ],
        );
        fs::write(worktree.join("card"), "unmerged work").unwrap();
        git(&worktree, &["add", "."]);
        git(&worktree, &["commit", "-m", "unmerged work"]);
        git(&target, &["worktree", "remove", worktree.to_str().unwrap()]);
        let mut db = database();
        project(&db, "p", target.to_str().unwrap());
        card(&db, "local:331", Some("p"), "done", false, 0);
        db.execute(
            "INSERT INTO card_environments(id,card_id,project_id,worktree_path,branch,repository_id,target_checkout_path,target_branch,created_at,updated_at)
             VALUES ('env','local:331','p',?1,'unmerged-331',?2,?3,'main',1,1)",
            params![
                worktree.to_str().unwrap(),
                repository_identity(target.to_str().unwrap()).unwrap(),
                target.to_str().unwrap()
            ],
        )
        .unwrap();
        let report = pass_on(
            &mut db,
            false,
            ScanOptions {
                inspect_environments: true,
                inspect_capabilities: false,
            },
        )
        .unwrap();
        let finding = report
            .findings
            .iter()
            .find(|finding| finding.invariant == ORPHANED_ENVIRONMENT)
            .unwrap();
        assert!(finding.action.is_none());
        assert!(finding
            .reasons
            .iter()
            .any(|reason| reason == "Exact source revision is not authoritatively merged."));
        assert!(execute_board_mutation(&mut db, |connection| {
            cleanup_orphaned_environment_in(connection, "local:331", "env", 1, true)
        })
        .is_err());
        assert!(local_ref_tip(target.to_str().unwrap(), "unmerged-331")
            .unwrap()
            .is_some());
    }

    #[test]
    fn existing_or_registered_checkouts_are_not_treated_as_dead() {
        let (_root, target) = git_fixture();
        let existing = target.parent().unwrap().join("present-unregistered");
        fs::create_dir(&existing).unwrap();
        let registered = target.parent().unwrap().join("registered-missing");
        git(
            &target,
            &[
                "worktree",
                "add",
                "-b",
                "registered-branch",
                registered.to_str().unwrap(),
            ],
        );
        fs::remove_dir_all(&registered).unwrap();
        let mut db = database();
        project(&db, "p", target.to_str().unwrap());
        card(&db, "present", Some("p"), "ready", false, 0);
        card(&db, "registered", Some("p"), "ready", false, 0);
        for (id, path, branch) in [
            ("present", existing.to_str().unwrap(), "card-present"),
            (
                "registered",
                registered.to_str().unwrap(),
                "registered-branch",
            ),
        ] {
            db.execute(
                "INSERT INTO card_environments(id,card_id,project_id,worktree_path,branch,repository_id,target_checkout_path,target_branch,created_at,updated_at)
                 VALUES (?1,?2,'p',?3,?4,?5,?6,'main',1,1)",
                params![
                    format!("env-{id}"),
                    id,
                    path,
                    branch,
                    repository_identity(target.to_str().unwrap()).unwrap(),
                    target.to_str().unwrap()
                ],
            )
            .unwrap();
        }
        let report = pass_on(
            &mut db,
            false,
            ScanOptions {
                inspect_environments: true,
                inspect_capabilities: false,
            },
        )
        .unwrap();
        assert!(report
            .findings
            .iter()
            .all(|finding| finding.invariant != ORPHANED_ENVIRONMENT));
    }

    #[test]
    fn done_retention_and_unactionable_cards_explain_the_reason() {
        let mut db = database();
        project(&db, "p", "/repo");
        card(&db, "blocked", Some("p"), "done", false, 0);
        card(&db, "parent", Some("p"), "done", false, 0);
        card(&db, "child", Some("p"), "ready", false, 0);
        db.execute(
            "UPDATE kanban_cards SET parent_id='parent' WHERE id='child'",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO card_environments(id,card_id,project_id,worktree_path,branch,created_at,updated_at)
             VALUES ('env','blocked','p','/missing/worktree','card',1,1)",
            [],
        )
        .unwrap();
        card(&db, "orphan-project", None, "ready", false, 0);
        let report = pass_on(
            &mut db,
            false,
            ScanOptions {
                inspect_environments: false,
                inspect_capabilities: true,
            },
        )
        .unwrap();
        let blocked = report
            .findings
            .iter()
            .find(|finding| {
                finding.invariant == DONE_RETENTION_BLOCKED && finding.card_id == "blocked"
            })
            .unwrap();
        assert!(blocked
            .reasons
            .iter()
            .any(|reason| reason == "owning environment"));
        let hierarchy = report
            .findings
            .iter()
            .find(|finding| {
                finding.invariant == DONE_RETENTION_BLOCKED && finding.card_id == "parent"
            })
            .unwrap();
        assert!(hierarchy
            .reasons
            .iter()
            .any(|reason| reason == "retained hierarchy"));
        let unactionable = report
            .findings
            .iter()
            .find(|finding| {
                finding.invariant == UNACTIONABLE_CARD && finding.card_id == "orphan-project"
            })
            .unwrap();
        assert!(unactionable
            .reasons
            .iter()
            .any(|reason| reason == "Assign a project first"));
    }
}
