import type { Project } from '../../../types';
import type { KanbanBoardModel } from '../../KanbanBoard';
import { AsyncButtonLabel } from '../../AsyncButtonLabel';

/** Board project filter and primary header actions. */
export function KanbanBoardHeader({ board, projects, filterProjectId, onSelectProject, onClearKeyboardFocus, creationAvailability, onAddCard, onOpenProjectWorkspace, syncAvailability }: {
  board: KanbanBoardModel;
  projects: Project[];
  filterProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  onClearKeyboardFocus: () => void;
  creationAvailability: { disabled: boolean; title?: string };
  onAddCard: () => void;
  onOpenProjectWorkspace: () => void;
  syncAvailability: { visible: boolean; disabled: boolean; title?: string };
}) {
  return <header className="kanbanHeader">
    <div className="kanbanProjectTitleRow">
      <label className="kanbanProjectFilter">
        <select aria-label="Filter board by project" value={filterProjectId ?? ''} onChange={(event) => {
          onSelectProject(event.target.value || null);
          onClearKeyboardFocus();
        }}>
          <option value="">All projects</option>
          {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
        </select>
      </label>
    </div>
    <div className="kanbanHeaderActions">
      <button data-card-action="secondary" type="button" disabled={creationAvailability.disabled} title={creationAvailability.title} onClick={onAddCard}>+ Add card</button>
      <button data-card-action="secondary" type="button" disabled={projects.length === 0} onClick={onOpenProjectWorkspace}>Open Project Workspace</button>
      {syncAvailability.visible && <button data-card-action="secondary" type="button" title={syncAvailability.title} disabled={board.syncing || syncAvailability.disabled} onClick={() => board.sync(true)}>
        <AsyncButtonLabel idle="Sync Superthread" busy="Syncing…" isBusy={board.syncing} />
      </button>}
    </div>
  </header>;
}
