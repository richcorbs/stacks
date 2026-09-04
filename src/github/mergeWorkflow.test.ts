import { describe, expect, it, vi } from 'vitest';
import type { PendingPrCleanup } from '../types';
import { runPrMergeCleanupWorkflow } from './mergeWorkflow';

const operation: PendingPrCleanup = {
  repository: 'rich/app',
  pullRequestNumber: 42,
  pullRequestTitle: 'Feature',
  projectId: 'project',
  workspaceId: 'workspace',
  workspaceName: 'Feature',
  workspacePath: '/worktree',
  paneId: 'workspace:pi',
  stage: 'ready-to-merge',
};

describe('runPrMergeCleanupWorkflow', () => {
  it('persists the merged stage before cleanup', async () => {
    const order: string[] = [];
    const result = await runPrMergeCleanupWorkflow(
      operation,
      async () => { order.push('merge'); return true; },
      async (current) => { order.push('persist-merged'); return { ...current, stage: 'merged' }; },
      async (current) => { order.push(`cleanup-${current.stage}`); return true; },
    );
    expect(result).toEqual({ merged: true, cleanupCompleted: true });
    expect(order).toEqual(['merge', 'persist-merged', 'cleanup-merged']);
  });

  it('does not persist or clean up after a failed merge', async () => {
    const markMerged = vi.fn(async (current: PendingPrCleanup) => current);
    const cleanup = vi.fn(async () => true);
    await expect(runPrMergeCleanupWorkflow(operation, async () => false, markMerged, cleanup))
      .resolves.toEqual({ merged: false, cleanupCompleted: false });
    expect(markMerged).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });
});
