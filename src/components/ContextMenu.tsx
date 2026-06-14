import type { ContextMenuState, Project, Store, WorkspaceEntry } from '../types';

export function ContextMenu({ menu, store, onClose, onNewWorkspace, onEditProject, onDeleteProject, onEditWorkspace, onDeleteWorkspace }: {
  menu: ContextMenuState;
  store: Store;
  onClose: () => void;
  onNewWorkspace: (project: Project) => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  onEditWorkspace: (project: Project, workspace: WorkspaceEntry) => void;
  onDeleteWorkspace: (project: Project, workspace: WorkspaceEntry) => void;
}) {
  const project = store.projects.find((p) => p.id === menu.projectId);
  if (!project) return null;
  const workspace = menu.kind === 'workspace' ? project.workspaces.find((candidate) => candidate.id === menu.workspaceId) : null;

  return (
    <div
      className="contextMenu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.kind === 'project' && <button onClick={() => onNewWorkspace(project)}>New Workspace</button>}
      <button onClick={() => menu.kind === 'project' ? onEditProject(project) : workspace && onEditWorkspace(project, workspace)}>Edit</button>
      <button className="dangerItem" onClick={() => menu.kind === 'project' ? onDeleteProject(project) : workspace && onDeleteWorkspace(project, workspace)}>Delete</button>
    </div>
  );
}
