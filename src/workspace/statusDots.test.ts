import { describe, expect, it } from 'vitest';
import { nextWorkspaceWithUnseenOutput, workspaceStatusDot } from './statusDots';

describe('nextWorkspaceWithUnseenOutput', () => {
  it('finds the next active workspace in visual order and wraps', () => {
    const workspaces = ['one', 'two', 'three', 'four'];
    expect(nextWorkspaceWithUnseenOutput(workspaces, ['two', 'four'], 'two')).toBe('four');
    expect(nextWorkspaceWithUnseenOutput(workspaces, ['two', 'four'], 'four')).toBe('two');
  });

  it('returns null when no other workspace has unseen output', () => {
    expect(nextWorkspaceWithUnseenOutput(['one', 'two'], ['one'], 'one')).toBeNull();
    expect(nextWorkspaceWithUnseenOutput([], ['one'], null)).toBeNull();
  });
});

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
