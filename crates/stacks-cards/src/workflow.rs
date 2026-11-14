//! LIST presentation projection: status groups and delivery labels.
//!
//! This mirrors `src/kanban/workflowGroups.ts` and `deliveryStep.ts`. It is a
//! projection only; transitions remain owned by the Tauri workflow. A contract
//! test checks the status set against the generated frontend contract.

use crate::model::{
    CardSnapshot, CardStatus, CardSummary, DeliveryStep, DeliveryWorkflow, Project, WorkGroup,
};

pub fn work_group(card: &CardSummary, projects: &[Project]) -> WorkGroup {
    if card.status == CardStatus::Approved {
        return if delivery_step(card, projects).action_required {
            WorkGroup::Attention
        } else {
            WorkGroup::Progress
        };
    }
    WorkGroup::ALL
        .into_iter()
        .find(|group| group.statuses().contains(&card.status))
        .unwrap_or(WorkGroup::Attention)
}

pub fn group_cards<'a>(
    cards: &'a [CardSummary],
    group: WorkGroup,
    projects: &[Project],
) -> Vec<&'a CardSummary> {
    let mut entries = cards
        .iter()
        .filter(|card| work_group(card, projects) == group)
        .collect::<Vec<_>>();
    entries.sort_by_key(|card| {
        group
            .statuses()
            .iter()
            .position(|status| *status == card.status)
            .unwrap_or(group.statuses().len())
    });
    entries
}

/// Mirrors the React `deliveryStep` UI projection. The backend capabilities and
/// fresh preflight still decide whether an action can actually run.
pub fn delivery_step(card: &CardSummary, projects: &[Project]) -> DeliveryStep {
    if card.hierarchy_finalized && card.child_count > 0 {
        if card.status == CardStatus::Done {
            let complete = card.children.len() as u64 == card.child_count
                && card
                    .children
                    .iter()
                    .all(|child| child.status == CardStatus::Done);
            return DeliveryStep::new(
                if complete {
                    "Children complete"
                } else {
                    "Child status unverified · Check hierarchy"
                },
                false,
            );
        }
        let child_step = match card.status {
            CardStatus::NeedsRefinement => "Children in backlog",
            CardStatus::Refining => "Children refining",
            CardStatus::NeedsRefinementInput => "Children need refinement input",
            CardStatus::Ready => "Children ready for agent",
            CardStatus::AgentWorking => "Children working",
            CardStatus::NeedsHuman => "Children need review",
            CardStatus::Approved => "Children in delivery",
            CardStatus::Done => "Children complete",
        };
        return DeliveryStep::new(child_step, false);
    }
    if card.status == CardStatus::Done {
        return DeliveryStep::new(
            if card.completion_outcome.as_deref() == Some("merged") {
                "Delivered"
            } else {
                "Closed"
            },
            false,
        );
    }
    if card.child_count > 0 && card.status == CardStatus::Approved {
        return DeliveryStep::new("Children in delivery", false);
    }
    match card.status {
        CardStatus::NeedsRefinement => return DeliveryStep::new("Awaiting refinement", false),
        CardStatus::Refining => return DeliveryStep::new("Refining", false),
        CardStatus::NeedsRefinementInput => {
            return DeliveryStep::new("Refinement input needed", true);
        }
        CardStatus::Ready => return DeliveryStep::new("Start work", true),
        CardStatus::AgentWorking => return DeliveryStep::new("Agent working", false),
        CardStatus::NeedsHuman => return DeliveryStep::new("Review & commit", true),
        CardStatus::Done => unreachable!(),
        CardStatus::Approved => {}
    }

    let Some(project) = card.project(projects) else {
        return DeliveryStep::new("Project unavailable · Check setup", true);
    };
    let stage = card.delivery_operation_stage.as_deref();
    if project.delivery_workflow == DeliveryWorkflow::ScriptedDelivery {
        let label = match stage {
            Some("merged") => DeliveryStep::new("Merged locally · Push", true),
            Some("pushing") => DeliveryStep::new("Pushing", false),
            Some("push_failed") => DeliveryStep::new("Push failed · Retry push", true),
            Some("pushed") => DeliveryStep::new("Pushed · Deploy", true),
            Some("deploying") => DeliveryStep::new("Deploying", false),
            Some("deployment_failed") => DeliveryStep::new("Deployment failed · Retry", true),
            Some("uncertain") => DeliveryStep::new("Deployment uncertain · Resolve", true),
            Some("deployed") => DeliveryStep::new("Deployed · Reconciling", false),
            Some("cancelled") => DeliveryStep::new("Delivery cancelled · Resolve", true),
            Some(_) | None => {
                if stage.is_none() && card.delivery_error.is_some() {
                    DeliveryStep::new(
                        format!(
                            "Delivery blocked · {}",
                            card.delivery_error.as_deref().unwrap_or_default()
                        ),
                        true,
                    )
                } else if stage.is_none() {
                    if card
                        .environment
                        .as_ref()
                        .is_some_and(|environment| environment.lifecycle_state == "ready")
                    {
                        DeliveryStep::new("Merge locally · Check & confirm", true)
                    } else {
                        DeliveryStep::new("Environment unavailable · Check setup", true)
                    }
                } else {
                    DeliveryStep::new("Delivery in progress", false)
                }
            }
        };
        return label;
    }
    if matches!(
        stage,
        Some("merging_pr" | "creating_pr" | "deleting_remote_branch")
    ) {
        return DeliveryStep::new("Delivery in progress", false);
    }
    if stage == Some("branch_pushed") {
        return DeliveryStep::new("Branch pushed · Create PR", true);
    }
    if let Some(error) = card.delivery_error.as_deref() {
        return DeliveryStep::new(format!("Delivery blocked · {error}"), true);
    }
    if project.delivery_workflow == DeliveryWorkflow::LocalMerge {
        if stage == Some("merged") {
            return DeliveryStep::new("Merged locally · Push failed", true);
        }
        if !card
            .environment
            .as_ref()
            .is_some_and(|environment| environment.lifecycle_state == "ready")
        {
            return DeliveryStep::new("Environment unavailable · Check setup", true);
        }
        return DeliveryStep::new("Merge locally · Check & confirm", true);
    }
    if project.delivery_workflow != DeliveryWorkflow::GithubPullRequest {
        return DeliveryStep::new("Delivery setup unavailable", true);
    }

    let Some(pr) = card.pull_request.as_ref() else {
        return if card
            .environment
            .as_ref()
            .is_some_and(|environment| environment.lifecycle_state == "ready")
        {
            DeliveryStep::new("Committed · Create PR", true)
        } else {
            DeliveryStep::new("Environment unavailable · Check setup", true)
        };
    };
    match pr.state.as_str() {
        "merged" => return DeliveryStep::new("PR merged · Reconciling", false),
        "closed" => return DeliveryStep::new("PR closed · Resolve", true),
        _ => {}
    }
    if pr.has_conflicts {
        return DeliveryStep::new("PR blocked · Resolve conflicts", true);
    }
    if pr.draft {
        return DeliveryStep::new("PR draft · Mark ready", true);
    }
    if pr.ci_status == "pending"
        && pr.blockers.iter().all(|blocker| {
            blocker == "CI is pending" || blocker == "GitHub merge readiness is unknown or blocked"
        })
    {
        return DeliveryStep::new("PR open · CI running", false);
    }
    if pr.ci_status == "unknown" {
        return DeliveryStep::new("PR checks unknown · Inspect", true);
    }
    if let Some(blocker) = pr.blockers.first() {
        return DeliveryStep::new(format!("PR blocked · {blocker}"), true);
    }
    let mut step = DeliveryStep::new("PR merge available · Merge PR", true);
    step.pr_merge_ready = true;
    step
}

/// Replace only the visible slots in the canonical lane order. Hidden cards
/// keep their relative order and positions, matching the React list drag.
pub fn merge_filtered_lane_order(
    all_cards: &[CardSummary],
    status: CardStatus,
    visible_ordered_ids: &[String],
) -> Vec<String> {
    let lane_ids = all_cards
        .iter()
        .filter(|card| card.status == status)
        .map(|card| card.id.clone())
        .collect::<Vec<_>>();
    let visible = visible_ordered_ids
        .iter()
        .collect::<std::collections::HashSet<_>>();
    let mut next_visible = 0;
    lane_ids
        .into_iter()
        .map(|id| {
            if visible.contains(&id) {
                let replacement = visible_ordered_ids.get(next_visible).cloned().unwrap_or(id);
                next_visible += 1;
                replacement
            } else {
                id
            }
        })
        .collect()
}

pub fn backlog_cards<'a>(snapshot: &'a CardSnapshot) -> Vec<&'a CardSummary> {
    group_cards(&snapshot.cards, WorkGroup::Backlog, &snapshot.projects)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_canonical_status_belongs_to_exactly_one_group() {
        let statuses = WorkGroup::ALL
            .into_iter()
            .flat_map(|group| group.statuses().iter().copied())
            .collect::<Vec<_>>();
        assert_eq!(statuses.len(), CardStatus::ALL.len());
        for status in CardStatus::ALL {
            assert_eq!(
                statuses.iter().filter(|entry| **entry == status).count(),
                1,
                "{status} must be in exactly one LIST group"
            );
        }
        assert_eq!(
            CardStatus::ALL.map(|status| status.label()),
            [
                "Needs refinement",
                "Refining",
                "Needs you for refinement",
                "Ready for agent",
                "Agent working",
                "Needs you",
                "Approved",
                "Done",
            ]
        );
    }

    #[test]
    fn generated_frontend_contract_matches_rust_statuses() {
        let source = std::fs::read_to_string(format!(
            "{}/../../src/kanban/workflowContract.generated.ts",
            env!("CARGO_MANIFEST_DIR")
        ))
        .expect("workflow contract");
        let block = source
            .split("KANBAN_STATUS_METADATA = [")
            .nth(1)
            .and_then(|rest| rest.split("] as const").next())
            .expect("status block");
        let statuses = block
            .lines()
            .filter_map(|line| line.split("status: '").nth(1))
            .filter_map(|line| line.split('\'').next())
            .collect::<Vec<_>>();
        assert_eq!(
            statuses,
            CardStatus::ALL.map(|status| status.as_str()).to_vec()
        );
    }

    #[test]
    fn filtered_reorder_preserves_hidden_slots() {
        let cards = ["a", "b", "c", "d"]
            .into_iter()
            .map(|id| CardSummary {
                id: id.into(),
                provider: "local".into(),
                external_id: id.into(),
                title: id.into(),
                board_id: String::new(),
                board_title: String::new(),
                list_title: String::new(),
                assignee_names: Vec::new(),
                status: CardStatus::NeedsRefinement,
                completion_outcome: None,
                workflow_revision: 1,
                record_revision: 1,
                project_id: None,
                parent: None,
                child_count: 0,
                children: Vec::new(),
                hierarchy_finalized: false,
                environment: None,
                pull_request: None,
                delivery_operation_stage: None,
                delivery_error: None,
                created_at: 0,
                updated_at: 0,
                sort_order: 0,
            })
            .collect::<Vec<_>>();
        // Visible order c,d after filtering out a,b: canonical slots 3 and 4
        // become d,c, while a,b keep positions 1 and 2.
        let merged = merge_filtered_lane_order(
            &cards,
            CardStatus::NeedsRefinement,
            &["d".into(), "c".into()],
        );
        assert_eq!(merged, ["a", "b", "d", "c"]);
    }
}
