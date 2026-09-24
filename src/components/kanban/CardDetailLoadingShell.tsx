import type { KanbanCardSummary } from '../../kanban/types';
import { statusLabel } from '../../kanban/hierarchy';

/** Board summaries are never passed to the actionable detail component. */
export function CardDetailLoadingShell({ card, error, onRetry, onClose }: {
  card: KanbanCardSummary;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  return <div className="modalBackdrop kanbanDetailBackdrop" onMouseDown={onClose}>
    <section className="kanbanDetail kanbanDetailLoading" role="dialog" aria-modal="true" aria-labelledby="kanbanLoadingTitle" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div className="kanbanDetailHeading">
          <div className="kanbanDetailHeaderMeta"><span>#{card.external_id}</span><span className="kanbanCardStatus">{statusLabel(card.status)}</span></div>
          <h2 id="kanbanLoadingTitle">{card.title}</h2>
        </div>
        <button className="kanbanDetailClose" type="button" aria-label="Close card details" onClick={onClose} />
      </header>
      {error ? <div className="kanbanDetailLoadingBody" role="alert">
        <p>Could not load card details: {error}</p>
        <div><button type="button" onClick={onRetry}>Retry</button> <button type="button" onClick={onClose}>Close</button></div>
      </div> : <div className="kanbanDetailLoadingBody" role="status" aria-label="Loading card details">
        <span className="kanbanDetailSkeleton" aria-hidden="true" />
        <span className="kanbanDetailSkeleton short" aria-hidden="true" />
        <span className="kanbanDetailSkeleton" aria-hidden="true" />
      </div>}
    </section>
  </div>;
}
