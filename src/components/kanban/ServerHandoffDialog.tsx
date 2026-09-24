import { useEffect, useRef } from 'react';

export function ServerHandoffDialog({ externalId, busy, onCancel, onConfirm }: {
  externalId: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { requestAnimationFrame(() => confirmRef.current?.focus()); }, []);

  return <div className="modalBackdrop" onMouseDown={busy ? undefined : onCancel}>
    <form
      className="modal confirmModal"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="server-handoff-title"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || busy) return;
        event.preventDefault();
        onCancel();
      }}
      onSubmit={(event) => { event.preventDefault(); if (!busy) onConfirm(); }}
    >
      <h2 id="server-handoff-title">Start this server?</h2>
      <p>Shutdown the server running on card #{externalId}?</p>
      <div className="modalActions">
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        <button ref={confirmRef} className="primaryAction" type="submit" disabled={busy}>Shutdown and start</button>
      </div>
    </form>
  </div>;
}
