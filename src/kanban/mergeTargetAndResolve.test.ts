import { describe, expect, it, vi } from 'vitest';
import { resolveCardWorktreeMergePrompt, resolvePrimaryTargetMergePrompt, runMergeTargetAndResolve } from './mergeTargetAndResolve';
import type { TargetMergePrepareResult, WorkflowOperationResult } from './api';

const card = { status: 'needs_human' } as WorkflowOperationResult['card'];
const completed = { card, message: 'merged', idempotent: false };
const prepared = (state: TargetMergePrepareResult['state'], path: string | null = null, operation_id: string | null = state === 'noop' ? null : 'op-1'): TargetMergePrepareResult => ({ card, message: state, idempotent: state === 'noop', state, operation_id, checkout_path: path });

function dependencies(...results: TargetMergePrepareResult[]) {
  return {
    prepare: vi.fn().mockImplementation(() => Promise.resolve(results.shift())),
    showAgent: vi.fn(),
    sendPromptAndWait: vi.fn().mockResolvedValue(true),
    finalize: vi.fn().mockResolvedValue(completed),
    abort: vi.fn().mockResolvedValue(card),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

describe('merge target and resolve orchestration', () => {
  it('distinguishes primary-target and card-worktree instructions and includes exact paths', () => {
    const target = resolvePrimaryTargetMergePrompt('/repo/primary');
    expect(target).toContain('primary target checkout at /repo/primary');
    expect(target).toContain('Do not abort, rebase, squash');
    expect(target).toContain('push');
    const source = resolveCardWorktreeMergePrompt('/repo/card');
    expect(source).toContain('card worktree at /repo/card');
    expect(source).toContain('successfully pushed target revision');
    expect(source).toContain('Do not modify the primary target checkout');
  });

  it('finalizes a completed card-worktree merge without prompting', async () => {
    const deps = dependencies(prepared('source_merged'));
    await expect(runMergeTargetAndResolve(deps)).resolves.toEqual(completed);
    expect(deps.sendPromptAndWait).not.toHaveBeenCalled();
    expect(deps.finalize).toHaveBeenCalledWith('op-1');
    expect(deps.refresh).toHaveBeenCalledOnce();
  });

  it('resumes through both conflict stages before finalizing', async () => {
    const deps = dependencies(
      prepared('target_conflicted', '/repo/primary'),
      prepared('source_conflicted', '/repo/card'),
      prepared('source_merged'),
    );
    await runMergeTargetAndResolve(deps);
    expect(deps.prepare).toHaveBeenCalledTimes(3);
    expect(deps.sendPromptAndWait).toHaveBeenNthCalledWith(1, resolvePrimaryTargetMergePrompt('/repo/primary'));
    expect(deps.sendPromptAndWait).toHaveBeenNthCalledWith(2, resolveCardWorktreeMergePrompt('/repo/card'));
    expect(deps.finalize).toHaveBeenCalledWith('op-1');
    expect(deps.abort).not.toHaveBeenCalled();
  });

  it('returns a no-op without agent, finalize, or abort', async () => {
    const deps = dependencies(prepared('noop'));
    await expect(runMergeTargetAndResolve(deps)).resolves.toMatchObject({ state: 'noop', idempotent: true });
    expect(deps.finalize).not.toHaveBeenCalled();
    expect(deps.abort).not.toHaveBeenCalled();
  });

  it('uses stage-aware abort when an agent request does not settle', async () => {
    const deps = dependencies(prepared('target_conflicted', '/repo/primary'));
    deps.sendPromptAndWait.mockResolvedValue(false);
    await expect(runMergeTargetAndResolve(deps)).rejects.toThrow('safely recovered');
    expect(deps.abort).toHaveBeenCalledWith('op-1');
    expect(deps.refresh).toHaveBeenCalledOnce();
  });

  it('preserves durable backend state after a prepare or finalize failure', async () => {
    const deps = dependencies(prepared('source_merged'));
    deps.finalize.mockRejectedValue(new Error('verification failed'));
    await expect(runMergeTargetAndResolve(deps)).rejects.toThrow('verification failed');
    expect(deps.abort).not.toHaveBeenCalled();
  });
});
