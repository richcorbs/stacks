import type { Pane, SplitNode } from '../types';
import { collectLeafPaneIds } from '../utils';

export function paneIdsForTerminal(
  terminalId: string,
  panesByTerminalId: Record<string, Pane[]>,
  splitRoot?: SplitNode | null,
) {
  const visualPaneIds = collectLeafPaneIds(splitRoot);
  return visualPaneIds.length > 0
    ? visualPaneIds
    : (panesByTerminalId[terminalId] ?? []).map((pane) => pane.id);
}

export function effectiveDisplayedMaximizedPaneId(maximizedTerminalId: string | null, terminalId: string, focusedPaneId: string | null, paneIds: string[]) {
  if (paneIds.length <= 1 || maximizedTerminalId !== terminalId) return null;
  return focusedPaneId && paneIds.includes(focusedPaneId) ? focusedPaneId : paneIds[0] ?? null;
}

export function shouldMaximizeTerminalAfterNewSplit(terminalId: string, existingPaneIds: string[], maximizedTerminalId: string | null) {
  return existingPaneIds.length > 1 && maximizedTerminalId === terminalId;
}

export function previousPaneIdAfterClose(paneIds: string[], closingPaneId: string) {
  const remainingPaneIds = paneIds.filter((id) => id !== closingPaneId);
  if (remainingPaneIds.length === 0) return null;
  const currentIndex = Math.max(0, paneIds.findIndex((id) => id === closingPaneId));
  return remainingPaneIds[(currentIndex - 1 + remainingPaneIds.length) % remainingPaneIds.length] ?? null;
}
