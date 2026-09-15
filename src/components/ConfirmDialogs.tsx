import { useEffect, useRef } from 'react';

function ConfirmDialog({ title, children, cancelLabel = 'No', confirmLabel = 'Yes', onCancel, onConfirm }: {
  title: string;
  children: React.ReactNode;
  cancelLabel?: string;
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
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          onCancel();
        }}
        onSubmit={(e) => { e.preventDefault(); onConfirm(); }}
      >
        <h2>{title}</h2>
        {children}
        <div className="modalActions">
          <button type="button" onClick={onCancel}>{cancelLabel}</button>
          <button ref={yesRef} className="primaryAction" type="submit">{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

export function ConfirmCloseTerminalDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
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
      <p>This will close all terminal and Pi GUI panes and terminate their running processes.</p>
    </ConfirmDialog>
  );
}

export function ConfirmDeleteProjectDialog({ projectName, onCancel, onConfirm }: { projectName: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <ConfirmDialog title="Delete project?" confirmLabel="Delete" onCancel={onCancel} onConfirm={onConfirm}>
      <p>This will remove “{projectName}” and permanently delete its completed card history. Active cards or remaining card environments block deletion.</p>
    </ConfirmDialog>
  );
}
