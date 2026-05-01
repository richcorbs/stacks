import { describe, expect, it } from 'vitest';
import { collectLeafPaneIds, normalizeSplitNode, rebalanceSplits, removeLeaf, setSplitRatio, splitLeaf } from './utils';
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

  it('evenly distributes siblings when splitting in an existing split direction', () => {
    const root: SplitNode = {
      kind: 'split',
      direction: 'row',
      ratio: 0.5,
      first: { kind: 'leaf', paneId: 'a' },
      second: { kind: 'leaf', paneId: 'b' },
    };
    expect(splitLeaf(root, 'b', 'c', 'row')).toEqual({
      kind: 'split',
      direction: 'row',
      ratio: 1 / 3,
      first: { kind: 'leaf', paneId: 'a' },
      second: {
        kind: 'split',
        direction: 'row',
        ratio: 0.5,
        first: { kind: 'leaf', paneId: 'b' },
        second: { kind: 'leaf', paneId: 'c' },
      },
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

  it('removes nested leaves while preserving the remaining branch', () => {
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
    expect(removeLeaf(root, 'b')).toEqual({
      kind: 'split',
      direction: 'row',
      first: { kind: 'leaf', paneId: 'a' },
      second: { kind: 'leaf', paneId: 'c' },
    });
  });

  it('returns null when removing the only leaf', () => {
    expect(removeLeaf({ kind: 'leaf', paneId: 'a' }, 'a')).toBeNull();
  });

  it('leaves the tree unchanged when removing an unknown leaf', () => {
    const root: SplitNode = {
      kind: 'split',
      direction: 'row',
      first: { kind: 'leaf', paneId: 'a' },
      second: { kind: 'leaf', paneId: 'b' },
    };
    expect(removeLeaf(root, 'missing')).toEqual(root);
  });

  it('rebalances automatic splits after pane removal', () => {
    const root: SplitNode = {
      kind: 'split',
      direction: 'row',
      ratio: 1 / 3,
      first: { kind: 'leaf', paneId: 'a' },
      second: {
        kind: 'split',
        direction: 'row',
        ratio: 0.5,
        first: { kind: 'leaf', paneId: 'b' },
        second: { kind: 'leaf', paneId: 'c' },
      },
    };
    expect(rebalanceSplits(removeLeaf(root, 'b'), 'b')).toEqual({
      kind: 'split',
      direction: 'row',
      ratio: 0.5,
      first: { kind: 'leaf', paneId: 'a' },
      second: { kind: 'leaf', paneId: 'c' },
    });
  });

  it('does not rebalance manually resized splits after pane removal', () => {
    const root: SplitNode = {
      kind: 'split',
      direction: 'row',
      ratio: 0.25,
      manual: true,
      first: { kind: 'leaf', paneId: 'a' },
      second: {
        kind: 'split',
        direction: 'row',
        ratio: 0.5,
        first: { kind: 'leaf', paneId: 'b' },
        second: { kind: 'leaf', paneId: 'c' },
      },
    };
    expect(rebalanceSplits(removeLeaf(root, 'b'), 'b')).toEqual({
      kind: 'split',
      direction: 'row',
      ratio: 0.25,
      manual: true,
      first: { kind: 'leaf', paneId: 'a' },
      second: { kind: 'leaf', paneId: 'c' },
    });
  });

  it('clamps root split ratios at both ends', () => {
    const root: SplitNode = {
      kind: 'split',
      direction: 'row',
      first: { kind: 'leaf', paneId: 'a' },
      second: { kind: 'leaf', paneId: 'b' },
    };
    expect((setSplitRatio(root, '', 0.01) as Extract<SplitNode, { kind: 'split' }>).ratio).toBe(0.1);
    expect((setSplitRatio(root, '', 0.99) as Extract<SplitNode, { kind: 'split' }>).ratio).toBe(0.9);
  });
});
