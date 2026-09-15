import type { KanbanCard } from '../../kanban/types';
import { childCountLabel } from '../../kanban/hierarchy';

export function CardHierarchyBadges({ card }: { card: KanbanCard }) {
  return <>
    {card.parent && <span className="kanbanHierarchyBadge parent" title={card.parent.title} aria-label={`Parent: ${card.parent.title}`}>{card.parent.title}</span>}
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
