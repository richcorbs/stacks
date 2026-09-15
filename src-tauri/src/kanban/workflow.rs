use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

macro_rules! string_enum {
    ($name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $($variant),+ }
        impl $name {
            pub const fn as_str(self) -> &'static str { match self { $(Self::$variant => $value),+ } }
        }
        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result { formatter.write_str(self.as_str()) }
        }
        impl FromStr for $name {
            type Err = String;
            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value { $($value => Ok(Self::$variant),)+ _ => Err(format!("Unknown {}: {value}", stringify!($name))) }
            }
        }
        impl PartialEq<&str> for $name {
            fn eq(&self, other: &&str) -> bool { self.as_str() == *other }
        }
        impl PartialEq<$name> for &str {
            fn eq(&self, other: &$name) -> bool { *self == other.as_str() }
        }
        impl rusqlite::types::FromSql for $name {
            fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
                let text = value.as_str()?;
                text.parse().map_err(|error: String| rusqlite::types::FromSqlError::Other(error.into()))
            }
        }
        impl rusqlite::types::ToSql for $name {
            fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> { Ok(self.as_str().into()) }
        }
    };
}

string_enum!(CardStatus {
    NeedsRefinement => "needs_refinement",
    Refining => "refining",
    NeedsRefinementInput => "needs_refinement_input",
    Ready => "ready",
    AgentWorking => "agent_working",
    NeedsHuman => "needs_human",
    Approved => "approved",
    Done => "done",
});

string_enum!(CompletionOutcome { Merged => "merged", Closed => "closed" });
string_enum!(WorkflowActor { User => "user", Agent => "agent", System => "system" });
string_enum!(WorkflowEventOutcome { Success => "success", Failure => "failure" });
string_enum!(WorkflowAction {
    OpenRefinement => "open_refinement",
    FinishRefinement => "finish_refinement",
    StopRefinement => "stop_refinement",
    StartWork => "start_work",
    ReturnToRefinement => "return_to_refinement",
    RequestChanges => "request_changes",
    Ship => "ship",
    ShipWithFe => "ship_with_fe",
    MergeLocal => "merge_local",
    CreatePr => "create_pr",
    OpenPr => "open_pr",
    MergePr => "merge_pr",
    Cleanup => "cleanup",
    Close => "close",
    Delete => "delete",
});
string_enum!(PiLifecycleIntent {
    AgentStarted => "agent_started",
    AgentSettled => "agent_settled",
    ProtocolFailed => "protocol_failed",
    ProcessExited => "process_exited",
    UiInputRequested => "ui_input_requested",
    UiInputResolved => "ui_input_resolved",
});
string_enum!(PiThread { Planning => "planning", Work => "work" });
string_enum!(DeliveryWorkflow { LocalMerge => "local_merge", GithubPullRequest => "github_pull_request" });
string_enum!(EnvironmentLifecycle { Creating => "creating", Ready => "ready", CleanupPending => "cleanup_pending", CleanupFailed => "cleanup_failed" });
string_enum!(PullRequestState { Open => "open", Closed => "closed", Merged => "merged" });

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct StatusMetadata {
    pub status: CardStatus,
    pub label: &'static str,
}

pub const STATUS_METADATA: [StatusMetadata; 8] = [
    StatusMetadata {
        status: CardStatus::NeedsRefinement,
        label: "Needs refinement",
    },
    StatusMetadata {
        status: CardStatus::Refining,
        label: "Refining",
    },
    StatusMetadata {
        status: CardStatus::NeedsRefinementInput,
        label: "Needs you for refinement",
    },
    StatusMetadata {
        status: CardStatus::Ready,
        label: "Ready for agent",
    },
    StatusMetadata {
        status: CardStatus::AgentWorking,
        label: "Agent working",
    },
    StatusMetadata {
        status: CardStatus::NeedsHuman,
        label: "Needs you",
    },
    StatusMetadata {
        status: CardStatus::Approved,
        label: "Ready to merge",
    },
    StatusMetadata {
        status: CardStatus::Done,
        label: "Done",
    },
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkflowCapability {
    pub action: WorkflowAction,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct WorkflowContext {
    pub status: CardStatus,
    pub hierarchy_finalized: bool,
    pub provider_compatible: bool,
    pub project_present: bool,
    pub delivery_workflow: DeliveryWorkflow,
    pub supports_feature_environments: bool,
    pub environment: Option<EnvironmentLifecycle>,
    pub completion_outcome: Option<CompletionOutcome>,
    pub pull_request: Option<PullRequestState>,
    pub pull_request_blockers: Vec<String>,
    pub resumable_operation: bool,
    pub local_provider: bool,
    pub has_parent: bool,
    pub has_children: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Transition {
    pub from: CardStatus,
    pub to: CardStatus,
    pub outcome: Option<CompletionOutcome>,
}

fn transition_target(
    status: CardStatus,
    action: WorkflowAction,
) -> Option<(CardStatus, Option<CompletionOutcome>)> {
    use CardStatus::*;
    use WorkflowAction::*;
    match (status, action) {
        (NeedsRefinement | NeedsRefinementInput, OpenRefinement) => Some((Refining, None)),
        (NeedsRefinement | Refining | NeedsRefinementInput, FinishRefinement) => {
            Some((Ready, None))
        }
        (Refining | NeedsRefinementInput, StopRefinement) => Some((NeedsRefinement, None)),
        (Ready, ReturnToRefinement) => Some((NeedsRefinement, None)),
        (Ready, StartWork) => Some((AgentWorking, None)),
        (AgentWorking, RequestChanges) => Some((NeedsHuman, None)),
        (NeedsHuman, StartWork) => Some((AgentWorking, None)),
        (Approved, RequestChanges) => Some((NeedsHuman, None)),
        (AgentWorking | NeedsHuman | Approved, Ship | ShipWithFe) => Some((Approved, None)),
        (Approved, MergeLocal | MergePr) => Some((Done, Some(CompletionOutcome::Merged))),
        (
            NeedsRefinement | Refining | NeedsRefinementInput | Ready | AgentWorking | NeedsHuman
            | Approved,
            Close,
        ) => Some((Done, Some(CompletionOutcome::Closed))),
        _ => None,
    }
}

pub fn transition(
    context: &WorkflowContext,
    actor: WorkflowActor,
    action: WorkflowAction,
) -> Result<Transition, String> {
    if context.hierarchy_finalized {
        return Err("A finalized aggregate parent has no workflow".to_string());
    }
    let allowed_actor = match action {
        WorkflowAction::OpenRefinement | WorkflowAction::FinishRefinement => {
            matches!(actor, WorkflowActor::User | WorkflowActor::Agent)
        }
        WorkflowAction::StartWork | WorkflowAction::RequestChanges
            if actor == WorkflowActor::Agent =>
        {
            true
        }
        WorkflowAction::MergePr if actor == WorkflowActor::System => true,
        _ => actor == WorkflowActor::User,
    };
    if !allowed_actor {
        return Err(format!("{} cannot perform {}", actor, action));
    }
    let (to, outcome) = transition_target(context.status, action).ok_or_else(|| {
        format!(
            "{} is not available while card is {}",
            action, context.status
        )
    })?;
    Ok(Transition {
        from: context.status,
        to,
        outcome,
    })
}

fn capability(action: WorkflowAction, reason: Option<String>) -> WorkflowCapability {
    WorkflowCapability {
        action,
        available: reason.is_none(),
        disabled_reason: reason,
    }
}

fn project_reason(context: &WorkflowContext) -> Option<String> {
    if !context.project_present {
        Some("Assign a project first".to_string())
    } else if !context.provider_compatible {
        Some("The card provider is incompatible with its project".to_string())
    } else {
        None
    }
}

pub fn capabilities(context: &WorkflowContext) -> Vec<WorkflowCapability> {
    use CardStatus::*;
    use WorkflowAction::*;
    if context.hierarchy_finalized {
        return Vec::new();
    }
    let project = project_reason(context);
    let environment = match context.environment {
        Some(EnvironmentLifecycle::Ready) => None,
        Some(_) => Some("The card environment is not ready".to_string()),
        None => Some("The card has no work environment".to_string()),
    };
    let mut actions = match context.status {
        NeedsRefinement => vec![
            capability(OpenRefinement, project.clone()),
            capability(FinishRefinement, project.clone()),
        ],
        Refining => vec![capability(StopRefinement, None)],
        NeedsRefinementInput => vec![
            capability(OpenRefinement, project.clone()),
            capability(FinishRefinement, project.clone()),
            capability(StopRefinement, None),
        ],
        Ready => vec![
            capability(ReturnToRefinement, None),
            capability(
                StartWork,
                project.clone().or_else(|| {
                    context
                        .environment
                        .map(|_| "A work environment already exists".to_string())
                }),
            ),
        ],
        AgentWorking => Vec::new(),
        NeedsHuman => {
            let ship_reason = context
                .resumable_operation
                .then(|| "Finish or retry the current delivery operation".to_string())
                .or(environment.clone());
            let mut values = vec![
                capability(RequestChanges, None),
                capability(Ship, ship_reason.clone()),
            ];
            if context.delivery_workflow == DeliveryWorkflow::GithubPullRequest
                && context.supports_feature_environments
            {
                values.push(capability(ShipWithFe, ship_reason));
            }
            values
        }
        Approved if context.delivery_workflow == DeliveryWorkflow::GithubPullRequest => {
            let mut values = vec![capability(RequestChanges, None)];
            match context.pull_request {
                None | Some(PullRequestState::Closed) => {
                    values.push(capability(
                        Ship,
                        context
                            .resumable_operation
                            .then(|| "Finish or retry the current delivery operation".to_string())
                            .or(environment.clone()),
                    ));
                    values.push(capability(CreatePr, environment.clone()));
                }
                Some(PullRequestState::Open) => {
                    values.push(capability(OpenPr, None));
                    values.push(capability(
                        MergePr,
                        (!context.pull_request_blockers.is_empty())
                            .then(|| context.pull_request_blockers.join("; ")),
                    ));
                }
                Some(PullRequestState::Merged) => {}
            }
            values
        }
        Approved => vec![
            capability(RequestChanges, None),
            capability(
                Ship,
                context
                    .resumable_operation
                    .then(|| "Finish or retry the current delivery operation".to_string())
                    .or(environment.clone()),
            ),
            capability(
                MergeLocal,
                context
                    .resumable_operation
                    .then(|| "Finish or retry the current delivery operation".to_string())
                    .or(environment.clone())
                    .or(project),
            ),
        ],
        Done => context
            .environment
            .map(|state| {
                capability(
                    Cleanup,
                    (state != EnvironmentLifecycle::Ready)
                        .then(|| "The card environment is not ready for cleanup".to_string())
                        .or_else(|| {
                            context
                                .completion_outcome
                                .is_none()
                                .then(|| "The completion outcome is missing".to_string())
                        }),
                )
            })
            .into_iter()
            .collect(),
    };
    if context.status == NeedsRefinement
        && context.local_provider
        && context.environment.is_none()
        && !context.has_parent
        && !context.has_children
    {
        actions.push(capability(Delete, None));
    }
    if context.status != Done {
        actions.push(capability(Close, None));
    }
    actions
}

/// Lifecycle projection is intentionally tolerant: irrelevant or duplicate intents are no-ops.
pub fn lifecycle_transition(
    context: &WorkflowContext,
    thread: PiThread,
    intent: PiLifecycleIntent,
) -> Option<Transition> {
    use CardStatus::*;
    let target = match (thread, intent, context.status) {
        (
            PiThread::Planning,
            PiLifecycleIntent::AgentStarted | PiLifecycleIntent::UiInputResolved,
            NeedsRefinement | NeedsRefinementInput,
        ) => Refining,
        (
            PiThread::Planning,
            PiLifecycleIntent::AgentSettled
            | PiLifecycleIntent::ProtocolFailed
            | PiLifecycleIntent::ProcessExited
            | PiLifecycleIntent::UiInputRequested,
            Refining,
        ) => NeedsRefinementInput,
        (
            PiThread::Work,
            PiLifecycleIntent::AgentStarted | PiLifecycleIntent::UiInputResolved,
            NeedsHuman,
        ) => AgentWorking,
        (
            PiThread::Work,
            PiLifecycleIntent::AgentSettled | PiLifecycleIntent::UiInputRequested,
            AgentWorking,
        ) => NeedsHuman,
        _ => return None,
    };
    Some(Transition {
        from: context.status,
        to: target,
        outcome: None,
    })
}

pub fn status_index(status: CardStatus) -> usize {
    STATUS_METADATA
        .iter()
        .position(|item| item.status == status)
        .expect("all statuses have metadata")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(status: CardStatus) -> WorkflowContext {
        WorkflowContext {
            status,
            hierarchy_finalized: false,
            provider_compatible: true,
            project_present: true,
            delivery_workflow: DeliveryWorkflow::LocalMerge,
            supports_feature_environments: false,
            environment: Some(EnvironmentLifecycle::Ready),
            completion_outcome: None,
            pull_request: None,
            pull_request_blockers: vec![],
            resumable_operation: false,
            local_provider: true,
            has_parent: false,
            has_children: false,
        }
    }

    #[test]
    fn every_status_round_trips_and_has_ordered_metadata() {
        for item in STATUS_METADATA {
            assert_eq!(
                item.status.as_str().parse::<CardStatus>().unwrap(),
                item.status
            );
        }
        assert_eq!(STATUS_METADATA.len(), 8);
    }

    #[test]
    fn transition_table_is_exhaustive_and_enabled_transition_capabilities_are_accepted() {
        use WorkflowAction::*;
        let actions = [
            OpenRefinement,
            FinishRefinement,
            StopRefinement,
            StartWork,
            ReturnToRefinement,
            RequestChanges,
            Ship,
            ShipWithFe,
            MergeLocal,
            CreatePr,
            OpenPr,
            MergePr,
            Cleanup,
            Close,
            Delete,
        ];
        for metadata in STATUS_METADATA {
            let context = context(metadata.status);
            for action in actions {
                let expected = transition_target(metadata.status, action);
                let actual = transition(&context, WorkflowActor::User, action)
                    .ok()
                    .map(|value| (value.to, value.outcome));
                assert_eq!(actual, expected, "{} / {}", metadata.status, action);
            }
            for advertised in capabilities(&context)
                .into_iter()
                .filter(|item| item.available)
            {
                if transition_target(metadata.status, advertised.action).is_some() {
                    assert!(transition(&context, WorkflowActor::User, advertised.action).is_ok());
                }
            }
        }
    }

    #[test]
    fn capabilities_report_structural_disabled_reasons() {
        let mut value = context(CardStatus::Ready);
        value.project_present = false;
        value.provider_compatible = false;
        assert_eq!(
            capabilities(&value)
                .into_iter()
                .find(|item| item.action == WorkflowAction::StartWork)
                .unwrap()
                .disabled_reason
                .as_deref(),
            Some("Assign a project first")
        );

        let mut value = context(CardStatus::NeedsHuman);
        value.environment = None;
        assert_eq!(
            capabilities(&value)
                .into_iter()
                .find(|item| item.action == WorkflowAction::Ship)
                .unwrap()
                .disabled_reason
                .as_deref(),
            Some("The card has no work environment")
        );

        let mut value = context(CardStatus::Approved);
        value.delivery_workflow = DeliveryWorkflow::GithubPullRequest;
        value.pull_request = Some(PullRequestState::Open);
        value.pull_request_blockers = vec![
            "CI is failing".to_string(),
            "A current approval is required".to_string(),
        ];
        assert_eq!(
            capabilities(&value)
                .into_iter()
                .find(|item| item.action == WorkflowAction::MergePr)
                .unwrap()
                .disabled_reason
                .as_deref(),
            Some("CI is failing; A current approval is required")
        );

        let mut value = context(CardStatus::Done);
        value.completion_outcome = None;
        assert_eq!(
            capabilities(&value)
                .into_iter()
                .find(|item| item.action == WorkflowAction::Cleanup)
                .unwrap()
                .disabled_reason
                .as_deref(),
            Some("The completion outcome is missing")
        );
    }

    #[test]
    fn actor_restrictions_are_centralized() {
        assert!(transition(
            &context(CardStatus::Ready),
            WorkflowActor::Agent,
            WorkflowAction::StartWork
        )
        .is_ok());
        assert!(transition(
            &context(CardStatus::Ready),
            WorkflowActor::Agent,
            WorkflowAction::ReturnToRefinement
        )
        .is_err());
        assert!(transition(
            &context(CardStatus::Approved),
            WorkflowActor::System,
            WorkflowAction::MergePr
        )
        .is_ok());
        assert!(transition(
            &context(CardStatus::Approved),
            WorkflowActor::Agent,
            WorkflowAction::MergePr
        )
        .is_err());
    }

    #[test]
    fn lifecycle_rules_ignore_duplicates_and_reordered_irrelevant_events() {
        assert_eq!(
            lifecycle_transition(
                &context(CardStatus::NeedsRefinement),
                PiThread::Planning,
                PiLifecycleIntent::AgentStarted
            )
            .unwrap()
            .to,
            CardStatus::Refining
        );
        assert!(lifecycle_transition(
            &context(CardStatus::NeedsRefinementInput),
            PiThread::Planning,
            PiLifecycleIntent::AgentSettled
        )
        .is_none());
        assert!(lifecycle_transition(
            &context(CardStatus::NeedsHuman),
            PiThread::Work,
            PiLifecycleIntent::ProtocolFailed
        )
        .is_none());
    }
}
