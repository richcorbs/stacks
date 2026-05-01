import type { SplitNode } from './types';

export function basename(path: string) {
  return path.replace(/\/$/, '').split('/').pop() || path;
}

export function loadSidebarWidth() {
  const raw = window.localStorage.getItem('stacks.sidebarWidth');
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? Math.min(420, Math.max(180, parsed)) : 260;
}

export function collectLeafPaneIds(node: SplitNode | null | undefined): string[] {
  if (!node || node.kind === 'empty') return [];
  if (node.kind === 'leaf') return [node.paneId];
  return [...collectLeafPaneIds(node.first), ...collectLeafPaneIds(node.second)];
}

export function normalizeSplitNode(node: SplitNode | null | undefined): SplitNode | null {
  if (!node || node.kind === 'empty') return null;
  if (node.kind === 'leaf') return node;
  const first = normalizeSplitNode(node.first);
  const second = normalizeSplitNode(node.second);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function parseDragData(value: string) {
  const parts = value.split(':');
  if (parts[0] === 'project' && parts[1]) return { kind: 'project' as const, projectId: parts[1] };
  if (parts[0] === 'terminal' && parts[1] && parts[2]) return { kind: 'terminal' as const, projectId: parts[1], terminalId: parts[2] };
  return null;
}

function containsLeaf(node: SplitNode, paneId: string): boolean {
  if (node.kind === 'empty') return false;
  if (node.kind === 'leaf') return node.paneId === paneId;
  return containsLeaf(node.first, paneId) || containsLeaf(node.second, paneId);
}

function flattenSameDirection(node: SplitNode, direction: 'row' | 'column'): SplitNode[] {
  if (node.kind === 'split' && node.direction === direction) {
    return [...flattenSameDirection(node.first, direction), ...flattenSameDirection(node.second, direction)];
  }
  return [node];
}

function buildEqualSplit(direction: 'row' | 'column', children: SplitNode[]): SplitNode {
  if (children.length === 1) return children[0];
  const [first, ...rest] = children;
  return {
    kind: 'split',
    direction,
    ratio: 1 / children.length,
    first,
    second: buildEqualSplit(direction, rest),
  };
}

export function rebalanceSplits(node: SplitNode | null, changedPaneId: string): SplitNode | null {
  if (!node || node.kind !== 'split') return node;

  const first = rebalanceSplits(node.first, changedPaneId);
  const second = rebalanceSplits(node.second, changedPaneId);
  const normalized = normalizeSplitNode({ ...node, first: first ?? { kind: 'empty' }, second: second ?? { kind: 'empty' } });
  if (!normalized || normalized.kind !== 'split') return normalized;

  if (!normalized.manual && normalized.direction === node.direction) {
    return buildEqualSplit(normalized.direction, flattenSameDirection(normalized, normalized.direction));
  }

  return normalized;
}

function splitLeafInner(node: SplitNode, targetPaneId: string, newPaneId: string, direction: 'row' | 'column'): { node: SplitNode; changed: boolean } {
  if (node.kind === 'empty') return { node, changed: false };
  if (node.kind === 'leaf') {
    if (node.paneId !== targetPaneId) return { node, changed: false };
    return {
      changed: true,
      node: {
        kind: 'split',
        direction,
        ratio: 0.5,
        first: node,
        second: { kind: 'leaf', paneId: newPaneId },
      },
    };
  }

  if (node.direction === direction && containsLeaf(node, targetPaneId)) {
    const children = flattenSameDirection(node, direction);
    const nextChildren = children.flatMap((child) => {
      if (child.kind === 'leaf' && child.paneId === targetPaneId) {
        return [child, { kind: 'leaf' as const, paneId: newPaneId }];
      }
      if (containsLeaf(child, targetPaneId)) {
        return [splitLeafInner(child, targetPaneId, newPaneId, direction).node];
      }
      return [child];
    });
    return { node: buildEqualSplit(direction, nextChildren), changed: true };
  }

  const first = splitLeafInner(node.first, targetPaneId, newPaneId, direction);
  if (first.changed) return { node: { ...node, first: first.node }, changed: true };
  const second = splitLeafInner(node.second, targetPaneId, newPaneId, direction);
  if (second.changed) return { node: { ...node, second: second.node }, changed: true };
  return { node, changed: false };
}

export function splitLeaf(node: SplitNode, targetPaneId: string, newPaneId: string, direction: 'row' | 'column'): SplitNode {
  return splitLeafInner(node, targetPaneId, newPaneId, direction).node;
}

export function setSplitRatio(node: SplitNode, path: string, ratio: number): SplitNode {
  if (node.kind !== 'split') return node;
  if (path === '') return { ...node, ratio: Math.min(0.9, Math.max(0.1, ratio)), manual: true };
  const [head, ...rest] = path.split('.');
  const childPath = rest.join('.');
  return {
    ...node,
    first: head === 'first' ? setSplitRatio(node.first, childPath, ratio) : node.first,
    second: head === 'second' ? setSplitRatio(node.second, childPath, ratio) : node.second,
  };
}

export function removeLeaf(node: SplitNode, paneId: string): SplitNode | null {
  if (node.kind === 'empty') return node;
  if (node.kind === 'leaf') return node.paneId === paneId ? null : node;
  const first = removeLeaf(node.first, paneId);
  const second = removeLeaf(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}
