import { ConfirmationBoundary } from './ConfirmationBoundary';
import { useCallback, useEffect, useRef, useState } from 'react';
import { handleDialogShortcut } from './dialogShortcut';

export function ConfirmDialog({ title, children, cancelLabel = 'No', confirmLabel = 'Yes', onCancel, onConfirm }: {
  title: string;
  children: React.ReactNode;
  cancelLabel?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmationBoundary><div className="modalBackdrop" onMouseDown={onCancel}>
      <form
        className="modal confirmModal" role="alertdialog" aria-modal="true" aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          handleDialogShortcut(e, true);
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }}
        onSubmit={(e) => { e.preventDefault(); onConfirm(); }}
      >
        <h2>{title}</h2>
        <div className="dialogBody">{children}</div>
        <div className="modalActions">
          <button data-confirm-cancel type="button" onClick={onCancel}>{cancelLabel}</button>
          <button className="primaryAction" type="submit">{confirmLabel}</button>
        </div>
      </form>
    </div></ConfirmationBoundary>
  );
}

/** One pending request per owner; closing/changing the owner safely cancels it. */
export function useConfirmation(ownerKey: unknown = null) {
  const [request, setRequest] = useState<{ id: number; title: string; detail: string; label: string } | null>(null);
  const sequence = useRef(0);
  const pending = useRef<((accepted: boolean) => void) | null>(null);
  const owner = useRef(ownerKey);
  owner.current = ownerKey;
  const settle = useCallback((accepted: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setRequest(null);
    resolve?.(accepted);
  }, []);
  useEffect(() => () => { const resolve = pending.current; pending.current = null; resolve?.(false); }, []);
  useEffect(() => { settle(false); }, [ownerKey, settle]);
  const confirm = useCallback((title: string, detail = '', label = 'Confirm'): Promise<boolean> => {
    if (pending.current) return Promise.resolve(false);
    const key = owner.current;
    return new Promise((resolve) => {
      pending.current = (accepted) => resolve(accepted && owner.current === key);
      setRequest({ id: ++sequence.current, title, detail, label });
    });
  }, []);
  const dialog = request && <ConfirmDialog key={request.id} title={request.title} cancelLabel="Cancel" confirmLabel={request.label} onCancel={() => settle(false)} onConfirm={() => settle(true)}><p>{request.detail}</p></ConfirmDialog>;
  return { confirm, dialog };
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
