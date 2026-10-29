import { useRef } from 'react';
import type { DiffNavigationKey } from '../../git/diffTree';
import type { DiffReviewModel } from '../../diffReview/types';
import type { KanbanCard } from '../../kanban/types';
import { cardLocalComparisonTarget } from '../../git/comparisonTarget';
import { DiffOverlay } from '../DiffOverlay';
import { DiffTab, type DiffTreeNavigation } from '../DiffTab';

export function CardDiffView({ active, card, cardPath, refreshNonce, review, canSubmit, onSubmit, onClose }: {
  active: boolean; card: KanbanCard; cardPath: string | null; refreshNonce: number; review: DiffReviewModel; canSubmit: boolean; onSubmit: () => void; onClose: () => void;
}) {
  const navigationRef = useRef<DiffTreeNavigation>(null);
  return <section className={`cardDiffView cardView${active ? ' active' : ''}`} tabIndex={active ? 0 : -1} aria-label="Card diff" onKeyDown={(event) => {
    if (!active || event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!['j', 'k', 'h', 'l', 'Enter'].includes(event.key)) return;
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(target)) return;
    if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]')) return;
    if (event.key === 'Enter' && target.closest('button, a[href], summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="tab"], [role="radio"]')) return;
    if (navigationRef.current?.navigate(event.key as DiffNavigationKey)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }}>
    <aside className="cardDiffExplorer"><DiffTab navigationRef={navigationRef} activePath={cardPath} comparisonTarget={cardLocalComparisonTarget(card.environment?.target_branch)} refreshNonce={refreshNonce} review={review} /></aside>
    <div className="cardDiffContent">{review.openDiff ? <DiffOverlay review={review} fontSize={13} canSubmit={canSubmit} onSubmit={onSubmit} onClose={onClose} /> : <div className="kanbanEmpty">Select a changed file to view its diff.</div>}</div>
  </section>;
}
