import { useEffect, useRef } from 'react';
import { ConfirmationBoundary } from '../ConfirmationBoundary';
import type { KanbanCardSummary } from '../../kanban/types';
import { handleDialogShortcut } from '../dialogShortcut';
import { AsyncButtonLabel } from '../AsyncButtonLabel';
import type { BoardPrMergeIntent } from '../../kanban/useBoardPrMerge';

export function BoardPrMergeDialog({ card, busy, intent, error, onCancel, onConfirm, onRetryCleanup }: {
  card: KanbanCardSummary;
  busy: boolean;
  intent?: BoardPrMergeIntent | null;
  error: string | null;
  onRetryCleanup?: () => void;
  onCancel: () => void;
  onConfirm: (intent: BoardPrMergeIntent) => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (error) closeRef.current?.focus(); }, [error]);
  return <ConfirmationBoundary key={`${card.id}:${card.pull_request?.number}`}><div className="modalBackdrop" onMouseDown={busy ? undefined : onCancel}>
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
      onSubmit={(event) => { event.preventDefault(); if (!busy && !error) onConfirm('merge-and-cleanup'); }}>
      <h2 id="board-pr-merge-title">{onRetryCleanup ? `PR #${card.pull_request?.number} merged` : `Merge PR #${card.pull_request?.number}?`}</h2>
      <p>Card #{card.external_id}: {card.title}</p>
      {onRetryCleanup ? <p>The PR remains merged. Retry cleanup to fetch fresh evidence and confirm local environment cleanup separately. Closing keeps local resources intact.</p> : <>
        <p>Merge PR #{card.pull_request?.number} ({card.pull_request?.url}) using the project’s configured merge strategy. Fresh GitHub checks run before merging.</p>
        <p>MERGE &amp; CLEANUP merges first, then asks you to confirm local environment cleanup separately. Cancelling cleanup keeps the PR merged and the local environment intact. MERGE keeps the local environment.</p>
      </>}
      {error && <p className="kanbanNotice" role="alert">{error} {onRetryCleanup ? 'Retry cleanup without merging again.' : 'Close to review the updated PR status.'}</p>}
      <div className="modalActions">
        <button ref={closeRef} type="button" disabled={busy} onClick={onCancel}>{error ? 'Close' : 'Cancel'}</button>
        {onRetryCleanup && <button className="primaryAction" type="button" disabled={busy} onClick={onRetryCleanup}>
          <AsyncButtonLabel idle="Retry cleanup" busy="Preparing cleanup…" isBusy={busy} />
        </button>}
        {!error && <>
          <button type="button" disabled={busy} onClick={() => { if (!busy) onConfirm('merge'); }}>
            <AsyncButtonLabel idle="MERGE" busy="Merging…" isBusy={busy && intent === 'merge'} />
          </button>
          <button ref={confirmRef} className="primaryAction" type="submit" disabled={busy}>
            <AsyncButtonLabel idle="MERGE & CLEANUP" busy="Merging & preparing cleanup…" isBusy={busy && intent === 'merge-and-cleanup'} />
          </button>
        </>}
      </div>
    </form>
  </div></ConfirmationBoundary>;
}
