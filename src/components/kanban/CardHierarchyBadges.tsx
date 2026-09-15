import type { KanbanCard } from '../../kanban/types';
import { childCountLabel } from '../../kanban/hierarchy';

export function CardHierarchyBadges({ card }: { card: KanbanCard }) {
  return <>
    {card.parent && <span className="kanbanHierarchyBadge parent" title={card.parent.title} aria-label={`Parent: ${card.parent.title}`}>{card.parent.title}</span>}
    {card.child_count > 0 && <span className="kanbanHierarchyBadge children">{childCountLabel(card.child_count)}</span>}
  </>;
}
