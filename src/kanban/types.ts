export const KANBAN_STATUSES = [
  'needs_refinement',
  'refining',
  'needs_refinement_input',
  'ready',
  'agent_working',
  'needs_human',
  'approved',
  'done',
] as const;

export type KanbanStatus = typeof KANBAN_STATUSES[number];

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

export type CardEnvironmentHealth = {
  card_id: string;
  issues: EnvironmentHealthIssue[];
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

export type KanbanCard = {
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
  workflow_revision: number;
  project_id: string | null;
  environment: CardEnvironment | null;
  created_at: number;
  updated_at: number;
  sort_order: number;
  events: CardEvent[];
};


export type KanbanSyncCard = {
  id: string;
  title: string;
  content: string;
  board_id: string;
  board_title: string;
  list_id: string;
  list_title: string;
  card_url: string;
  assignee_names: string[];
  in_scope: boolean;
};

export type CardProviderKind = 'local' | 'superthread';

/** Provider-owned fields are snapshots; Stacks owns workflow status and environments. */
export interface CardProviderAdapter {
  readonly kind: CardProviderKind;
  sync(refresh?: boolean): Promise<{ cards: KanbanSyncCard[]; warnings: string[] }>;
  create?(title: string, content: string): Promise<KanbanSyncCard>;
  load?(card: KanbanCard): Promise<KanbanSyncCard | null>;
}
