import { describe, expect, it } from 'vitest';
import type { KanbanCard, KanbanStatus } from './types';
import { adjacentBoardCard, adjacentListCard, keyboardNavigableCards } from './boardNavigation';

function card(id: string, status: KanbanStatus): KanbanCard {
  return { id, status } as KanbanCard;
}

describe('Kanban board keyboard navigation', () => {
  const cards = [card('ready', 'ready'), card('approved', 'approved'), card('done', 'done')];

  it('excludes Done cards while the Done column is collapsed', () => {
    const navigable = keyboardNavigableCards(cards, true);

    expect(navigable.map((item) => item.id)).toEqual(['ready', 'approved']);
    expect(adjacentBoardCard(navigable, 'approved', 'l')?.id).toBe('approved');
  });

  it('navigates within four groups and through list rows in presentation order', () => {
    const grouped = [card('ready', 'ready'), card('approved', 'approved'), card('refining', 'refining'), card('backlog', 'needs_refinement')];
    expect(adjacentBoardCard(grouped, 'ready', 'j')?.id).toBe('approved');
    expect(adjacentBoardCard(grouped, 'approved', 'h')?.id).toBe('refining');
    expect(adjacentBoardCard(grouped, 'backlog', 'l')?.id).toBe('refining');
    expect(adjacentListCard(grouped, 'approved', 'j')?.id).toBe('refining');
    expect(adjacentListCard(grouped, 'ready', 'k')?.id).toBe('ready');
  });

  it('includes Done cards while the Done column is expanded', () => {
    const navigable = keyboardNavigableCards(cards, false);

    expect(navigable.map((item) => item.id)).toEqual(['ready', 'approved', 'done']);
    expect(adjacentBoardCard(navigable, 'approved', 'l')?.id).toBe('done');
  });
});
