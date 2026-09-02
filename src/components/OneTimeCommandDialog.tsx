import { useEffect, useRef, useState } from 'react';

export function OneTimeCommandDialog({ open, cwd, onCancel, onRun }: {
  open: boolean;
  cwd: string | null;
  onCancel: () => void;
  onRun: (command: string) => void;
}) {
  const [command, setCommand] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setCommand('');
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  if (!open) return null;

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
          const trimmedCommand = command.trim();
          if (trimmedCommand) onRun(trimmedCommand);
        }}
      >
        <h2>Run One-Time Command</h2>
        <label>
          Command
          <input
            ref={inputRef}
            value={command}
            placeholder="npm test, cargo check, ..."
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setCommand(event.target.value)}
          />
        </label>
        <div className="oneTimeCommandCwd" title={cwd ?? undefined}>Runs from {cwd ?? 'the focused terminal directory'}</div>
        <div className="modalActions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primaryAction" type="submit" disabled={!command.trim()}>Run</button>
        </div>
      </form>
    </div>
  );
}
