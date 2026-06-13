import type { TerminalEntry, SplitNode } from '../types';
import { collectLeafTerminalIds } from '../utils';

export function terminalIdsForWorkspace(
  workspaceId: string,
  terminalsByWorkspaceId: Record<string, TerminalEntry[]>,
  splitRoot?: SplitNode | null,
) {
  const visualTerminalIds = collectLeafTerminalIds(splitRoot);
  return visualTerminalIds.length > 0
    ? visualTerminalIds
    : (terminalsByWorkspaceId[workspaceId] ?? []).map((terminal) => terminal.id);
}

export function effectiveDisplayedMaximizedTerminalId(maximizedWorkspaceId: string | null, workspaceId: string, focusedTerminalId: string | null, terminalIds: string[]) {
  if (terminalIds.length <= 1 || maximizedWorkspaceId !== workspaceId) return null;
  return focusedTerminalId && terminalIds.includes(focusedTerminalId) ? focusedTerminalId : terminalIds[0] ?? null;
}

export function shouldMaximizeTerminalAfterNewSplit(workspaceId: string, existingTerminalIds: string[], maximizedWorkspaceId: string | null) {
  return existingTerminalIds.length > 1 && maximizedWorkspaceId === workspaceId;
}

export function previousTerminalIdAfterClose(terminalIds: string[], closingTerminalId: string) {
  const remainingTerminalIds = terminalIds.filter((id) => id !== closingTerminalId);
  if (remainingTerminalIds.length === 0) return null;
  const currentIndex = Math.max(0, terminalIds.findIndex((id) => id === closingTerminalId));
  return remainingTerminalIds[(currentIndex - 1 + remainingTerminalIds.length) % remainingTerminalIds.length] ?? null;
}
