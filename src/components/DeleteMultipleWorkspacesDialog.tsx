import { useEffect, useRef, useState } from 'react';

export function DeleteMultipleWorkspacesDialog({ open, onCancel, onDelete }: {
  open: boolean;
  onCancel: () => void;
  onDelete: (query: string) => void;
}) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
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
          if (query.trim()) onDelete(query);
        }}
      >
        <h2>Delete Other Workspace(s)</h2>
        <label>
          Workspace names
          <input
            ref={inputRef}
            value={query}
            placeholder="1776, another workspace"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="modalActions">
          <button type="button" onClick={onCancel}>CANCEL</button>
          <button className="primaryAction" type="submit" disabled={!query.trim()}>DELETE</button>
        </div>
      </form>
    </div>
  );
}
