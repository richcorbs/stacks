export const KANBAN_STATUSES = [
  'needs_refinement',
  'ready',
  'agent_working',
  'needs_human',
  'approved',
  'merged',
] as const;

export type KanbanStatus = typeof KANBAN_STATUSES[number];

export type CardEnvironmentPane = {
  id: string;
  role: string;
  kind: 'terminal' | 'pi';
  command: string | null;
  sort_order: number;
};

export type CardServiceDefinition = {
  id: string;
  name: string;
  command: string;
  sort_order: number;
};

export type CardEnvironment = {
  id: string;
  card_id: string;
  project_id: string;
  worktree_path: string;
  branch: string;
  lifecycle_state: 'creating' | 'ready' | 'cleanup_pending' | 'cleanup_failed';
  revision: number;
  split_layout: import('../types').SplitNode;
  focused_pane_id: string | null;
  panes: CardEnvironmentPane[];
  services: CardServiceDefinition[];
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
  project_id: string | null;
  environment: CardEnvironment | null;
  created_at: number;
  updated_at: number;
  sort_order: number;
};

/** Compatibility result for the legacy Superthread panel; cards themselves no longer own workspaces. */
export type KanbanWorkspace = { projectId: string; workspaceId: string };

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
  load?(card: KanbanCard): Promise<KanbanSyncCard | null>;
}
