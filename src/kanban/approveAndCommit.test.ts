import { describe, expect, it, vi } from 'vitest';
import { APPROVE_AND_COMMIT_PROMPT, runApproveAndCommit } from './approveAndCommit';
import type { WorkflowOperationResult } from './api';

const result = { message: 'Ready to merge' } as WorkflowOperationResult;

describe('approve and commit workflow', () => {
  it('opens Agent, asks the existing agent to commit, finalizes, and refreshes', async () => {
    const calls: string[] = [];
    const completed = await runApproveAndCommit({
      showAgent: () => calls.push('agent'),
      sendPromptAndWait: async (prompt) => { calls.push('prompt'); expect(prompt).toBe(APPROVE_AND_COMMIT_PROMPT); return true; },
      finalize: async () => { calls.push('finalize'); return result; },
      refresh: async () => { calls.push('refresh'); },
    });
    expect(completed).toBe(result);
    expect(calls).toEqual(['agent', 'prompt', 'finalize', 'refresh']);
    expect(APPROVE_AND_COMMIT_PROMPT).toContain('stage only those intended changes');
    expect(APPROVE_AND_COMMIT_PROMPT).toContain('do not create an empty commit');
  });

  it('does not finalize when prompt delivery or the agent fails, but still refreshes', async () => {
    const finalize = vi.fn();
    const refresh = vi.fn().mockResolvedValue(undefined);
    await expect(runApproveAndCommit({
      showAgent: vi.fn(),
      sendPromptAndWait: vi.fn().mockResolvedValue(false),
      finalize,
      refresh,
    })).rejects.toThrow('card was not approved');
    expect(finalize).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('surfaces verification failures and refreshes dirty state', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    await expect(runApproveAndCommit({
      showAgent: vi.fn(),
      sendPromptAndWait: vi.fn().mockResolvedValue(true),
      finalize: vi.fn().mockRejectedValue(new Error('1 new, 2 modified, 3 deleted files remain')),
      refresh,
    })).rejects.toThrow('1 new, 2 modified, 3 deleted files remain');
    expect(refresh).toHaveBeenCalledOnce();
  });
});
