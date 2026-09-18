import { describe, expect, it } from 'vitest';
import { dragPreviewOrder, dropTargetFromCards } from './boardInteractions';

function cardElement(id: string, top: number, height = 20) {
  return {
    dataset: { kanbanCardId: id },
    getBoundingClientRect: () => ({ top, height }),
  } as unknown as HTMLElement;
}

describe('dragPreviewOrder', () => {
  const ids = ['a', 'b', 'c'];

  it.each([
    ['first position', 'c', 'a', ['c', 'a', 'b']],
    ['middle position', 'a', 'c', ['b', 'a', 'c']],
    ['final position', 'a', null, ['b', 'c', 'a']],
    ['unchanged position', 'b', 'c', ['a', 'b', 'c']],
  ] as const)('builds the transient %s', (_name, sourceId, beforeId, expected) => {
    expect(dragPreviewOrder(ids, sourceId, beforeId)).toEqual(expected);
  });

  it('retains canonical order when the pointer is outside the source column', () => {
    expect(dragPreviewOrder(ids, 'a', undefined)).toBe(ids);
  });
});

describe('dropTargetFromCards', () => {
  const cards = [cardElement('a', 10), cardElement('b', 30), cardElement('c', 50)];

  it.each([
    ['before the first card', 0, 'a'],
    ['at a middle position', 41, 'c'],
    ['after the last card', 100, null],
  ] as const)('uses card midpoints %s', (_name, y, expected) => {
    expect(dropTargetFromCards(cards, 'source', y)).toBe(expected);
  });

  it('ignores the dragged card during midpoint hit testing', () => {
    expect(dropTargetFromCards(cards, 'b', 31)).toBe('c');
  });
});
