import { useMemo } from 'react';
import type { Project } from '../types';
import type { KanbanCard } from '../kanban/types';
import type { CardPaletteRegistration } from '../commandPaletteCards';
import { useKanbanBoard } from '../kanban/useKanbanBoard';
import { hasSuperthreadMapping, resolveKanbanProjectFilter } from '../kanban/projectScope';
import { superthreadIntegration } from '../superthread/cardProvider';
import { KanbanBoardView } from './kanban/KanbanBoardView';

export type KanbanBoardProps = {
  superthreadEnabled: boolean;
  projects: Project[];
  projectsHydrated: boolean;
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  doneCollapsed: boolean;
  onDoneCollapsedChange: (collapsed: boolean) => void;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  onAddProject: () => void;
  onCleanupCard: (card: KanbanCard) => Promise<boolean>;
  onStartWork: (cardId: string) => Promise<boolean>;
  onPaletteCardsChange: (registration: CardPaletteRegistration | null) => void;
};

export type KanbanBoardModel = ReturnType<typeof useKanbanBoard>;

/** Owns the React adapter; the view receives an explicit state/command model. */
export function KanbanBoard(props: KanbanBoardProps) {
  const filterProjectId = resolveKanbanProjectFilter(props.projects, props.selectedProjectId);
  const providers = useMemo(() => props.superthreadEnabled ? props.projects
    .filter((project) => project.kanban_source === 'superthread' && hasSuperthreadMapping(project) && (!filterProjectId || project.id === filterProjectId))
    .map((project) => superthreadIntegration({
      ownerProjectId: project.id, spaces: project.superthread_spaces!, workspaceSlug: project.superthread_workspace_slug,
      boardId: project.superthread_board_id!, boardName: project.superthread_board_name!,
      incomingColumnIds: project.superthread_incoming_columns!.map((column) => column.id),
      defaultIncomingColumnId: project.superthread_default_incoming_column_id!,
      apiTokenEnvVar: project.superthread_api_token_env_var ?? 'ST_TOKEN',
    })) : [], [filterProjectId, props.projects, props.superthreadEnabled]);
  const board = useKanbanBoard(providers);
  return <KanbanBoardView {...props} board={board} />;
}
