import type React from 'react';
import type { DialogState } from '../types';

type DialogFieldsProps = {
  dialog: DialogState;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  firstInputRef: React.MutableRefObject<HTMLInputElement | null>;
  chooseEditWorkspaceDirectory: () => void;
};

export function DialogFields({ dialog, setDialog, firstInputRef, chooseEditWorkspaceDirectory }: DialogFieldsProps) {
  if (dialog.kind === 'project' || dialog.kind === 'editProject') {
    return (
      <>
        <h2>{dialog.kind === 'project' ? 'Add Project' : 'Edit Project'}</h2>
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
    );
  }

  if (dialog.kind === 'split') {
    return (
      <>
        <h2>Split Terminal</h2>
        <label>
          Startup command <span>(optional)</span>
          <input
            ref={firstInputRef}
            value={dialog.command}
            placeholder="pi, claude, npm run dev, ..."
            onChange={(e) => setDialog({ ...dialog, command: e.target.value })}
          />
        </label>
      </>
    );
  }

  return (
    <>
      <h2>{dialog.kind === 'editWorkspace' ? 'Edit Workspace' : 'New Workspace'}</h2>
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
      {dialog.kind === 'editWorkspace' && (
        <label>
          Directory <span>(click to choose)</span>
          <div className="settingsInlineField">
            <input
              value={dialog.cwd}
              placeholder="/Users/rich/Code/my-project"
              onClick={chooseEditWorkspaceDirectory}
              onChange={(e) => setDialog({ ...dialog, cwd: e.target.value })}
            />
            <button type="button" onClick={chooseEditWorkspaceDirectory}>Choose…</button>
          </div>
        </label>
      )}
    </>
  );
}

export function dialogSubmitLabel(kind: DialogState['kind']) {
  if (kind === 'project' || kind === 'workspace') return 'Create';
  if (kind === 'split') return 'Split';
  return 'Save';
}
