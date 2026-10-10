import type { Project } from '../types';
import { KanbanBoard } from './KanbanBoard';
import type { KanbanCard } from '../kanban/types';
import type { CardPaletteRegistration } from '../commandPaletteCards';

type MainWorkspaceProps = {
  boardShortcutBlocked: boolean;
  projects: Project[];
  projectsHydrated: boolean;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  superthreadEnabled: boolean;
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  backlogCollapsed: boolean;
  onBacklogCollapsedChange: (collapsed: boolean) => void;
  doneCollapsed: boolean;
  onDoneCollapsedChange: (collapsed: boolean) => void;
  view: 'list' | 'board';
  onViewChange: (view: 'list' | 'board') => void;
  onAddProject: () => void;
  onCleanupCard: (card: KanbanCard, evidence: import('../kanban/types').CleanupPreflight) => Promise<boolean>;
  onStartWork: (cardId: string) => Promise<KanbanCard | null>;
  onPaletteCardsChange: (registration: CardPaletteRegistration | null) => void;
};

export function MainWorkspace({
  boardShortcutBlocked,
  projects,
  projectsHydrated,
  terminalFontSize,
  terminalFontFamily,
  terminalScrollback,
  copyOnSelect,
  superthreadEnabled,
  selectedProjectId,
  onSelectProject,
  backlogCollapsed,
  onBacklogCollapsedChange,
  doneCollapsed,
  onDoneCollapsedChange,
  view,
  onViewChange,
  onAddProject,
  onCleanupCard,
  onStartWork,
  onPaletteCardsChange,
}: MainWorkspaceProps) {
  return (
    <main className="main">
      <section className="workspace kanbanWorkspace">
        <KanbanBoard
          boardShortcutBlocked={boardShortcutBlocked}
          superthreadEnabled={superthreadEnabled}
          projects={projects}
          projectsHydrated={projectsHydrated}
          selectedProjectId={selectedProjectId}
          onSelectProject={onSelectProject}
          backlogCollapsed={backlogCollapsed}
          onBacklogCollapsedChange={onBacklogCollapsedChange}
          doneCollapsed={doneCollapsed}
          onDoneCollapsedChange={onDoneCollapsedChange}
          view={view}
          onViewChange={onViewChange}
          terminalFontSize={terminalFontSize}
          terminalFontFamily={terminalFontFamily}
          terminalScrollback={terminalScrollback}
          copyOnSelect={copyOnSelect}
          onAddProject={onAddProject}
          onCleanupCard={onCleanupCard}
          onStartWork={onStartWork}
          onPaletteCardsChange={onPaletteCardsChange}
        />
      </section>
    </main>
  );
}
