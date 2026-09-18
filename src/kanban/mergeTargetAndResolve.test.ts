import { describe, expect, it, vi } from 'vitest';
import { RESOLVE_TARGET_MERGE_PROMPT, runMergeTargetAndResolve } from './mergeTargetAndResolve';
import type { TargetMergePrepareResult, WorkflowOperationResult } from './api';

const card = { status: 'needs_human' } as WorkflowOperationResult['card'];
const completed = { card, message: 'merged', idempotent: false };
const prepared = (state: TargetMergePrepareResult['state'], operation_id: string | null = state === 'noop' ? null : 'op-1'): TargetMergePrepareResult => ({ card, message: state, idempotent: state === 'noop', state, operation_id });

function dependencies(result: TargetMergePrepareResult) {
  return {
    prepare: vi.fn().mockResolvedValue(result),
    showAgent: vi.fn(),
    sendPromptAndWait: vi.fn().mockResolvedValue(true),
    finalize: vi.fn().mockResolvedValue(completed),
    abort: vi.fn().mockResolvedValue(card),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

describe('merge target and resolve orchestration', () => {
  it('limits conflict resolution to safely completing the existing merge', () => {
    expect(RESOLVE_TARGET_MERGE_PROMPT).toContain('merge of the target branch is already in progress');
    expect(RESOLVE_TARGET_MERGE_PROMPT).toContain('Stage all resolutions and finish the existing merge commit');
    expect(RESOLVE_TARGET_MERGE_PROMPT).toContain('Do not abort, rebase, squash, cherry-pick, start a different merge, or make unrelated changes');
    expect(RESOLVE_TARGET_MERGE_PROMPT).toContain('cannot be resolved confidently, leave the merge in progress and report the blocker');
  });

  it('finalizes a clean merge without prompting the agent', async () => {
    const deps = dependencies(prepared('merged'));
    await expect(runMergeTargetAndResolve(deps)).resolves.toEqual(completed);
    expect(deps.sendPromptAndWait).not.toHaveBeenCalled();
    expect(deps.finalize).toHaveBeenCalledWith('op-1');
    expect(deps.refresh).toHaveBeenCalledOnce();
  });

  it('prompts narrowly for conflicts, then finalizes', async () => {
    const deps = dependencies(prepared('conflicted'));
    await runMergeTargetAndResolve(deps);
    expect(deps.showAgent).toHaveBeenCalledOnce();
    expect(deps.sendPromptAndWait).toHaveBeenCalledWith(RESOLVE_TARGET_MERGE_PROMPT);
    expect(deps.finalize).toHaveBeenCalledWith('op-1');
    expect(deps.abort).not.toHaveBeenCalled();
  });

  it('returns a no-op without agent, finalize, or abort', async () => {
    const deps = dependencies(prepared('noop'));
    await expect(runMergeTargetAndResolve(deps)).resolves.toMatchObject({ state: 'noop', idempotent: true });
    expect(deps.showAgent).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
    expect(deps.abort).not.toHaveBeenCalled();
  });

  it.each(['prompt delivery', 'finalization'])('aborts and refreshes after %s failure', async (stage) => {
    const deps = dependencies(prepared('conflicted'));
    if (stage === 'prompt delivery') deps.sendPromptAndWait.mockResolvedValue(false);
    else deps.finalize.mockRejectedValue(new Error('verification failed'));
    await expect(runMergeTargetAndResolve(deps)).rejects.toThrow();
    expect(deps.abort).toHaveBeenCalledWith('op-1');
    expect(deps.refresh).toHaveBeenCalledOnce();
  });

  it('surfaces manual recovery guidance when conservative abort refuses', async () => {
    const deps = dependencies(prepared('conflicted'));
    deps.sendPromptAndWait.mockResolvedValue(false);
    deps.abort.mockRejectedValue(new Error('recover manually'));
    await expect(runMergeTargetAndResolve(deps)).rejects.toThrow('Recovery also stopped: recover manually');
  });
});
