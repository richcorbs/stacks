export function nextTerminalIdForCycle(terminalIds: string[], currentTerminalId: string | null | undefined, delta: number) {
  if (terminalIds.length === 0) return null;
  const currentIndex = Math.max(0, terminalIds.findIndex((id) => id === currentTerminalId));
  const nextIndex = (currentIndex + delta + terminalIds.length) % terminalIds.length;
  return terminalIds[nextIndex] ?? null;
}

export function toggleMaximizedWorkspaceId(currentMaximizedWorkspaceId: string | null, workspaceId: string) {
  return currentMaximizedWorkspaceId === workspaceId ? null : workspaceId;
}

export function shouldClearMaximizedTerminalAfterClose(remainingTerminalCount: number) {
  return remainingTerminalCount <= 1;
}
