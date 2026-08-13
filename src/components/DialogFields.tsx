import { useEffect, useState } from 'react';
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

  if (dialog.kind === 'split' || dialog.kind === 'editTerminal') {
    return (
      <>
        <h2>{dialog.kind === 'split' ? 'Split Terminal' : 'Edit Terminal'}</h2>
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
      {dialog.kind === 'workspace' && (
        <WorkspaceGridPicker
          rows={dialog.rows}
          columns={dialog.columns}
          onChange={(rows, columns) => setDialog({ ...dialog, rows, columns })}
        />
      )}
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

function WorkspaceGridPicker({ rows, columns, onChange }: {
  rows: number;
  columns: number;
  onChange: (rows: number, columns: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const values = [1, 2, 3, 4, 5];

  useEffect(() => {
    if (!dragging) return;
    const stopDragging = () => setDragging(false);
    window.addEventListener('pointerup', stopDragging);
    return () => window.removeEventListener('pointerup', stopDragging);
  }, [dragging]);

  function selectCell(row: number, column: number) {
    onChange(row, column);
  }

  return (
    <div className="dialogGridPickerField">
      <div className="dialogGridPickerHeader">
        <span>Split layout</span>
        <strong>{columns} × {rows}</strong>
      </div>
      <div className="dialogGridPickerHint">Drag from the top-left to choose terminal rows and columns.</div>
      <div className="dialogGridPicker" role="grid" aria-label="Workspace terminal split layout">
        {values.map((row) => values.map((column) => {
          const selected = row <= rows && column <= columns;
          return (
            <button
              key={`${row}:${column}`}
              type="button"
              className={`dialogGridCell ${selected ? 'selected' : ''}`}
              aria-label={`${row} rows by ${column} columns`}
              aria-pressed={row === rows && column === columns}
              onPointerDown={(event) => {
                event.preventDefault();
                setDragging(true);
                selectCell(row, column);
              }}
              onPointerEnter={() => {
                if (dragging) selectCell(row, column);
              }}
              onClick={() => selectCell(row, column)}
            />
          );
        }))}
      </div>
    </div>
  );
}

export function dialogSubmitLabel(kind: DialogState['kind']) {
  if (kind === 'project' || kind === 'workspace') return 'Create';
  if (kind === 'split') return 'Split';
  return 'Save';
}
