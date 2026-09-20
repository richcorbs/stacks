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
    MergeLocal => "merge_local",
    Push => "push",
    Deploy => "deploy",
    RetryPush => "retry_push",
    RetryDeploy => "retry_deploy",
    ConfirmDeployed => "confirm_deployed",
    RunDeploymentAgain => "run_deployment_again",
    CancelDeployment => "cancel_deployment",
    CreatePr => "create_pr",
    CreatePrWithFe => "create_pr_with_fe",
    OpenPr => "open_pr",
    MergePr => "merge_pr",
    MergeTarget => "merge_target",
    Cleanup => "cleanup",
    CleanupCreation => "cleanup_creation",
    RetryRuntimeCleanup => "retry_runtime_cleanup",
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
string_enum!(DeliveryWorkflow { LocalMerge => "local_merge", GithubPullRequest => "github_pull_request", ScriptedDelivery => "scripted_delivery" });
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
    pub scripted_delivery_stage: Option<String>,
    pub creation_operation: bool,
    pub creation_cleanup_available: bool,
    pub cleanup_operation_active: bool,
    pub runtime_cleanup_retryable: bool,
    pub work_agent_launch_retryable: bool,
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
        (AgentWorking | NeedsHuman | Approved, Ship) => Some((Approved, None)),
        (Approved, MergeLocal | MergePr | Deploy | ConfirmDeployed) => {
            Some((Done, Some(CompletionOutcome::Merged)))
        }
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
        Ready if context.creation_operation => {
            let mut values = vec![capability(StartWork, project.clone())];
            if context.creation_cleanup_available {
                values.push(capability(CleanupCreation, None));
            }
            values
        }
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
            let mut values = Vec::new();
            if context.work_agent_launch_retryable {
                values.push(capability(
                    StartWork,
                    environment.clone().or(project.clone()),
                ));
            }
            values.extend([
                capability(RequestChanges, None),
                capability(MergeTarget, environment.clone()),
                capability(Ship, ship_reason),
            ]);
            values
        }
        Approved if context.delivery_workflow == DeliveryWorkflow::ScriptedDelivery => {
            let reason = environment.clone().or(project.clone());
            match context.scripted_delivery_stage.as_deref() {
                None => vec![
                    capability(RequestChanges, None),
                    capability(MergeTarget, environment.clone()),
                    capability(Ship, reason.clone()),
                    capability(MergeLocal, reason),
                ],
                Some("merged") => {
                    vec![capability(Push, reason.clone()), capability(Deploy, reason)]
                }
                Some("pushing") => vec![capability(Push, Some("Push is already running".into()))],
                Some("push_failed") => vec![
                    capability(RetryPush, reason.clone()),
                    capability(Deploy, reason),
                ],
                Some("pushed") => vec![capability(Deploy, reason)],
                Some("deploying") => vec![capability(CancelDeployment, None)],
                Some("deployment_failed") | Some("cancelled") => {
                    vec![capability(RetryDeploy, reason)]
                }
                Some("uncertain") => vec![
                    capability(ConfirmDeployed, None),
                    capability(RunDeploymentAgain, reason),
                ],
                Some("deployed") => Vec::new(),
                Some(_) => Vec::new(),
            }
        }
        Approved if context.delivery_workflow == DeliveryWorkflow::GithubPullRequest => {
            let mut values = vec![
                capability(RequestChanges, None),
                capability(MergeTarget, environment.clone()),
            ];
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
                    if context.supports_feature_environments {
                        values.push(capability(CreatePrWithFe, environment.clone()));
                    }
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
            capability(MergeTarget, environment.clone()),
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
        Done => {
            let mut values = Vec::new();
            if context.runtime_cleanup_retryable {
                values.push(capability(RetryRuntimeCleanup, None));
            }
            if let Some(state) = context.environment {
                values.push(capability(
                    Cleanup,
                    (!context.cleanup_operation_active && state != EnvironmentLifecycle::Ready)
                        .then(|| "The card environment is not ready for cleanup".to_string())
                        .or_else(|| {
                            context
                                .completion_outcome
                                .is_none()
                                .then(|| "The completion outcome is missing".to_string())
                        }),
                ));
            } else if context.cleanup_operation_active {
                values.push(capability(Cleanup, None));
            }
            values
        }
    };
    if context.status == NeedsRefinement
        && context.local_provider
        && context.environment.is_none()
        && !context.has_parent
        && !context.has_children
    {
        actions.push(capability(Delete, None));
    }
    if context.status != Done
        && !(context.delivery_workflow == DeliveryWorkflow::ScriptedDelivery
            && context.scripted_delivery_stage.is_some())
    {
        actions.push(capability(Close, None));
    }
    actions
}

pub fn target_merge_completion(
    context: &WorkflowContext,
    actor: WorkflowActor,
) -> Result<Transition, String> {
    if actor != WorkflowActor::User {
        return Err("Only the user can finalize a target merge".to_string());
    }
    match context.status {
        CardStatus::NeedsHuman | CardStatus::AgentWorking | CardStatus::Approved => {
            Ok(Transition {
                from: context.status,
                // A target merge finalized from Ready to merge is itself a
                // verified, clean, explicit merge of the exact recorded target
                // revision. Preserve approval so local delivery can proceed
                // without a redundant second Commit. Pre-approval merges still
                // settle in Needs you and require the normal approval step.
                to: if context.status == CardStatus::Approved {
                    CardStatus::Approved
                } else {
                    CardStatus::NeedsHuman
                },
                outcome: context.completion_outcome,
            })
        }
        _ => Err(format!(
            "A target merge cannot be finalized while card is {}",
            context.status
        )),
    }
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
            PiLifecycleIntent::AgentSettled
            | PiLifecycleIntent::ProtocolFailed
            | PiLifecycleIntent::ProcessExited
            | PiLifecycleIntent::UiInputRequested,
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
            scripted_delivery_stage: None,
            creation_operation: false,
            creation_cleanup_available: false,
            cleanup_operation_active: false,
            runtime_cleanup_retryable: false,
            work_agent_launch_retryable: false,
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
            MergeLocal,
            Push,
            Deploy,
            RetryPush,
            RetryDeploy,
            ConfirmDeployed,
            RunDeploymentAgain,
            CancelDeployment,
            CreatePr,
            CreatePrWithFe,
            OpenPr,
            MergePr,
            MergeTarget,
            Cleanup,
            CleanupCreation,
            RetryRuntimeCleanup,
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
    fn needs_human_capabilities_keep_delivery_actions_in_display_order() {
        use WorkflowAction::*;

        let standard = capabilities(&context(CardStatus::NeedsHuman))
            .into_iter()
            .map(|capability| capability.action)
            .collect::<Vec<_>>();
        assert_eq!(standard, vec![RequestChanges, MergeTarget, Ship, Close]);

        let mut retryable = context(CardStatus::NeedsHuman);
        retryable.work_agent_launch_retryable = true;
        let retryable = capabilities(&retryable)
            .into_iter()
            .map(|capability| capability.action)
            .collect::<Vec<_>>();
        assert_eq!(
            retryable,
            vec![StartWork, RequestChanges, MergeTarget, Ship, Close]
        );

        let mut feature_environment = context(CardStatus::NeedsHuman);
        feature_environment.delivery_workflow = DeliveryWorkflow::GithubPullRequest;
        feature_environment.supports_feature_environments = true;
        let feature_environment = capabilities(&feature_environment)
            .into_iter()
            .map(|capability| capability.action)
            .collect::<Vec<_>>();
        assert_eq!(
            feature_environment,
            vec![RequestChanges, MergeTarget, Ship, Close]
        );
    }

    #[test]
    fn ready_to_merge_capabilities_keep_target_merge_before_ship() {
        use WorkflowAction::*;

        let actions = capabilities(&context(CardStatus::Approved))
            .into_iter()
            .map(|capability| capability.action)
            .collect::<Vec<_>>();
        assert_eq!(
            actions,
            vec![RequestChanges, MergeTarget, Ship, MergeLocal, Close]
        );
    }

    #[test]
    fn github_pr_capabilities_offer_ordered_feature_environment_choice() {
        use WorkflowAction::*;

        let mut github = context(CardStatus::Approved);
        github.delivery_workflow = DeliveryWorkflow::GithubPullRequest;
        assert_eq!(
            capabilities(&github)
                .into_iter()
                .map(|capability| capability.action)
                .collect::<Vec<_>>(),
            vec![RequestChanges, MergeTarget, Ship, CreatePr, Close]
        );

        github.supports_feature_environments = true;
        assert_eq!(
            capabilities(&github)
                .into_iter()
                .map(|capability| capability.action)
                .collect::<Vec<_>>(),
            vec![
                RequestChanges,
                MergeTarget,
                Ship,
                CreatePr,
                CreatePrWithFe,
                Close,
            ]
        );
    }

    #[test]
    fn scripted_delivery_capabilities_follow_durable_stages() {
        use WorkflowAction::*;
        let mut value = context(CardStatus::Approved);
        value.delivery_workflow = DeliveryWorkflow::ScriptedDelivery;
        assert_eq!(
            capabilities(&value)
                .into_iter()
                .map(|item| item.action)
                .collect::<Vec<_>>(),
            vec![RequestChanges, MergeTarget, Ship, MergeLocal, Close]
        );
        value.scripted_delivery_stage = Some("merged".into());
        assert_eq!(
            capabilities(&value)
                .into_iter()
                .map(|item| item.action)
                .collect::<Vec<_>>(),
            vec![Push, Deploy]
        );
        value.scripted_delivery_stage = Some("uncertain".into());
        assert_eq!(
            capabilities(&value)
                .into_iter()
                .map(|item| item.action)
                .collect::<Vec<_>>(),
            vec![ConfirmDeployed, RunDeploymentAgain]
        );
        value.scripted_delivery_stage = Some("deploying".into());
        assert_eq!(
            capabilities(&value)
                .into_iter()
                .map(|item| item.action)
                .collect::<Vec<_>>(),
            vec![CancelDeployment]
        );
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
    fn target_merge_preserves_approval_but_does_not_grant_it() {
        let approved =
            target_merge_completion(&context(CardStatus::Approved), WorkflowActor::User).unwrap();
        assert_eq!(approved.from, CardStatus::Approved);
        assert_eq!(approved.to, CardStatus::Approved);

        let needs_human =
            target_merge_completion(&context(CardStatus::NeedsHuman), WorkflowActor::User).unwrap();
        assert_eq!(needs_human.from, CardStatus::NeedsHuman);
        assert_eq!(needs_human.to, CardStatus::NeedsHuman);

        let agent_working =
            target_merge_completion(&context(CardStatus::AgentWorking), WorkflowActor::User)
                .unwrap();
        assert_eq!(agent_working.from, CardStatus::AgentWorking);
        assert_eq!(agent_working.to, CardStatus::NeedsHuman);
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
        assert_eq!(
            lifecycle_transition(
                &context(CardStatus::AgentWorking),
                PiThread::Work,
                PiLifecycleIntent::ProtocolFailed
            )
            .unwrap()
            .to,
            CardStatus::NeedsHuman
        );
        assert!(lifecycle_transition(
            &context(CardStatus::NeedsHuman),
            PiThread::Work,
            PiLifecycleIntent::ProtocolFailed
        )
        .is_none());
    }
}
