import type { KanbanCard } from '../../kanban/types';
import { childCountLabel } from '../../kanban/hierarchy';

export function CardHierarchyBadges({ card }: { card: KanbanCard }) {
  return <>
    {card.parent && <span className="kanbanHierarchyBadge parent" title={card.parent.title} aria-label={`Parent: ${card.parent.title}`}>{card.parent.title}</span>}
    {card.child_count > 0 && <span className="kanbanHierarchyBadge children" aria-label={childCountLabel(card.child_count)}>
      {card.child_count}
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 16c.5.3 1.2.5 2 .5s1.5-.2 2-.5" />
        <path d="M15 12h.01" />
        <path d="M19.38 6.813A9 9 0 0 1 20.8 10.2a2 2 0 0 1 0 3.6 9 9 0 0 1-17.6 0 2 2 0 0 1 0-3.6A9 9 0 0 1 12 3c2 0 3.5 1.1 3.5 2.5s-.9 2.5-2 2.5c-.8 0-1.5-.4-1.5-1" />
        <path d="M9 12h.01" />
      </svg>
    </span>}
  </>;
}
