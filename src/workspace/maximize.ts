import type { MaximizedWorkspaceIds } from '../types';

export function nextTerminalIdForCycle(terminalIds: string[], currentTerminalId: string | null | undefined, delta: number) {
  if (terminalIds.length === 0) return null;
  const currentIndex = Math.max(0, terminalIds.findIndex((id) => id === currentTerminalId));
  const nextIndex = (currentIndex + delta + terminalIds.length) % terminalIds.length;
  return terminalIds[nextIndex] ?? null;
}

export function isWorkspaceMaximized(maximizedWorkspaceIds: MaximizedWorkspaceIds, workspaceId: string) {
  return Boolean(maximizedWorkspaceIds[workspaceId]);
}

export function setWorkspaceMaximized(maximizedWorkspaceIds: MaximizedWorkspaceIds, workspaceId: string, maximized: boolean) {
  if (maximized) return maximizedWorkspaceIds[workspaceId] ? maximizedWorkspaceIds : { ...maximizedWorkspaceIds, [workspaceId]: true };
  if (!maximizedWorkspaceIds[workspaceId]) return maximizedWorkspaceIds;
  const next = { ...maximizedWorkspaceIds };
  delete next[workspaceId];
  return next;
}

export function toggleMaximizedWorkspace(maximizedWorkspaceIds: MaximizedWorkspaceIds, workspaceId: string) {
  return setWorkspaceMaximized(maximizedWorkspaceIds, workspaceId, !isWorkspaceMaximized(maximizedWorkspaceIds, workspaceId));
}

export function shouldClearMaximizedTerminalAfterClose(remainingTerminalCount: number) {
  return remainingTerminalCount <= 1;
}
