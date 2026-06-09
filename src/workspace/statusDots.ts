export type WorkspaceStatusDot = 'alive' | 'active' | 'unseen' | null;

export function workspaceStatusDot({
  isRunning,
  hasUnacknowledgedActivity,
  activityAgeMs,
  freshActivityMs = 5000,
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
