import type { MaximizedWorkspaceIds, TerminalEntry, SplitNode } from '../types';
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

export function effectiveDisplayedMaximizedTerminalId(maximizedWorkspaceIds: MaximizedWorkspaceIds, workspaceId: string, focusedTerminalId: string | null, terminalIds: string[]) {
  if (terminalIds.length <= 1 || !maximizedWorkspaceIds[workspaceId]) return null;
  return focusedTerminalId && terminalIds.includes(focusedTerminalId) ? focusedTerminalId : terminalIds[0] ?? null;
}

export function shouldMaximizeTerminalAfterNewSplit(workspaceId: string, existingTerminalIds: string[], maximizedWorkspaceIds: MaximizedWorkspaceIds) {
  return existingTerminalIds.length > 1 && Boolean(maximizedWorkspaceIds[workspaceId]);
}

export function previousTerminalIdAfterClose(terminalIds: string[], closingTerminalId: string) {
  const remainingTerminalIds = terminalIds.filter((id) => id !== closingTerminalId);
  if (remainingTerminalIds.length === 0) return null;
  const currentIndex = Math.max(0, terminalIds.findIndex((id) => id === closingTerminalId));
  return remainingTerminalIds[(currentIndex - 1 + remainingTerminalIds.length) % remainingTerminalIds.length] ?? null;
}
