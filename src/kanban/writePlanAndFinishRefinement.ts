import type { KanbanCard } from './types';

export const WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT = `Review the card description and inspect the repository as needed. Write a complete, self-contained implementation plan that another agent can execute without this conversation. Include the desired outcome, acceptance criteria, technical approach, risks or open questions, and validation plan. Use the card-management tools available in your context to replace the card description with that plan. Only after the description update succeeds, use the available card-management tool to finish refinement. If updating the description fails, do not finish refinement; report the failure instead.`;

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
