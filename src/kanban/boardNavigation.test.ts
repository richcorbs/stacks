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

  it('excludes collapsed list groups independently without hiding the board Backlog lane', () => {
    const grouped = [card('backlog', 'needs_refinement'), ...cards];
    expect(keyboardNavigableCards(grouped, true, true, 'list').map((item) => item.id)).toEqual(['ready', 'approved']);
    expect(keyboardNavigableCards(grouped, false, true, 'list').map((item) => item.id)).toEqual(['ready', 'approved', 'done']);
    expect(keyboardNavigableCards(grouped, true, false, 'list').map((item) => item.id)).toEqual(['backlog', 'ready', 'approved']);
    expect(adjacentListCard(keyboardNavigableCards(grouped, true, true, 'list'), 'approved', 'k')?.id).toBe('ready');
    expect(keyboardNavigableCards(grouped, true, true, 'board').map((item) => item.id)).toEqual(['backlog', 'ready', 'approved']);
  });

  it('navigates within four groups and through list rows in presentation order', () => {
    const grouped = [card('ready', 'ready'), card('approved', 'approved'), card('refining', 'refining'), card('backlog', 'needs_refinement')];
    expect(adjacentBoardCard(grouped, 'ready', 'j')?.id).toBe('approved');
    expect(adjacentBoardCard(grouped, 'approved', 'h')?.id).toBe('refining');
    expect(adjacentBoardCard(grouped, 'backlog', 'l')?.id).toBe('refining');
    expect(adjacentListCard(grouped, 'approved', 'j')?.id).toBe('refining');
    expect(adjacentListCard(grouped, 'ready', 'k')?.id).toBe('ready');
  });

  it('moves both ways between an ordinary list row and the parent row directly below it', () => {
    const rows = [card('ordinary', 'ready'), { ...card('parent', 'ready'), child_count: 2 }];
    const navigable = keyboardNavigableCards(rows, true, true, 'list');
    expect(navigable.map((item) => item.id)).toEqual(['ordinary', 'parent']);
    expect(adjacentListCard(navigable, 'ordinary', 'j')?.id).toBe('parent');
    expect(adjacentListCard(navigable, 'parent', 'k')?.id).toBe('ordinary');
  });

  it('includes Done cards while the Done column is expanded', () => {
    const navigable = keyboardNavigableCards(cards, false);

    expect(navigable.map((item) => item.id)).toEqual(['ready', 'approved', 'done']);
    expect(adjacentBoardCard(navigable, 'approved', 'l')?.id).toBe('done');
  });
});
