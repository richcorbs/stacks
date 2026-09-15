import type { SplitNode } from './types';
import { splitLeaf } from './utils';

export type TemporaryPaneRun = { terminalId: string; previousTree: SplitNode; previousFocus: string };

export function insertTemporaryPane(tree: SplitNode, focusedPaneId: string, terminalId: string) {
  return {
    run: { terminalId, previousTree: tree, previousFocus: focusedPaneId } satisfies TemporaryPaneRun,
    tree: splitLeaf(tree, focusedPaneId, terminalId, 'row', null),
    focusedPaneId: terminalId,
    maximizedPaneId: terminalId,
  };
}

export function temporaryPaneCwd(liveCwd: string | null | undefined, worktreePath: string | null | undefined) {
  return liveCwd?.trim() || worktreePath?.trim() || null;
}
