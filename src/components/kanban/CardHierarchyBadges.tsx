import type { PointerEvent } from 'react';
import type { KanbanCardSummary } from '../../kanban/types';
import { childCountLabel } from '../../kanban/hierarchy';

export function CardHierarchyBadges({ card, onNavigateParent }: { card: KanbanCardSummary; onNavigateParent: (parentId: string) => void }) {
  const stopPointerPropagation = (event: PointerEvent<HTMLButtonElement>) => event.stopPropagation();
  return <>
    {card.parent && <button
      className="kanbanHierarchyBadge parent"
      type="button"
      title={`Parent #${card.parent.external_id}: ${card.parent.title}`}
      aria-label={`Parent #${card.parent.external_id}: ${card.parent.title}`}
      onPointerDown={stopPointerPropagation}
      onPointerMove={stopPointerPropagation}
      onPointerUp={stopPointerPropagation}
      onPointerCancel={stopPointerPropagation}
      onClick={(event) => { event.stopPropagation(); onNavigateParent(card.parent!.id); }}
    >#{card.parent.external_id}</button>}
    {card.child_count > 0 && <span className="kanbanHierarchyBadge children" aria-label={childCountLabel(card.child_count)}>
      {card.child_count}
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect width="6" height="6" x="16" y="16" rx="1" />
        <rect width="6" height="6" x="2" y="16" rx="1" />
        <rect width="6" height="6" x="9" y="2" rx="1" />
        <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" />
        <path d="M12 12V8" />
      </svg>
    </span>}
  </>;
}
