import { useEffect, useRef } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { DialogState } from '../types';
import { DialogFields, dialogSubmitLabel } from './DialogFields';

export function Dialog({ dialog, setDialog, onCancel, onSubmit }: {
  dialog: DialogState;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    requestAnimationFrame(() => {
      firstInputRef.current?.focus();
      if (dialog.kind === 'workspace') firstInputRef.current?.select();
    });
  }, [dialog.kind]);

  async function chooseEditWorkspaceDirectory() {
    if (dialog.kind !== 'editWorkspace') return;
    const selected = await open({ directory: true, multiple: false, title: 'Choose Workspace Directory', defaultPath: dialog.cwd || undefined }).catch((err) => {
      console.error(err);
      return null;
    });
    if (typeof selected === 'string') setDialog({ ...dialog, cwd: selected });
  }

  return (
    <div className="modalBackdrop" onMouseDown={onCancel}>
      <form
        className={`modal ${dialog.kind === 'workspace' || dialog.kind === 'editWorkspace' || dialog.kind === 'split' ? 'terminalDialog' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          onCancel();
        }}
        onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
      >
        <DialogFields
          dialog={dialog}
          setDialog={setDialog}
          firstInputRef={firstInputRef}
          chooseEditWorkspaceDirectory={chooseEditWorkspaceDirectory}
        />
        <div className="modalActions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primaryAction" type="submit">{dialogSubmitLabel(dialog.kind)}</button>
        </div>
      </form>
    </div>
  );
}
