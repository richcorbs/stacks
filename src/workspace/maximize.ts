export function nextPaneIdForCycle(paneIds: string[], currentPaneId: string | null | undefined, delta: number) {
  if (paneIds.length === 0) return null;
  const currentIndex = Math.max(0, paneIds.findIndex((id) => id === currentPaneId));
  const nextIndex = (currentIndex + delta + paneIds.length) % paneIds.length;
  return paneIds[nextIndex] ?? null;
}

export function toggleMaximizedTerminalId(currentMaximizedTerminalId: string | null, terminalId: string) {
  return currentMaximizedTerminalId === terminalId ? null : terminalId;
}

export function shouldClearMaximizedTerminalAfterClose(remainingPaneCount: number) {
  return remainingPaneCount <= 1;
}
