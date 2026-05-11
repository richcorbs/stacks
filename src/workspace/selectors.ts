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

export function effectiveMaximizedPaneId(maximizedPaneId: string | null, paneIds: string[]) {
  if (paneIds.length <= 1) return null;
  return maximizedPaneId && paneIds.includes(maximizedPaneId) ? maximizedPaneId : null;
}

export function shouldMaximizeNewSplit(terminalId: string, existingPaneIds: string[], maximizedPaneId: string | null) {
  return existingPaneIds.length > 1 && Boolean(maximizedPaneId?.startsWith(`${terminalId}:`));
}

export function previousPaneIdAfterClose(paneIds: string[], closingPaneId: string) {
  const remainingPaneIds = paneIds.filter((id) => id !== closingPaneId);
  if (remainingPaneIds.length === 0) return null;
  const currentIndex = Math.max(0, paneIds.findIndex((id) => id === closingPaneId));
  return remainingPaneIds[(currentIndex - 1 + remainingPaneIds.length) % remainingPaneIds.length] ?? null;
}
