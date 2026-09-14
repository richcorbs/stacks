import { describe, expect, it } from 'vitest';
import type { KanbanCard, KanbanStatus } from './types';
import { adjacentBoardCard, keyboardNavigableCards } from './boardNavigation';

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

  it('includes Done cards while the Done column is expanded', () => {
    const navigable = keyboardNavigableCards(cards, false);

    expect(navigable.map((item) => item.id)).toEqual(['ready', 'approved', 'done']);
    expect(adjacentBoardCard(navigable, 'approved', 'l')?.id).toBe('done');
  });
});
