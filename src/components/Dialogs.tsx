import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { DialogState } from '../types';
import { DialogFields, dialogSubmitLabel } from './DialogFields';

export function Dialog({ dialog, setDialog, onCancel, onSubmit }: {
  dialog: DialogState;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  onCancel: () => void;
  onSubmit: () => void | Promise<void>;
}) {
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  useEffect(() => {
    requestAnimationFrame(() => {
      firstInputRef.current?.focus();
      if (dialog.kind === 'workspace' || dialog.kind === 'editTerminal') firstInputRef.current?.select();
    });
  }, [dialog.kind]);

  const setupRunning = submitting && dialog.kind === 'workspace' && Boolean(dialog.setupCommand.trim());

  function cancel() {
    if (setupRunning) invoke('cancel_workspace_setup').catch(console.error);
    onCancel();
  }

  async function chooseEditWorkspaceDirectory() {
    if (dialog.kind !== 'editWorkspace') return;
    const selected = await open({ directory: true, multiple: false, title: 'Choose Workspace Directory', defaultPath: dialog.cwd || undefined }).catch((err) => {
      console.error(err);
      return null;
    });
    if (typeof selected === 'string') setDialog({ ...dialog, cwd: selected });
  }

  return (
    <div className="modalBackdrop" onMouseDown={() => { if (!submitting || setupRunning) cancel(); }}>
      <form
        className={`modal ${dialog.kind === 'workspace' || dialog.kind === 'editWorkspace' || dialog.kind === 'split' || dialog.kind === 'editTerminal' ? 'terminalDialog' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || (submitting && !setupRunning)) return;
          e.preventDefault();
          cancel();
        }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (submitting) return;
          setSubmitting(true);
          setSubmitError(null);
          try {
            await onSubmit();
          } catch (error) {
            setSubmitError(error instanceof Error ? error.message : String(error));
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <DialogFields
          dialog={dialog}
          setDialog={setDialog}
          firstInputRef={firstInputRef}
          chooseEditWorkspaceDirectory={chooseEditWorkspaceDirectory}
        />
        {submitError && <div className="dialogSubmitError">{submitError}</div>}
        <div className="modalActions">
          <button type="button" disabled={submitting && !setupRunning} onClick={cancel}>{setupRunning ? 'Cancel setup' : 'Cancel'}</button>
          <button className="primaryAction" disabled={submitting} type="submit">{submitting && dialog.kind === 'workspace' && dialog.setupCommand.trim() ? 'Running setup…' : dialogSubmitLabel(dialog.kind)}</button>
        </div>
      </form>
    </div>
  );
}
