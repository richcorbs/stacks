import { useEffect, useRef } from 'react';
import type { WorkspaceTemplate } from '../types';

export function DeleteWorkspaceTemplateDialog({ template, onCancel, onDelete }: {
  template: WorkspaceTemplate | null;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const deleteRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!template) return;
    requestAnimationFrame(() => deleteRef.current?.focus());
  }, [template]);

  if (!template) return null;

  return (
    <div className="modalBackdrop" onMouseDown={onCancel}>
      <div
        className="modal confirmModal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-workspace-template-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onCancel();
        }}
      >
        <h2 id="delete-workspace-template-title">Delete Workspace Template?</h2>
        <p>Delete “{template.label}”?</p>
        <div className="modalActions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button ref={deleteRef} className="primaryAction" type="button" onClick={onDelete}>Delete</button>
        </div>
      </div>
    </div>
  );
}
