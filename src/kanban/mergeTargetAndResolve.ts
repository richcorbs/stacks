import type { TargetMergePrepareResult, WorkflowOperationResult } from './api';

export function resolvePrimaryTargetMergePrompt(path: string) {
  return `An explicit reconciliation merge is already in progress in the primary target checkout at ${path}. Work in that exact checkout, inspect the existing merge, and resolve every conflict. Stage all resolutions and finish the existing merge commit. Do not abort, rebase, squash, cherry-pick, start a different merge, push, or make unrelated changes. If any conflict cannot be resolved confidently, leave the merge in progress and report the blocker.`;
}

export function resolveCardWorktreeMergePrompt(path: string) {
  return `The synchronized and successfully pushed target revision is already being merged into the card worktree at ${path}, and that existing merge has conflicts. Work in that exact card worktree, resolve every conflict, stage all resolutions, and finish the existing merge commit. Do not modify the primary target checkout, abort, rebase, squash, cherry-pick, start a different merge, push, or make unrelated changes. If any conflict cannot be resolved confidently, leave the merge in progress and report the blocker.`;
}

export type MergeTargetDependencies = {
  prepare: () => Promise<TargetMergePrepareResult>;
  showAgent: () => void;
  sendPromptAndWait: (prompt: string) => Promise<boolean>;
  finalize: (operationId: string) => Promise<WorkflowOperationResult>;
  abort: (operationId: string) => Promise<unknown>;
  refresh: () => Promise<void>;
};

/** Coordinates agent assistance while the resumable backend owns Git and push safety. */
export async function runMergeTargetAndResolve(dependencies: MergeTargetDependencies) {
  let operationId: string | null = null;
  try {
    for (let resumes = 0; resumes < 4; resumes += 1) {
      const prepared = await dependencies.prepare();
      operationId = prepared.operation_id ?? operationId;
      if (prepared.state === 'noop') return prepared;
      if (!operationId) throw new Error('Stacks did not record the target synchronization operation.');
      if (prepared.state === 'source_merged') return await dependencies.finalize(operationId);
      if (prepared.state !== 'target_conflicted' && prepared.state !== 'source_conflicted') {
        throw new Error(`Stacks stopped at unexpected target synchronization phase: ${prepared.state}`);
      }
      if (!prepared.checkout_path) throw new Error('Stacks did not report the checkout containing the conflicted merge.');
      dependencies.showAgent();
      const prompt = prepared.state === 'target_conflicted'
        ? resolvePrimaryTargetMergePrompt(prepared.checkout_path)
        : resolveCardWorktreeMergePrompt(prepared.checkout_path);
      if (!await dependencies.sendPromptAndWait(prompt)) {
        // Prompt delivery/settling failed before backend verification. A
        // stage-aware abort is the only automatic recovery attempted here.
        await dependencies.abort(operationId);
        operationId = null;
        throw new Error('Could not deliver the conflict-resolution request, or the work agent did not settle. The current stage was safely recovered when possible; an already pushed target was not rolled back.');
      }
    }
    throw new Error('Target synchronization required too many conflict-resolution cycles; retry to resume it.');
  } finally {
    await dependencies.refresh();
  }
}
