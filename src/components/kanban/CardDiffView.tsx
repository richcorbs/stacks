import type { ComponentProps } from 'react';
import type { KanbanCard } from '../../kanban/types';
import { cardLocalComparisonTarget } from '../../git/comparisonTarget';
import { WorkDiffView } from '../WorkDiffView';

export function CardDiffView({ card, cardPath, ...props }: Omit<ComponentProps<typeof WorkDiffView>, 'label' | 'path' | 'comparisonTarget'> & {
  card: KanbanCard; cardPath: string | null;
}) {
  return <WorkDiffView {...props} label="Card diff" path={cardPath} comparisonTarget={cardLocalComparisonTarget(card.environment?.target_branch)} />;
}
