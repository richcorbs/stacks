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

export function splitLeaf(node: SplitNode, targetPaneId: string, newPaneId: string, direction: 'row' | 'column'): SplitNode {
  if (node.kind === 'empty') return node;
  if (node.kind === 'leaf') {
    if (node.paneId !== targetPaneId) return node;
    return {
      kind: 'split',
      direction,
      ratio: 0.5,
      first: node,
      second: { kind: 'leaf', paneId: newPaneId },
    };
  }
  return {
    ...node,
    first: splitLeaf(node.first, targetPaneId, newPaneId, direction),
    second: splitLeaf(node.second, targetPaneId, newPaneId, direction),
  };
}

export function setSplitRatio(node: SplitNode, path: string, ratio: number): SplitNode {
  if (node.kind !== 'split') return node;
  if (path === '') return { ...node, ratio: Math.min(0.9, Math.max(0.1, ratio)) };
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
