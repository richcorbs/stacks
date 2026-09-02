import { useEffect, useRef } from 'react';
import type { CustomCmdPCommand } from '../types';

export function DeleteCmdPCommandDialog({ command, onCancel, onDelete }: {
  command: CustomCmdPCommand | null;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const deleteRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!command) return;
    requestAnimationFrame(() => deleteRef.current?.focus());
  }, [command]);

  if (!command) return null;

  return (
    <div className="modalBackdrop" onMouseDown={onCancel}>
      <div
        className="modal confirmModal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-cmd-p-command-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onCancel();
        }}
      >
        <h2 id="delete-cmd-p-command-title">Delete Cmd-P Command?</h2>
        <p>Delete “{command.label}”?</p>
        <div className="modalActions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button ref={deleteRef} className="primaryAction" type="button" onClick={onDelete}>Delete</button>
        </div>
      </div>
    </div>
  );
}
