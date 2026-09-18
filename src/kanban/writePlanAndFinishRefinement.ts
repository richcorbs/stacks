import type { KanbanCard } from './types';

export const WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT = `The user's click on Write plan & finish refinement explicitly approves and instructs you to finish refinement in this turn. Do not ask for confirmation or merely present a plan. Review the card and repository as needed, then produce a complete, self-contained implementation brief covering the desired outcome, acceptance criteria, technical approach, risks or open questions, and validation plan. Use the available card tools to persist the brief and finish refinement now: save it before the transition or atomically with it, as the available tool contract requires. Do not introduce an unapproved child breakdown. If a breakdown was previously approved, preserve every existing linked child when finalizing it; otherwise add no children.`;

export type WritePlanAndFinishRefinementDependencies = {
  showAgent: () => void;
  sendPromptAndWait: (prompt: string) => Promise<boolean>;
  refresh: () => Promise<KanbanCard>;
};

/** Lets the planning agent own both the description update and status transition. */
export async function runWritePlanAndFinishRefinement({
  showAgent,
  sendPromptAndWait,
  refresh,
}: WritePlanAndFinishRefinementDependencies) {
  showAgent();

  let delivered = false;
  let executionError: unknown;
  try {
    delivered = await sendPromptAndWait(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT);
  } catch (error) {
    executionError = error;
  }

  const updated = await refresh();
  if (executionError) throw executionError;
  if (!delivered) {
    throw new Error('Could not deliver the plan request to the planning agent, or the agent did not settle. The card remains in refinement; retry when the agent is available.');
  }
  if (updated.status !== 'ready') {
    throw new Error('The planning agent settled, but the refreshed card still needs refinement. Check the Agent tab for details, then retry.');
  }
  return updated;
}
