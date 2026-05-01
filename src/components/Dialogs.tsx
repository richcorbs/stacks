import { useEffect, useRef } from 'react';
import type { ContextMenuState, DialogState, Project, Store, TerminalEntry } from '../types';

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
      {menu.kind === 'project' && <button onClick={() => onNewTerminal(project)}>New Terminal</button>}
      <button onClick={() => menu.kind === 'project' ? onEditProject(project) : terminal && onEditTerminal(project, terminal)}>Edit</button>
      <button className="dangerItem" onClick={() => menu.kind === 'project' ? onDeleteProject(project) : terminal && onDeleteTerminal(project, terminal)}>Delete</button>
    </div>
  );
}

function ConfirmDialog({ title, children, confirmLabel = 'Yes', onCancel, onConfirm }: {
  title: string;
  children: React.ReactNode;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const yesRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    requestAnimationFrame(() => yesRef.current?.focus());
  }, []);

  return (
    <div className="modalBackdrop" onMouseDown={onCancel}>
      <form
        className="modal confirmModal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); onConfirm(); }}
      >
        <h2>{title}</h2>
        {children}
        <div className="modalActions">
          <button type="button" onClick={onCancel}>No</button>
          <button ref={yesRef} className="primaryAction" type="submit">{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

export function ConfirmClosePaneDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <ConfirmDialog title="Close pane?" onCancel={onCancel} onConfirm={onConfirm}>
      <p>This will terminate the process running in this pane.</p>
      <p className="confirmHint">Use ⌘W to close this pane. Use ⌘Q to quit the app.</p>
    </ConfirmDialog>
  );
}

export function ConfirmQuitDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <ConfirmDialog title="Quit Stacks?" confirmLabel="Quit" onCancel={onCancel} onConfirm={onConfirm}>
      <p>This will close all panes and terminate their running processes.</p>
    </ConfirmDialog>
  );
}

export function ConfirmDeleteProjectDialog({ projectName, onCancel, onConfirm }: { projectName: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <ConfirmDialog title="Delete project?" confirmLabel="Delete" onCancel={onCancel} onConfirm={onConfirm}>
      <p>This will remove “{projectName}” and terminate all terminals in this project.</p>
    </ConfirmDialog>
  );
}

export function Dialog({ dialog, setDialog, onCancel, onSubmit }: {
  dialog: DialogState;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    requestAnimationFrame(() => firstInputRef.current?.focus());
  }, []);

  return (
    <div className="modalBackdrop" onMouseDown={onCancel}>
      <form
        className={`modal ${dialog.kind === 'terminal' || dialog.kind === 'editTerminal' ? 'terminalDialog' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
      >
        {dialog.kind === 'project' ? (
          <>
            <h2>Add Project</h2>
            <label>
              Name
              <input
                ref={firstInputRef}
                value={dialog.name}
                onChange={(e) => setDialog({ ...dialog, name: e.target.value })}
              />
            </label>
            <label>
              Directory
              <input
                value={dialog.path}
                placeholder="/Users/rich/Code/my-project"
                onChange={(e) => setDialog({ ...dialog, path: e.target.value })}
              />
            </label>
          </>
        ) : dialog.kind === 'editProject' ? (
          <>
            <h2>Edit Project</h2>
            <label>
              Name
              <input
                ref={firstInputRef}
                value={dialog.name}
                onChange={(e) => setDialog({ ...dialog, name: e.target.value })}
              />
            </label>
            <label>
              Directory
              <input
                value={dialog.path}
                placeholder="/Users/rich/Code/my-project"
                onChange={(e) => setDialog({ ...dialog, path: e.target.value })}
              />
            </label>
          </>
        ) : (
          <>
            <h2>{dialog.kind === 'editTerminal' ? 'Edit Terminal' : 'New Terminal'}</h2>
            <label>
              Name
              <input
                ref={firstInputRef}
                value={dialog.name}
                onChange={(e) => setDialog({ ...dialog, name: e.target.value })}
              />
            </label>
            <label>
              Startup command <span>(optional)</span>
              <input
                value={dialog.command}
                placeholder="pi, claude, npm run dev, ..."
                onChange={(e) => setDialog({ ...dialog, command: e.target.value })}
              />
            </label>
          </>
        )}
        <div className="modalActions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primaryAction" type="submit">{dialog.kind === 'project' || dialog.kind === 'terminal' ? 'Create' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}

