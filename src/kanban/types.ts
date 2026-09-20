import { KANBAN_STATUS_METADATA, KANBAN_WORKFLOW_ACTIONS } from './workflowContract.generated';

export const KANBAN_STATUSES = KANBAN_STATUS_METADATA.map(({ status }) => status);
export type KanbanStatus = typeof KANBAN_STATUS_METADATA[number]['status'];
export type KanbanWorkflowAction = typeof KANBAN_WORKFLOW_ACTIONS[number];
export type KanbanCapability = { action: KanbanWorkflowAction; available: boolean; disabled_reason?: string };
export type PiLifecycleIntent = 'agent_started' | 'agent_settled' | 'protocol_failed' | 'process_exited' | 'ui_input_requested' | 'ui_input_resolved';

export type CardEnvironmentPane = {
  id: string;
  role: string;
  kind: 'terminal' | 'pi';
  command: string | null;
  sort_order: number;
};

export type CardEnvironment = {
  id: string;
  card_id: string;
  project_id: string;
  worktree_path: string;
  branch: string;
  repository_id: string | null;
  target_checkout_path: string | null;
  target_branch: string | null;
  source_revision: string | null;
  target_revision: string | null;
  lifecycle_state: 'creating' | 'ready' | 'cleanup_pending' | 'cleanup_failed';
  revision: number;
  layout_revision: number;
  split_layout: import('../types').SplitNode;
  focused_pane_id: string | null;
  panes: CardEnvironmentPane[];
};

export type EnvironmentHealthStep = 'work' | 'approval' | 'merge' | 'cleanup';

export type EnvironmentHealthIssue = {
  code: string;
  message: string;
  step: EnvironmentHealthStep;
};

export type CardPullRequest = {
  repository: string;
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  ci_status: 'pending' | 'success' | 'failure' | 'no_ci' | 'unknown';
  review_state: 'approved' | 'changes_requested' | 'pending' | 'unknown';
  has_conflicts: boolean;
  mergeable: boolean;
  blockers: string[];
};

export type CardCleanupOperation = {
  status: 'pending' | 'failed' | 'completed';
  phase: 'runtime_sessions' | 'validate_repository' | 'remove_worktree' | 'delete_local_branch' | 'delete_remote_branch' | 'remove_metadata' | 'record_completion';
  error_code: string | null;
  error_detail: string | null;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
};

export type CardEnvironmentHealth = {
  card_id: string;
  issues: EnvironmentHealthIssue[];
};

export type EnvironmentCreationOperation = {
  id: string;
  phase: 'prepared' | 'setup_running' | 'setup_complete' | 'attaching' | 'compensation_pending' | 'recovery_required';
  error: string | null;
  source_path: string | null;
  source_branch: string | null;
  cleanup_available: boolean;
  custom_command: boolean;
  revision: number;
};

export type CardEvent = {
  id: number;
  created_at: number;
  actor: 'user' | 'agent' | 'system';
  event_type: string;
  outcome: 'success' | 'failure';
  from_status: KanbanStatus | null;
  to_status: KanbanStatus | null;
  summary: string | null;
  error_code: string | null;
  error_detail: string | null;
};

export type ScriptedDeliveryOperation = {
  stage: 'merged' | 'pushing' | 'push_failed' | 'pushed' | 'deploying' | 'deployment_failed' | 'cancelled' | 'uncertain' | 'deployed';
  source_revision: string;
  merge_revision: string;
  verified_push_revision: string | null;
  deployed_revision: string | null;
  attempt: number;
  failure_class: string | null;
  summary: string | null;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
  revision: number;
};

export type CardRelationshipSummary = {
  id: string;
  external_id: string;
  title: string;
  status: KanbanStatus;
};

export type CardEnvironmentIndicator = Pick<CardEnvironment,
  'id' | 'project_id' | 'worktree_path' | 'branch' | 'target_branch' | 'lifecycle_state' | 'revision' | 'layout_revision'>;
export type CardPullRequestIndicator = Pick<CardPullRequest,
  'number' | 'url' | 'state' | 'ci_status' | 'review_state' | 'has_conflicts' | 'blockers'>;

export type KanbanCardDetail = {
  id: string;
  provider: 'local' | 'superthread';
  external_id: string;
  title: string;
  content: string;
  board_id: string;
  board_title: string;
  list_id: string;
  list_title: string;
  card_url: string;
  assignee_names: string[];
  status: KanbanStatus;
  completion_outcome?: 'merged' | 'closed' | null;
  feature_environment?: boolean;
  pull_request?: CardPullRequest | null;
  delivery_operation_stage?: string | null;
  delivery_error?: string | null;
  scripted_delivery?: ScriptedDeliveryOperation | null;
  runtime_cleanup_status?: 'pending' | 'complete' | 'failed' | null;
  runtime_cleanup_error?: string | null;
  workflow_revision: number;
  record_revision: number;
  project_id: string | null;
  parent: CardRelationshipSummary | null;
  child_count: number;
  children: CardRelationshipSummary[];
  hierarchy_finalized: boolean;
  environment: CardEnvironment | null;
  creation_operation?: EnvironmentCreationOperation | null;
  cleanup_operation?: CardCleanupOperation | null;
  provider_sync?: {
    id: string;
    kind: 'start_work' | 'done';
    state: 'pending' | 'running' | 'failed' | 'succeeded' | 'stale' | 'superseded';
    destination_column_name: string;
    attempts: number;
    error: string | null;
    updated_at: number;
  } | null;
  created_at: number;
  updated_at: number;
  sort_order: number;
  events: CardEvent[];
  capabilities: KanbanCapability[];
};

/** Board-only projection. Detail-only fields cannot accidentally enter the entity store. */
export type KanbanCardSummary = Pick<KanbanCardDetail,
  'id' | 'provider' | 'external_id' | 'title' | 'board_id' | 'board_title' | 'list_title' | 'assignee_names' | 'status' |
  'completion_outcome' | 'workflow_revision' | 'record_revision' | 'project_id' | 'parent' |
  'child_count' | 'children' | 'hierarchy_finalized' | 'created_at' | 'updated_at' | 'sort_order'> & {
    environment: CardEnvironmentIndicator | null;
    pull_request?: CardPullRequestIndicator | null;
    creation_operation?: Pick<EnvironmentCreationOperation, 'phase' | 'error'> | null;
    cleanup_operation?: Pick<CardCleanupOperation, 'status'> | null;
    runtime_cleanup_status?: 'pending' | 'complete' | 'failed' | null;
  };

/** Compatibility name for detail/workspace code. New board code should use KanbanCardSummary. */
export type KanbanCard = KanbanCardDetail;
export type CardSnapshot = { card: KanbanCardDetail; board_revision: number };
export type BoardSnapshot = { cards: KanbanCardSummary[]; board_revision: number };
export type BoardChange = { upserts: KanbanCardSummary[]; removed_ids: string[]; detail_invalidated_ids?: string[]; board_revision: number };
export type CardEventCursor = { created_at: number; id: number };
export type CardEventPage = { events: CardEvent[]; next_cursor: CardEventCursor | null };

export type KanbanSyncCard = {
  id: string;
  title: string;
  content: string | null;
  board_id: string;
  board_title: string;
  list_id: string;
  list_title: string;
  card_url: string;
  assignee_names: string[];
  task_parent_id?: string | null;
  task_parent_title?: string | null;
  /** True when the provider response authoritatively included relationship coverage. */
  parent_relationship_hydrated?: boolean;
  total_task_children?: number;
  /** null means scope could not be classified during a partial provider read. */
  in_scope: boolean | null;
};

export type SuperthreadTaskChildSnapshot = {
  id: string;
  title: string;
  status: string;
};

export type SuperthreadParentHydration = {
  parent_id: string;
  parent_title: string;
  children: SuperthreadTaskChildSnapshot[];
};

export type SuperthreadSnapshot = {
  cards: KanbanSyncCard[];
  parent_hydrations: SuperthreadParentHydration[];
  successful_scope_ids: string[];
  successful_board_ids: string[];
  failed_scopes: Array<{ scope: string; message: string }>;
  warnings: string[];
  complete: boolean;
};

/** Explicit singleton source. Provider fields are snapshots; Stacks owns workflow and environments. */
export interface SuperthreadIntegration {
  readonly kind: 'superthread';
  readonly ownerProjectId: string;
  sync(refresh?: boolean, knownParentIds?: string[]): Promise<SuperthreadSnapshot>;
  create(title: string, content: string): Promise<KanbanSyncCard>;
  load(card: KanbanCardSummary): Promise<KanbanSyncCard | null>;
}
