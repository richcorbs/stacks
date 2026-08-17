import { useEffect, useRef, useState } from 'react';
import type { CustomCmdPCommand } from '../types';

export function AddCmdPCommandDialog({ open, commandToEdit, onCancel, onSave }: {
  open: boolean;
  commandToEdit?: CustomCmdPCommand | null;
  onCancel: () => void;
  onSave: (command: Omit<CustomCmdPCommand, 'id'>) => void;
}) {
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [direction, setDirection] = useState<CustomCmdPCommand['direction']>('column');
  const [execute, setExecute] = useState(true);
  const labelRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setLabel(commandToEdit?.label ?? '');
    setCommand(commandToEdit?.command ?? '');
    setDirection(commandToEdit?.direction ?? 'column');
    setExecute(commandToEdit?.execute ?? true);
    requestAnimationFrame(() => labelRef.current?.focus());
  }, [open, commandToEdit]);

  if (!open) return null;

  const canSave = Boolean(label.trim() && command.trim());
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
          onSave({ label: label.trim(), command: command.trim(), direction, execute });
        }}
      >
        <h2>{commandToEdit ? 'Edit Cmd-P Command' : 'Add Cmd-P Command'}</h2>
        <label>
          Label
          <input
            ref={labelRef}
            value={label}
            placeholder="Start development server"
            autoComplete="off"
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <label>
          Command
          <input
            value={command}
            placeholder="npm run dev"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setCommand(event.target.value)}
          />
        </label>
        <label>
          Open in
          <select value={direction} onChange={(event) => setDirection(event.target.value as CustomCmdPCommand['direction'])}>
            <option value="column">Split Down</option>
            <option value="row">Split Right</option>
          </select>
        </label>
        <label className="checkboxLabel">
          <input type="checkbox" checked={execute} onChange={(event) => setExecute(event.target.checked)} />
          Execute command
        </label>
        <div className="modalActions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primaryAction" type="submit" disabled={!canSave}>{commandToEdit ? 'Save Changes' : 'Save Command'}</button>
        </div>
      </form>
    </div>
  );
}
