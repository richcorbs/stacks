import { describe, expect, it } from 'vitest';
import { workspaceStatusDot } from './statusDots';

describe('workspaceStatusDot', () => {
  it('shows alive for running workspaces without unacknowledged activity', () => {
    expect(workspaceStatusDot({ isRunning: true, hasUnacknowledgedActivity: false, activityAgeMs: 0 })).toBe('alive');
  });

  it('shows active for fresh unacknowledged activity', () => {
    expect(workspaceStatusDot({ isRunning: true, hasUnacknowledgedActivity: true, activityAgeMs: 4999 })).toBe('active');
  });

  it('shows unseen for older unacknowledged activity', () => {
    expect(workspaceStatusDot({ isRunning: true, hasUnacknowledgedActivity: true, activityAgeMs: 5000 })).toBe('unseen');
  });

  it('lets unacknowledged activity take priority over alive', () => {
    expect(workspaceStatusDot({ isRunning: true, hasUnacknowledgedActivity: true, activityAgeMs: 10_000 })).toBe('unseen');
  });

  it('shows nothing for inactive workspaces without unacknowledged activity', () => {
    expect(workspaceStatusDot({ isRunning: false, hasUnacknowledgedActivity: false, activityAgeMs: 0 })).toBeNull();
  });
});
