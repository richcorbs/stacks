import type { Project } from '../types';
import { projectColorAttribute } from '../projectColor';
import { canReassignKanbanCardProject } from '../kanban/cardEditing';
import { localKanbanProjects } from '../kanban/projectScope';
import type { KanbanCard } from '../kanban/types';

export function CardProjectAssignment({ card, project, projects, onChange }: {
  card: KanbanCard;
  project: Project | null;
  projects: Project[];
  onChange: (projectId: string) => void;
}) {
  if (!canReassignKanbanCardProject(card)) {
    return <span data-project-color={projectColorAttribute(project)} className={`kanbanProjectBadge${project ? '' : ' invalid'}`}>{project?.name ?? 'Unknown project'}</span>;
  }

  return <select
    className="kanbanProjectAssignment"
    data-project-color={projectColorAttribute(project)}
    aria-label="Owning project"
    value={card.project_id ?? ''}
    onChange={(event) => onChange(event.target.value)}
  >
    {!project && <option value="">Unknown project</option>}
    {localKanbanProjects(projects).map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name}</option>)}
  </select>;
}
