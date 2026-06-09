import type { ContextMenuState, Project, Store, TerminalEntry } from '../types';

export function ContextMenu({ menu, store, onClose, onNewTerminal, onEditProject, onDeleteProject, onEditTerminal, onDeleteTerminal }: {
  menu: ContextMenuState;
  store: Store;
  onClose: () => void;
  onNewTerminal: (project: Project) => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  onEditTerminal: (project: Project, terminal: TerminalEntry) => void;
  onDeleteTerminal: (project: Project, terminal: TerminalEntry) => void;
}) {
  const project = store.projects.find((p) => p.id === menu.projectId);
  if (!project) return null;
  const terminal = menu.kind === 'terminal' ? project.terminals.find((t) => t.id === menu.terminalId) : null;

  return (
    <div
      className="contextMenu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.kind === 'project' && <button onClick={() => onNewTerminal(project)}>New Workspace</button>}
      <button onClick={() => menu.kind === 'project' ? onEditProject(project) : terminal && onEditTerminal(project, terminal)}>Edit</button>
      <button className="dangerItem" onClick={() => menu.kind === 'project' ? onDeleteProject(project) : terminal && onDeleteTerminal(project, terminal)}>Delete</button>
    </div>
  );
}
