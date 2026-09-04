import { useEffect, useRef, useState } from 'react';
import type { PendingPrCleanup } from '../types';

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
      <p>This will remove “{projectName}” and terminate all workspaces in this project.</p>
    </ConfirmDialog>
  );
}

export function ConfirmMergePullRequestDialog({ number, pullRequestTitle, cleanupError, onCancel, onConfirm }: {
  number: number;
  pullRequestTitle: string;
  cleanupError?: string | null;
  onCancel: () => void;
  onConfirm: (cleanupAfter: boolean) => void;
}) {
  const [cleanupAfter, setCleanupAfter] = useState(true);
  return (
    <ConfirmDialog title="Merge pull request?" confirmLabel="Merge" onCancel={onCancel} onConfirm={() => onConfirm(cleanupAfter)}>
      <p>Merge PR #{number}: “{pullRequestTitle}”?</p>
      <label className="checkboxLabel mergeCleanupOption">
        <input type="checkbox" checked={cleanupAfter} onChange={(event) => setCleanupAfter(event.target.checked)} />
        Cleanup after?
      </label>
      <p className="confirmHint">Runs /cleanup in the related workspace, stops its processes, then deletes it.</p>
      {cleanupError && <p className="dialogSubmitError">{cleanupError}</p>}
    </ConfirmDialog>
  );
}

export function ResumePrCleanupDialog({ operation, onCancel, onResume }: {
  operation: PendingPrCleanup;
  onCancel: () => void;
  onResume: () => void;
}) {
  return (
    <ConfirmDialog title="Resume PR cleanup?" cancelLabel="Cancel cleanup" confirmLabel="Resume" onCancel={onCancel} onConfirm={onResume}>
      <p>PR #{operation.pullRequestNumber} has an unfinished cleanup for “{operation.workspaceName}”.</p>
      <p className="confirmHint">Resume from {operation.stage.replaceAll('-', ' ')} or cancel and retain the workspace.</p>
    </ConfirmDialog>
  );
}

export function ConfirmDeleteWorkspaceDialog({ terminalName, onCancel, onConfirm }: { terminalName: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <ConfirmDialog title="Delete workspace?" confirmLabel="Delete" onCancel={onCancel} onConfirm={onConfirm}>
      <p>This will remove “{terminalName}” and terminate its running terminals.</p>
    </ConfirmDialog>
  );
}
