import { describe, expect, it } from 'vitest';
import { emptyBoard, parseSuperthreadSpaces } from './api';

describe('Superthread API models', () => {
  it('normalizes configured spaces', () => {
    expect(parseSuperthreadSpaces(' Product, Engineering, Product, ')).toEqual(['Product', 'Engineering']);
  });

  it('creates an unloaded board cache entry', () => {
    expect(emptyBoard({ id: 'board-1', title: 'Roadmap' })).toEqual({
      id: 'board-1',
      title: 'Roadmap',
      lists: [],
      cards: [],
    });
  });
});
