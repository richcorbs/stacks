import type { Project } from '../types';
import type { KanbanCard } from '../kanban/types';
import { KanbanBoardView } from './kanban/KanbanBoardView';

export type KanbanBoardProps = {
  spaces: string;
  workspaceSlug: string;
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
};

/** Stable public entry point for the Kanban workspace. */
export function KanbanBoard(props: KanbanBoardProps) {
  return <KanbanBoardView {...props} />;
}
