import type { SuperthreadCard } from '../superthread/types';

export const KANBAN_STATUSES = [
  'needs_refinement',
  'ready',
  'agent_working',
  'needs_human',
  'approved',
  'merged',
] as const;

export type KanbanStatus = typeof KANBAN_STATUSES[number];

export type KanbanCard = {
  id: string;
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
  workspace_id: string | null;
  created_at: number;
  updated_at: number;
  sort_order: number;
};

export type KanbanWorkspace = { projectId: string; workspaceId: string };

export type KanbanSyncCard = Pick<SuperthreadCard,
  'id' | 'title' | 'content' | 'board_id' | 'board_title' | 'list_id' | 'list_title' | 'card_url' | 'assignee_names'> & {
    in_scope: boolean;
  };
