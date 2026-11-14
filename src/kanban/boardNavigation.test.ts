import { describe, expect, it } from 'vitest';
import type { KanbanCard, KanbanStatus } from './types';
import { adjacentListCard, keyboardNavigableCards } from './boardNavigation';

function card(id: string, status: KanbanStatus): KanbanCard {
  return { id, status } as KanbanCard;
}

describe('list keyboard navigation', () => {
  const cards = [card('ready', 'ready'), card('approved', 'approved'), card('done', 'done')];

  it('excludes Done cards while the Done group is collapsed', () => {
    const navigable = keyboardNavigableCards(cards, true);

    expect(navigable.map((item) => item.id)).toEqual(['ready', 'approved']);
    expect(adjacentListCard(navigable, 'approved', 'j')?.id).toBe('approved');
  });

  it('excludes collapsed list groups independently', () => {
    const grouped = [card('backlog', 'needs_refinement'), ...cards];
    expect(keyboardNavigableCards(grouped, true, true).map((item) => item.id)).toEqual(['ready', 'approved']);
    expect(keyboardNavigableCards(grouped, false, true).map((item) => item.id)).toEqual(['ready', 'approved', 'done']);
    expect(keyboardNavigableCards(grouped, true, false).map((item) => item.id)).toEqual(['backlog', 'ready', 'approved']);
    expect(adjacentListCard(keyboardNavigableCards(grouped, true, true), 'approved', 'k')?.id).toBe('ready');
  });

  it('skips each hidden list group', () => {
    const grouped = [card('attention', 'needs_human'), card('progress', 'agent_working'), card('backlog', 'needs_refinement'), card('done', 'done')];
    expect(keyboardNavigableCards(grouped, false, false, true, false).map((item) => item.id)).toEqual(['progress', 'backlog', 'done']);
    expect(keyboardNavigableCards(grouped, false, false, false, true).map((item) => item.id)).toEqual(['attention', 'backlog', 'done']);
    const onlyBacklog = keyboardNavigableCards(grouped, true, false, true, true);
    expect(adjacentListCard(onlyBacklog, null, 'j')?.id).toBe('backlog');
  });

  it('navigates through list rows in presentation order', () => {
    const grouped = [card('ready', 'ready'), card('approved', 'approved'), card('refining', 'refining'), card('backlog', 'needs_refinement')];
    expect(adjacentListCard(grouped, 'approved', 'j')?.id).toBe('refining');
    expect(adjacentListCard(grouped, 'refining', 'j')?.id).toBe('backlog');
    expect(adjacentListCard(grouped, 'approved', 'k')?.id).toBe('ready');
    expect(adjacentListCard(grouped, 'ready', 'k')?.id).toBe('ready');
  });

  it('moves both ways between an ordinary list row and the parent row directly below it', () => {
    const rows = [card('ordinary', 'ready'), { ...card('parent', 'ready'), child_count: 2 }];
    const navigable = keyboardNavigableCards(rows, true, true);
    expect(navigable.map((item) => item.id)).toEqual(['ordinary', 'parent']);
    expect(adjacentListCard(navigable, 'ordinary', 'j')?.id).toBe('parent');
    expect(adjacentListCard(navigable, 'parent', 'k')?.id).toBe('ordinary');
  });

  it('includes Done cards while the Done group is expanded', () => {
    const navigable = keyboardNavigableCards(cards, false);

    expect(navigable.map((item) => item.id)).toEqual(['ready', 'approved', 'done']);
    expect(adjacentListCard(navigable, 'approved', 'j')?.id).toBe('done');
  });
});
