import { useEffect, useRef } from 'react';
import type { KanbanCardSummary } from '../../kanban/types';
import { handleDialogShortcut } from '../dialogShortcut';
import { AsyncButtonLabel } from '../AsyncButtonLabel';

export function BoardPrMergeDialog({ card, busy, error, onCancel, onConfirm }: {
  card: KanbanCardSummary;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => confirmRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => { if (error) closeRef.current?.focus(); }, [error]);
  return <div className="modalBackdrop" onMouseDown={busy ? undefined : onCancel}>
    <form className="modal confirmModal" role="alertdialog" aria-modal="true" aria-labelledby="board-pr-merge-title"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Let focused buttons keep native Enter/Space activation (especially Cancel).
        if (!(event.target as HTMLElement | null)?.closest?.('button')) handleDialogShortcut(event, !error);
        event.stopPropagation();
        if (event.key === 'Tab') {
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
          const next = event.shiftKey ? buttons.at(-1) : buttons[0];
          const boundary = event.shiftKey ? buttons[0] : buttons.at(-1);
          if (!buttons.length || event.target === boundary) { event.preventDefault(); next?.focus(); }
        }
        if (event.key === 'Escape') { event.preventDefault(); if (!busy) onCancel(); }
      }}
      onSubmit={(event) => { event.preventDefault(); if (!busy && !error) onConfirm(); }}>
      <h2 id="board-pr-merge-title">Merge PR #{card.pull_request?.number}?</h2>
      <p>Card #{card.external_id}: {card.title}</p>
      <p>Merge PR #{card.pull_request?.number} ({card.pull_request?.url}) using the project’s configured merge strategy. Fresh GitHub checks run before merging. The local worktree will be kept.</p>
      {error && <p className="kanbanNotice" role="alert">{error} Close to review the updated PR status or open the card for recovery.</p>}
      <div className="modalActions">
        <button ref={closeRef} type="button" disabled={busy} onClick={onCancel}>{error ? 'Close' : 'Cancel'}</button>
        {!error && <button ref={confirmRef} className="primaryAction" type="submit" disabled={busy}>
          <AsyncButtonLabel idle="Merge PR" busy="Merging…" isBusy={busy} />
        </button>}
      </div>
    </form>
  </div>;
}
