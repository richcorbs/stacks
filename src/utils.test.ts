import { describe, expect, it } from 'vitest';
import { collectLeafPaneIds, normalizeSplitNode, removeLeaf, setSplitRatio, splitLeaf } from './utils';
import type { SplitNode } from './types';

describe('split tree utilities', () => {
  it('splits only the targeted leaf', () => {
    const root: SplitNode = { kind: 'leaf', paneId: 'a' };
    expect(splitLeaf(root, 'a', 'b', 'row')).toEqual({
      kind: 'split',
      direction: 'row',
      ratio: 0.5,
      first: { kind: 'leaf', paneId: 'a' },
      second: { kind: 'leaf', paneId: 'b' },
    });
  });

  it('collapses sibling when removing a leaf', () => {
    const root: SplitNode = {
      kind: 'split',
      direction: 'row',
      ratio: 0.4,
      first: { kind: 'leaf', paneId: 'a' },
      second: { kind: 'leaf', paneId: 'b' },
    };
    expect(removeLeaf(root, 'a')).toEqual({ kind: 'leaf', paneId: 'b' });
  });

  it('normalizes empty branches away', () => {
    const root: SplitNode = {
      kind: 'split',
      direction: 'column',
      first: { kind: 'empty' },
      second: { kind: 'leaf', paneId: 'b' },
    };
    expect(normalizeSplitNode(root)).toEqual({ kind: 'leaf', paneId: 'b' });
  });

  it('updates nested split ratios by path and clamps values', () => {
    const root: SplitNode = {
      kind: 'split',
      direction: 'row',
      first: { kind: 'leaf', paneId: 'a' },
      second: {
        kind: 'split',
        direction: 'column',
        first: { kind: 'leaf', paneId: 'b' },
        second: { kind: 'leaf', paneId: 'c' },
      },
    };
    const next = setSplitRatio(root, 'second', 0.99);
    expect(next.kind).toBe('split');
    if (next.kind === 'split' && next.second.kind === 'split') {
      expect(next.second.ratio).toBe(0.9);
    }
  });

  it('collects leaf pane ids in visual order', () => {
    const root: SplitNode = {
      kind: 'split',
      direction: 'row',
      first: { kind: 'leaf', paneId: 'a' },
      second: {
        kind: 'split',
        direction: 'column',
        first: { kind: 'leaf', paneId: 'b' },
        second: { kind: 'leaf', paneId: 'c' },
      },
    };
    expect(collectLeafPaneIds(root)).toEqual(['a', 'b', 'c']);
  });
});
