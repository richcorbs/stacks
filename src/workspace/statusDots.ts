export type WorkspaceStatusDot = 'alive' | 'active' | 'unseen' | null;
export const FRESH_ACTIVITY_MS = 5000;

export function nextWorkspaceWithUnseenOutput(
  workspaceIds: string[],
  activityWorkspaceIds: string[],
  activeWorkspaceId: string | null,
) {
  if (workspaceIds.length === 0 || activityWorkspaceIds.length === 0) return null;
  const activityIds = new Set(activityWorkspaceIds);
  const activeIndex = workspaceIds.indexOf(activeWorkspaceId ?? '');
  const startIndex = activeIndex >= 0 ? activeIndex : -1;
  for (let offset = 1; offset <= workspaceIds.length; offset += 1) {
    const workspaceId = workspaceIds[(startIndex + offset) % workspaceIds.length];
    if (workspaceId !== activeWorkspaceId && activityIds.has(workspaceId)) return workspaceId;
  }
  return null;
}

export function workspaceStatusDot({
  isRunning,
  hasUnacknowledgedActivity,
  activityAgeMs,
  freshActivityMs = FRESH_ACTIVITY_MS,
}: {
  isRunning: boolean;
  hasUnacknowledgedActivity: boolean;
  activityAgeMs: number;
  freshActivityMs?: number;
}): WorkspaceStatusDot {
  if (hasUnacknowledgedActivity) return activityAgeMs < freshActivityMs ? 'active' : 'unseen';
  if (isRunning) return 'alive';
  return null;
}
