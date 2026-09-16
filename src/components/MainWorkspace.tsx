import type { Project } from '../types';
import { KanbanBoard } from './KanbanBoard';
import type { KanbanCard } from '../kanban/types';
import type { CardPaletteRegistration } from '../commandPaletteCards';

type MainWorkspaceProps = {
  projects: Project[];
  projectsHydrated: boolean;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  superthreadEnabled: boolean;
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  doneCollapsed: boolean;
  onDoneCollapsedChange: (collapsed: boolean) => void;
  onAddProject: () => void;
  onCleanupCard: (card: KanbanCard) => Promise<boolean>;
  onStartWork: (cardId: string) => Promise<boolean>;
  onPaletteCardsChange: (registration: CardPaletteRegistration | null) => void;
};

export function MainWorkspace({
  projects,
  projectsHydrated,
  terminalFontSize,
  terminalFontFamily,
  terminalScrollback,
  copyOnSelect,
  superthreadEnabled,
  selectedProjectId,
  onSelectProject,
  doneCollapsed,
  onDoneCollapsedChange,
  onAddProject,
  onCleanupCard,
  onStartWork,
  onPaletteCardsChange,
}: MainWorkspaceProps) {
  return (
    <main className="main">
      <section className="workspace kanbanWorkspace">
        <KanbanBoard
          superthreadEnabled={superthreadEnabled}
          projects={projects}
          projectsHydrated={projectsHydrated}
          selectedProjectId={selectedProjectId}
          onSelectProject={onSelectProject}
          doneCollapsed={doneCollapsed}
          onDoneCollapsedChange={onDoneCollapsedChange}
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
