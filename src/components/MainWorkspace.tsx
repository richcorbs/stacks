import type { Project } from '../types';
import { KanbanBoard } from './KanbanBoard';
import type { KanbanCard } from '../kanban/types';

type MainWorkspaceProps = {
  projects: Project[];
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  superthreadSpaces: string;
  superthreadWorkspaceSlug: string;
  superthreadEnabled: boolean;
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  doneCollapsed: boolean;
  onDoneCollapsedChange: (collapsed: boolean) => void;
  onAddProject: () => void;
  onCleanupCard: (card: KanbanCard) => Promise<boolean>;
  onStartWork: (cardId: string) => Promise<boolean>;
};

export function MainWorkspace({
  projects,
  terminalFontSize,
  terminalFontFamily,
  terminalScrollback,
  copyOnSelect,
  superthreadSpaces,
  superthreadWorkspaceSlug,
  superthreadEnabled,
  selectedProjectId,
  onSelectProject,
  doneCollapsed,
  onDoneCollapsedChange,
  onAddProject,
  onCleanupCard,
  onStartWork,
}: MainWorkspaceProps) {
  return (
    <main className="main">
      <section className="workspace kanbanWorkspace">
        <KanbanBoard
          spaces={superthreadSpaces}
          workspaceSlug={superthreadWorkspaceSlug}
          superthreadEnabled={superthreadEnabled}
          projects={projects}
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
        />
      </section>
    </main>
  );
}
