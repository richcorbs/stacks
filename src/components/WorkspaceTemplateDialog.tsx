import { useEffect, useRef, useState } from 'react';
import type { WorkspaceTemplate } from '../types';
import { PaneKindPicker, WorkspaceGridPicker } from './DialogFields';

type WorkspaceTemplateDraft = Omit<WorkspaceTemplate, 'id'>;

const EMPTY_TEMPLATE: WorkspaceTemplateDraft = {
  label: '',
  name: '',
  command: '',
  setupCommand: '',
  rows: 1,
  columns: 1,
  firstPaneKind: 'pi',
};

export function WorkspaceTemplateDialog({ open, templateToEdit, onCancel, onSave }: {
  open: boolean;
  templateToEdit?: WorkspaceTemplate | null;
  onCancel: () => void;
  onSave: (template: WorkspaceTemplateDraft) => void;
}) {
  const [draft, setDraft] = useState<WorkspaceTemplateDraft>(EMPTY_TEMPLATE);
  const labelRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(templateToEdit ? {
      label: templateToEdit.label,
      name: templateToEdit.name,
      command: templateToEdit.command,
      setupCommand: templateToEdit.setupCommand,
      rows: templateToEdit.rows,
      columns: templateToEdit.columns,
      firstPaneKind: templateToEdit.firstPaneKind,
    } : EMPTY_TEMPLATE);
    requestAnimationFrame(() => labelRef.current?.focus());
  }, [open, templateToEdit]);

  if (!open) return null;

  const canSave = Boolean(draft.label.trim());
  const update = (patch: Partial<WorkspaceTemplateDraft>) => setDraft((current) => ({ ...current, ...patch }));

  return (
    <div className="modalBackdrop" onMouseDown={onCancel}>
      <form
        className="modal terminalDialog"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onCancel();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave) return;
          onSave({ ...draft, label: draft.label.trim() });
        }}
      >
        <h2>{templateToEdit ? 'Edit Workspace Template' : 'Add Workspace Template'}</h2>
        <label>
          Template name
          <input
            ref={labelRef}
            value={draft.label}
            placeholder="Start Work"
            autoComplete="off"
            onChange={(event) => update({ label: event.target.value })}
          />
        </label>
        <label>
          Workspace name <span>(optional)</span>
          <input
            value={draft.name}
            placeholder="Leave blank to enter it when creating"
            autoComplete="off"
            onChange={(event) => update({ name: event.target.value })}
          />
        </label>
        <PaneKindPicker value={draft.firstPaneKind} label="First pane" onChange={(firstPaneKind) => update({ firstPaneKind })} />
        <label>
          Setup command <span>(optional, runs once before panes open)</span>
          <input
            value={draft.setupCommand}
            placeholder="stwork_setup ST-1234"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => update({ setupCommand: event.target.value })}
          />
        </label>
        {draft.firstPaneKind === 'terminal' && (
          <label>
            Startup command <span>(optional)</span>
            <input
              value={draft.command}
              placeholder="pi, claude, npm run dev, ..."
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update({ command: event.target.value })}
            />
          </label>
        )}
        <WorkspaceGridPicker rows={draft.rows} columns={draft.columns} onChange={(rows, columns) => update({ rows, columns })} />
        <div className="modalActions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primaryAction" type="submit" disabled={!canSave}>{templateToEdit ? 'Save Changes' : 'Save Template'}</button>
        </div>
      </form>
    </div>
  );
}
