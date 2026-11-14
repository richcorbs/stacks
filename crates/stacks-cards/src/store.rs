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
use rusqlite::{Connection, OpenFlags, params};

use crate::{
    model::{
        CardDetail, CardEvent, CardSnapshot, CardStatus, CardSummary, DeliveryWorkflow,
        EnvironmentIndicator, Project, PullRequestIndicator, Relationship,
    },
    workflow::merge_filtered_lane_order,
};

pub const DATABASE_ENV: &str = "STACKS_GPUI_CARDS_DB";
pub const REORDER_CONFLICT_CODE: &str = "KANBAN_REORDER_CONFLICT";

#[derive(Clone, Debug)]
pub struct CardStore {
    path: PathBuf,
}

impl CardStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Real Stacks data by default. The GPUI shell is a read-only observer of
    /// the shipped app's database; override with `STACKS_GPUI_CARDS_DB`.
    pub fn default_store() -> Self {
        if let Some(path) = std::env::var_os(DATABASE_ENV) {
            return Self::new(path);
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        Self::new(
            home.join("Library/Application Support/stacks")
                .join("workflow.sqlite3"),
        )
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
            .into_iter()
            .find(|card| card.id == card_id)
            .ok_or_else(|| {
                anyhow::anyhow!("Card is not in scope or no longer exists: {card_id}")
            })?;
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
        Ok(CardDetail {
            card,
            content,
            card_url,
            feature_environment,
            runtime_cleanup_status,
            runtime_cleanup_error,
            events,
        })
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
        "SELECT id, name, path, color_id, delivery_workflow, kanban_source
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
