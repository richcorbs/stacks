import type { SplitNode } from './types';

export function basename(path: string) {
  return path.replace(/\/$/, '').split('/').pop() || path;
}

export function loadSidebarWidth() {
  const raw = window.localStorage.getItem('stacks.sidebarWidth');
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? Math.min(420, Math.max(180, parsed)) : 260;
}

function leafTerminalId(node: Extract<SplitNode, { kind: 'leaf' }>) {
  return node.terminalId ?? (node as unknown as { paneId?: string }).paneId ?? null;
}

export function collectLeafTerminalIds(node: SplitNode | null | undefined): string[] {
  if (!node || node.kind === 'empty') return [];
  if (node.kind === 'leaf') {
    const terminalId = leafTerminalId(node);
    return terminalId ? [terminalId] : [];
  }
  return [...collectLeafTerminalIds(node.first), ...collectLeafTerminalIds(node.second)];
}

export function collectLeafTerminals(node: SplitNode | null | undefined): { id: string; command?: string | null }[] {
  if (!node || node.kind === 'empty') return [];
  if (node.kind === 'leaf') {
    const terminalId = leafTerminalId(node);
    return terminalId ? [{ id: terminalId, command: node.command ?? null }] : [];
  }
  return [...collectLeafTerminals(node.first), ...collectLeafTerminals(node.second)];
}

export function normalizeSplitNode(node: SplitNode | null | undefined): SplitNode | null {
  if (!node || node.kind === 'empty') return null;
  if (node.kind === 'leaf') {
    const terminalId = leafTerminalId(node);
    return terminalId ? { kind: 'leaf', terminalId, command: node.command } : null;
  }
  const first = normalizeSplitNode(node.first);
  const second = normalizeSplitNode(node.second);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function parseDragData(value: string) {
  const parts = value.split(':');
  if (parts[0] === 'project' && parts[1]) return { kind: 'project' as const, projectId: parts[1] };
  if (parts[0] === 'terminal' && parts[1] && parts[2]) return { kind: 'workspace' as const, projectId: parts[1], workspaceId: parts[2] };
  return null;
}

function containsLeaf(node: SplitNode, terminalId: string): boolean {
  if (node.kind === 'empty') return false;
  if (node.kind === 'leaf') return node.terminalId === terminalId;
  return containsLeaf(node.first, terminalId) || containsLeaf(node.second, terminalId);
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

export function buildGridSplit(terminalIds: string[], rows: number, columns: number): SplitNode {
  const safeRows = Math.min(5, Math.max(1, Math.floor(rows || 1)));
  const safeColumns = Math.min(5, Math.max(1, Math.floor(columns || 1)));
  const cells = terminalIds.length > 0 ? terminalIds : ['terminal:0'];
  const rowNodes = Array.from({ length: safeRows }, (_, rowIndex) => {
    const start = rowIndex * safeColumns;
    const rowTerminalIds = cells.slice(start, start + safeColumns);
    const leaves = rowTerminalIds.map((terminalId) => ({ kind: 'leaf' as const, terminalId }));
    return buildEqualSplit('row', leaves.length > 0 ? leaves : [{ kind: 'leaf' as const, terminalId: cells[cells.length - 1] }]);
  });
  return buildEqualSplit('column', rowNodes);
}

export function rebalanceSplits(node: SplitNode | null, changedTerminalId: string): SplitNode | null {
  if (!node || node.kind !== 'split') return node;

  const first = rebalanceSplits(node.first, changedTerminalId);
  const second = rebalanceSplits(node.second, changedTerminalId);
  const normalized = normalizeSplitNode({ ...node, first: first ?? { kind: 'empty' }, second: second ?? { kind: 'empty' } });
  if (!normalized || normalized.kind !== 'split') return normalized;

  if (!normalized.manual && normalized.direction === node.direction) {
    return buildEqualSplit(normalized.direction, flattenSameDirection(normalized, normalized.direction));
  }

  return normalized;
}

function splitLeafInner(node: SplitNode, targetTerminalId: string, newTerminalId: string, direction: 'row' | 'column', command: string | null = null): { node: SplitNode; changed: boolean } {
  if (node.kind === 'empty') return { node, changed: false };
  if (node.kind === 'leaf') {
    if (node.terminalId !== targetTerminalId) return { node, changed: false };
    return {
      changed: true,
      node: {
        kind: 'split',
        direction,
        ratio: 0.5,
        first: node,
        second: command ? { kind: 'leaf', terminalId: newTerminalId, command } : { kind: 'leaf', terminalId: newTerminalId },
      },
    };
  }

  if (node.direction === direction && containsLeaf(node, targetTerminalId)) {
    const children = flattenSameDirection(node, direction);
    const nextChildren = children.flatMap((child) => {
      if (child.kind === 'leaf' && child.terminalId === targetTerminalId) {
        return [child, command ? { kind: 'leaf' as const, terminalId: newTerminalId, command } : { kind: 'leaf' as const, terminalId: newTerminalId }];
      }
      if (containsLeaf(child, targetTerminalId)) {
        return [splitLeafInner(child, targetTerminalId, newTerminalId, direction, command).node];
      }
      return [child];
    });
    return { node: buildEqualSplit(direction, nextChildren), changed: true };
  }

  const first = splitLeafInner(node.first, targetTerminalId, newTerminalId, direction, command);
  if (first.changed) return { node: { ...node, first: first.node }, changed: true };
  const second = splitLeafInner(node.second, targetTerminalId, newTerminalId, direction, command);
  if (second.changed) return { node: { ...node, second: second.node }, changed: true };
  return { node, changed: false };
}

export function splitLeaf(node: SplitNode, targetTerminalId: string, newTerminalId: string, direction: 'row' | 'column', command: string | null = null): SplitNode {
  return splitLeafInner(node, targetTerminalId, newTerminalId, direction, command).node;
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

export function removeLeaf(node: SplitNode, terminalId: string): SplitNode | null {
  if (node.kind === 'empty') return node;
  if (node.kind === 'leaf') return node.terminalId === terminalId ? null : node;
  const first = removeLeaf(node.first, terminalId);
  const second = removeLeaf(node.second, terminalId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}
