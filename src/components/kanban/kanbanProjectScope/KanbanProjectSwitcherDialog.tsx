import type { Project } from '../../../types';
import { ProjectSwitcherDialog } from '../../ProjectSwitcherDialog';
import type { WorkView } from '../../../directWork';
import type { KanbanProjectScopeModel } from './useKanbanProjectScope';

/** Project picker for filtering the board and opening project work. */
export function KanbanProjectSwitcherDialog({ scope, projects, onSelectProject, onAddProject, replaceDirectWork, clearKeyboardFocus }: {
  scope: KanbanProjectScopeModel;
  projects: Project[];
  onSelectProject: (projectId: string | null) => void;
  onAddProject: () => void;
  replaceDirectWork: (projectId: string | null, view?: WorkView, requestNavigation?: boolean) => Promise<boolean>;
  clearKeyboardFocus: () => void;
}) {
  const {
    projectSwitcherOpen, setProjectSwitcherOpen, projectPickerPurpose,
    projectPickerCurrentProjectId, filterProjectId,
  } = scope;
  return <ProjectSwitcherDialog
    open={projectSwitcherOpen}
    projects={projectPickerPurpose === 'release' ? projects.filter((project) => project.releases_enabled) : projects}
    currentProjectId={projectPickerPurpose === 'filter' ? filterProjectId : projectPickerPurpose === 'notes' ? projectPickerCurrentProjectId : null}
    includeAllProjects={projectPickerPurpose === 'filter'}
    onCancel={() => setProjectSwitcherOpen(false)}
    onSelect={(project) => {
      if (projectPickerPurpose === 'direct' || projectPickerPurpose === 'notes' || projectPickerPurpose === 'release') {
        if (!project) return;
        const view = projectPickerPurpose === 'release' ? 'release' : projectPickerPurpose === 'notes' ? 'notes' : undefined;
        void replaceDirectWork(project.id, view, projectPickerPurpose === 'notes');
      } else {
        onSelectProject(project?.id ?? null);
        clearKeyboardFocus();
      }
      setProjectSwitcherOpen(false);
    }}
    onAddProject={() => {
      setProjectSwitcherOpen(false);
      onAddProject();
    }}
  />;
}
