import type { DiffReviewModel } from '../../diffReview/types';
import type { KanbanCard } from '../../kanban/types';
import { cardLocalComparisonTarget } from '../../git/comparisonTarget';
import { DiffOverlay } from '../DiffOverlay';
import { DiffTab } from '../DiffTab';

export function CardDiffView({ active, card, cardPath, refreshNonce, review, canSubmit, onSubmit }: {
  active: boolean; card: KanbanCard; cardPath: string | null; refreshNonce: number; review: DiffReviewModel; canSubmit: boolean; onSubmit: () => void;
}) {
  return <section className={`cardDiffView cardView${active ? ' active' : ''}`}>
    <aside className="cardDiffExplorer"><DiffTab activePath={cardPath} comparisonTarget={cardLocalComparisonTarget(card.environment?.target_branch)} refreshNonce={refreshNonce} review={review} /></aside>
    <div className="cardDiffContent">{review.openDiff ? <DiffOverlay review={review} fontSize={13} canSubmit={canSubmit} onSubmit={onSubmit} onClose={() => review.setOpenDiff(null)} /> : <div className="kanbanEmpty">Select a changed file to view its diff.</div>}</div>
  </section>;
}
