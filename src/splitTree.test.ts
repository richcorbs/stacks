import { describe, expect, it } from 'vitest';
import type { SplitNode } from './types';
import {
  closePane,
  collectLeafTerminalIds,
  focusPane,
  layoutSignature,
  normalizeSplitNode,
  previousVisualPaneId,
  relativePaneId,
  removeLeaf,
  resolveFocusedPaneId,
  resolveMaximizedPaneId,
  setSplitRatio,
  splitLeaf,
  toggleMaximizedPane,
} from './splitTree';

/** Deterministic PRNG so a failing property is reproducible from its seed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomTree(next: () => number, leaves: number): SplitNode {
  if (leaves <= 1) return { kind: 'leaf', terminalId: `pane:${Math.floor(next() * 1e6)}`, ...(next() > 0.5 ? { paneKind: 'pi' as const } : {}) };
  const first = 1 + Math.floor(next() * (leaves - 1));
  return {
    kind: 'split',
    direction: next() > 0.5 ? 'row' : 'column',
    ...(next() > 0.5 ? { ratio: next() } : {}),
    ...(next() > 0.7 ? { manual: true } : {}),
    first: randomTree(next, first),
    second: randomTree(next, leaves - first),
  };
}

function uniqueLeaves(tree: SplitNode) {
  const ids = collectLeafTerminalIds(tree);
  expect(new Set(ids).size).toBe(ids.length);
  return ids;
}

describe('split tree properties', () => {
  it('keeps every random tree invertible and its visual order stable', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const tree = randomTree(random(seed), 2 + (seed % 7));
      const ids = uniqueLeaves(tree);
      expect(normalizeSplitNode(normalizeSplitNode(tree))).toEqual(normalizeSplitNode(tree));
      expect(collectLeafTerminalIds(normalizeSplitNode(tree))).toEqual(ids);
      expect(JSON.parse(JSON.stringify(tree))).toEqual(tree);
    }
  });

  it('inserts and removes random leaves without orphaning or reordering survivors', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const next = random(seed);
      let tree = randomTree(next, 2 + (seed % 5));
      const inserted: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const before = collectLeafTerminalIds(tree);
        const target = before[Math.floor(next() * before.length)];
        const pane = `inserted:${seed}:${index}`;
        const direction = next() > 0.5 ? 'row' : 'column';
        tree = splitLeaf(tree, target, pane, direction);
        inserted.push(pane);
        const after = collectLeafTerminalIds(tree);
        expect(after.filter((id) => id !== pane)).toEqual(before);
        expect(after.filter((id) => id === pane)).toHaveLength(1);
        expect(after.indexOf(pane)).toBe(before.indexOf(target) + 1);
        uniqueLeaves(tree);
      }
      while (collectLeafTerminalIds(tree).length > 1) {
        const before = collectLeafTerminalIds(tree);
        const closing = before[Math.floor(next() * before.length)];
        const focus = closePane(tree, closing);
        expect(focus.focusedPaneId).toBe(previousVisualPaneId(tree, closing));
        expect(collectLeafTerminalIds(focus.tree)).toEqual(before.filter((id) => id !== closing));
        tree = focus.tree;
      }
    }
  });

  it('always resolves focus and maximize to a leaf of the current tree', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = random(seed);
      const tree = randomTree(next, 2 + (seed % 6));
      const ids = collectLeafTerminalIds(tree);
      const missing = 'pane:not-in-tree';
      expect(resolveFocusedPaneId(tree, missing)).toBe(ids[0]);
      expect(resolveFocusedPaneId(tree, ids.at(-1)!)).toBe(ids.at(-1));
      expect(resolveMaximizedPaneId(tree, missing)).toBeNull();
      expect(ids).toContain(resolveMaximizedPaneId(tree, ids[1]));
      expect(resolveFocusedPaneId({ kind: 'empty' }, 'pane:any')).toBeNull();
      expect(previousVisualPaneId(tree, missing)).toBeNull();
      const focus = focusPane(ids[1], ids[0]);
      expect(focus).toEqual({ focusedPaneId: ids[1], maximizedPaneId: ids[1] });
      expect(toggleMaximizedPane(ids[1], ids[1])).toEqual({ focusedPaneId: ids[1], maximizedPaneId: null });
      expect(toggleMaximizedPane(ids[1], null)).toEqual({ focusedPaneId: ids[1], maximizedPaneId: ids[1] });
      expect(closePane({ kind: 'leaf', terminalId: ids[0] }, ids[0])).toEqual({ tree: { kind: 'empty' }, focusedPaneId: null });
    }
  });

  it('wraps focus to the previous visual leaf and cycles navigation identically', () => {
    const tree: SplitNode = {
      kind: 'split',
      direction: 'row',
      first: { kind: 'leaf', terminalId: 'a' },
      second: { kind: 'split', direction: 'column', first: { kind: 'leaf', terminalId: 'b' }, second: { kind: 'leaf', terminalId: 'c' } },
    };
    expect(previousVisualPaneId(tree, 'c')).toBe('b');
    expect(previousVisualPaneId(tree, 'b')).toBe('a');
    expect(previousVisualPaneId(tree, 'a')).toBe('c');
    expect(relativePaneId(tree, 'a', -1)).toBe(previousVisualPaneId(tree, 'a'));
    expect(relativePaneId(tree, 'c', 1)).toBe('a');
  });

  it('distributes automatic siblings evenly and never rebalances manual splits', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const next = random(seed);
      let tree = { kind: 'leaf', terminalId: 'root' } as SplitNode;
      for (let index = 0; index < 5; index += 1) {
        tree = splitLeaf(tree, collectLeafTerminalIds(tree)[Math.floor(next() * (index + 1))], `pane:${index}`, 'row');
      }
      let splits = 0;
      const flatten = (node: SplitNode, direction: 'row' | 'column'): SplitNode[] => node.kind === 'split' && node.direction === direction
        ? [...flatten(node.first, direction), ...flatten(node.second, direction)]
        : [node];
      const walk = (node: SplitNode) => {
        if (node.kind !== 'split') return;
        expect(node.manual).toBeUndefined();
        // An automatic split is even: its ratio is one over its same-direction children.
        expect(Math.round(1 / node.ratio!)).toBe(flatten(node, node.direction).length);
        splits += 1;
        walk(node.first);
        walk(node.second);
      };
      walk(tree);
      expect(splits).toBeGreaterThan(0);
      const manual = setSplitRatio(tree, '', 0.25);
      expect(manual).toMatchObject({ ratio: 0.25, manual: true });
      expect(removeLeaf(manual, 'pane:0')).toMatchObject({ manual: true, ratio: 0.25 });
    }
  });

  it('freezes the persisted layout shape', () => {
    const tree = splitLeaf({ kind: 'leaf', terminalId: 'pane:shell' }, 'pane:shell', 'pane:new', 'column', 'npm run dev', 'pi');
    expect(JSON.stringify(tree)).toBe('{"kind":"split","direction":"column","ratio":0.5,"first":{"kind":"leaf","terminalId":"pane:shell"},"second":{"kind":"leaf","terminalId":"pane:new","paneKind":"pi","command":"npm run dev"}}');
    expect(layoutSignature(tree, 'pane:new')).toBe(`[${JSON.stringify(tree)},"pane:new"]`);
    expect(JSON.stringify(closePane(tree, 'pane:new').tree)).toBe('{"kind":"leaf","terminalId":"pane:shell"}');
    expect(JSON.stringify(setSplitRatio(tree, '', 0.42))).toBe('{"kind":"split","direction":"column","ratio":0.42,"first":{"kind":"leaf","terminalId":"pane:shell"},"second":{"kind":"leaf","terminalId":"pane:new","paneKind":"pi","command":"npm run dev"},"manual":true}');
  });
});
