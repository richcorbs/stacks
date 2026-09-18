import type { WorkflowOperationResult } from './api';

export const APPROVE_AND_COMMIT_PROMPT = `Review the completed work and Git diff. Stage and commit only the intended changes, using a descriptive message. Do not discard or overwrite unexpected changes to clean the worktree. If the worktree is already clean, verify the work is committed; do not create an empty commit. Report anything that prevents committing the intended work.`;

export type ApproveAndCommitDependencies = {
  showAgent: () => void;
  sendPromptAndWait: (prompt: string) => Promise<boolean>;
  finalize: () => Promise<WorkflowOperationResult>;
  refresh: () => Promise<void>;
};

/** Runs the UI side of approval; the backend remains the authority on cleanliness and status. */
export async function runApproveAndCommit({ showAgent, sendPromptAndWait, finalize, refresh }: ApproveAndCommitDependencies) {
  showAgent();
  try {
    if (!await sendPromptAndWait(APPROVE_AND_COMMIT_PROMPT)) {
      throw new Error('Could not deliver the commit request to the card work agent, or the agent did not settle. The card was not approved.');
    }
    return await finalize();
  } finally {
    await refresh();
  }
}
