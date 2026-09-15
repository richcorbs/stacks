import type { TargetMergePrepareResult, WorkflowOperationResult } from './api';

export const RESOLVE_TARGET_MERGE_PROMPT = `An explicit merge of the target branch is already in progress in this card worktree and has conflicts. Inspect the existing merge and resolve every conflict. Stage all resolutions and finish the existing merge commit. Do not abort, rebase, squash, cherry-pick, start a different merge, or make unrelated changes. If any conflict cannot be resolved confidently, leave the merge in progress and report the blocker.`;

export type MergeTargetDependencies = {
  prepare: () => Promise<TargetMergePrepareResult>;
  showAgent: () => void;
  sendPromptAndWait: (prompt: string) => Promise<boolean>;
  finalize: (operationId: string) => Promise<WorkflowOperationResult>;
  abort: (operationId: string) => Promise<unknown>;
  refresh: () => Promise<void>;
};

/** Coordinates agent assistance while backend prepare/finalize/abort own Git safety. */
export async function runMergeTargetAndResolve(dependencies: MergeTargetDependencies) {
  let operationId: string | null = null;
  try {
    const prepared = await dependencies.prepare();
    operationId = prepared.operation_id;
    if (prepared.state === 'noop') return prepared;
    if (!operationId) throw new Error('Stacks did not record the target merge operation. The source was not finalized.');
    if (prepared.state === 'conflicted') {
      dependencies.showAgent();
      if (!await dependencies.sendPromptAndWait(RESOLVE_TARGET_MERGE_PROMPT)) {
        throw new Error('Could not deliver the conflict-resolution request, or the work agent did not settle.');
      }
    }
    return await dependencies.finalize(operationId);
  } catch (error) {
    if (operationId) {
      try {
        await dependencies.abort(operationId);
      } catch (recoveryError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)} Recovery also stopped: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
      }
    }
    throw error;
  } finally {
    await dependencies.refresh();
  }
}
