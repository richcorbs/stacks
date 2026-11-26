import type { PaneKind, SplitNode } from './types';

/**
 * The one owner of split-tree maths and focus/maximize invariants.
 *
 * Card environments, Project Workspaces, the top-level terminal and legacy
 * workspaces all store the same tree (leaves in visual order, one focused leaf,
 * an optional maximized leaf). They delegate here instead of re-deriving order,
 * even distribution or focus-on-removal, and `src/utils.ts` re-exports the
 * historical names so existing callers and tests keep working.
 */

function leafTerminalId(node: Extract<SplitNode, { kind: 'leaf' }>) {
  return node.terminalId ?? (node as unknown as { paneId?: string }).paneId ?? null;
}

export function relativePaneId(node: SplitNode, focusedPaneId: string | null, direction: -1 | 1): string | null {
  const ids = collectLeafTerminalIds(node);
  const index = ids.indexOf(focusedPaneId ?? '');
  return index < 0 || ids.length < 2 ? null : ids[(index + direction + ids.length) % ids.length];
}

export function collectLeafTerminalIds(node: SplitNode | null | undefined): string[] {
  if (!node || node.kind === 'empty') return [];
  if (node.kind === 'leaf') {
    const terminalId = leafTerminalId(node);
    return terminalId ? [terminalId] : [];
  }
  return [...collectLeafTerminalIds(node.first), ...collectLeafTerminalIds(node.second)];
}

export function collectLeafTerminals(node: SplitNode | null | undefined): { id: string; kind?: PaneKind; command?: string | null }[] {
  if (!node || node.kind === 'empty') return [];
  if (node.kind === 'leaf') {
    const terminalId = leafTerminalId(node);
    return terminalId ? [{ id: terminalId, ...(node.paneKind === 'pi' ? { kind: 'pi' as const } : {}), command: node.command ?? null }] : [];
  }
  return [...collectLeafTerminals(node.first), ...collectLeafTerminals(node.second)];
}

export function normalizeSplitNode(node: SplitNode | null | undefined): SplitNode | null {
  if (!node || node.kind === 'empty') return null;
  if (node.kind === 'leaf') {
    const terminalId = leafTerminalId(node);
    return terminalId ? { kind: 'leaf', terminalId, ...(node.paneKind === 'pi' ? { paneKind: 'pi' as const } : {}), command: node.command } : null;
  }
  const first = normalizeSplitNode(node.first);
  const second = normalizeSplitNode(node.second);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

/** A leaf's view kind: an explicit tree kind wins over the pane entry's kind. */
export function paneKindOf(node: Extract<SplitNode, { kind: 'leaf' }>, fallback?: PaneKind | null): PaneKind {
  return node.paneKind ?? fallback ?? 'terminal';
}

/** The focused leaf, falling back to the first leaf in visual order. */
export function resolveFocusedPaneId(tree: SplitNode, focusedPaneId: string | null): string | null {
  const ids = collectLeafTerminalIds(tree);
  return focusedPaneId && ids.includes(focusedPaneId) ? focusedPaneId : ids[0] ?? null;
}

/** Maximize is only meaningful for a leaf that is still in the tree. */
export function resolveMaximizedPaneId(tree: SplitNode, maximizedPaneId: string | null): string | null {
  return maximizedPaneId && collectLeafTerminalIds(tree).includes(maximizedPaneId) ? maximizedPaneId : null;
}

/** Focus the pane and keep maximize following focus, or leave maximize cleared. */
export function focusPane(paneId: string, maximizedPaneId: string | null) {
  return { focusedPaneId: paneId, maximizedPaneId: maximizedPaneId ? paneId : null };
}

/** Maximize the pane, or restore when it is already maximized. */
export function toggleMaximizedPane(paneId: string, maximizedPaneId: string | null) {
  return { focusedPaneId: paneId, maximizedPaneId: maximizedPaneId ? null : paneId };
}

/** The pane that takes focus when `paneId` closes: the previous leaf in visual order, wrapping. */
export function previousVisualPaneId(tree: SplitNode, paneId: string): string | null {
  const ids = collectLeafTerminalIds(tree);
  const index = ids.indexOf(paneId);
  const remaining = ids.filter((id) => id !== paneId);
  if (index < 0 || remaining.length === 0) return null;
  return remaining[(index - 1 + remaining.length) % remaining.length];
}

/** Remove a leaf and resolve the surviving focus in one step. */
export function closePane(tree: SplitNode, paneId: string): { tree: SplitNode; focusedPaneId: string | null } {
  return { tree: removeLeaf(tree, paneId) ?? { kind: 'empty' }, focusedPaneId: previousVisualPaneId(tree, paneId) };
}

/** Layout identity used by the persistence coordinators. */
export function layoutSignature(tree: SplitNode, focusedPaneId: string | null) {
  return JSON.stringify([tree, focusedPaneId]);
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

function splitLeafInner(node: SplitNode, targetTerminalId: string, newTerminalId: string, direction: 'row' | 'column', command: string | null = null, paneKind: PaneKind = 'terminal'): { node: SplitNode; changed: boolean } {
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
        second: { kind: 'leaf', terminalId: newTerminalId, ...(paneKind === 'pi' ? { paneKind } : {}), ...(command ? { command } : {}) },
      },
    };
  }

  if (node.direction === direction && containsLeaf(node, targetTerminalId)) {
    const children = flattenSameDirection(node, direction);
    const nextChildren = children.flatMap((child) => {
      if (child.kind === 'leaf' && child.terminalId === targetTerminalId) {
        return [child, { kind: 'leaf' as const, terminalId: newTerminalId, ...(paneKind === 'pi' ? { paneKind } : {}), ...(command ? { command } : {}) }];
      }
      if (containsLeaf(child, targetTerminalId)) {
        return [splitLeafInner(child, targetTerminalId, newTerminalId, direction, command, paneKind).node];
      }
      return [child];
    });
    return { node: buildEqualSplit(direction, nextChildren), changed: true };
  }

  const first = splitLeafInner(node.first, targetTerminalId, newTerminalId, direction, command, paneKind);
  if (first.changed) return { node: { ...node, first: first.node }, changed: true };
  const second = splitLeafInner(node.second, targetTerminalId, newTerminalId, direction, command, paneKind);
  if (second.changed) return { node: { ...node, second: second.node }, changed: true };
  return { node, changed: false };
}

export function splitLeaf(node: SplitNode, targetTerminalId: string, newTerminalId: string, direction: 'row' | 'column', command: string | null = null, paneKind: PaneKind = 'terminal'): SplitNode {
  return splitLeafInner(node, targetTerminalId, newTerminalId, direction, command, paneKind).node;
}

export function setLeafCommand(node: SplitNode, terminalId: string, command: string | null): SplitNode {
  if (node.kind === 'empty') return node;
  if (node.kind === 'leaf') return node.terminalId === terminalId ? { ...node, command } : node;
  return { ...node, first: setLeafCommand(node.first, terminalId, command), second: setLeafCommand(node.second, terminalId, command) };
}

export function setLeafPaneKind(node: SplitNode, terminalId: string, paneKind: PaneKind): SplitNode {
  if (node.kind === 'empty') return node;
  if (node.kind === 'leaf') return node.terminalId === terminalId
    ? { ...node, ...(paneKind === 'pi' ? { paneKind } : { paneKind: undefined }) }
    : node;
  return { ...node, first: setLeafPaneKind(node.first, terminalId, paneKind), second: setLeafPaneKind(node.second, terminalId, paneKind) };
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

export function removeLeaves(node: SplitNode, terminalIds: ReadonlySet<string>): SplitNode | null {
  if (node.kind === 'empty') return node;
  if (node.kind === 'leaf') return terminalIds.has(node.terminalId) ? null : node;
  const first = removeLeaves(node.first, terminalIds);
  const second = removeLeaves(node.second, terminalIds);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
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
