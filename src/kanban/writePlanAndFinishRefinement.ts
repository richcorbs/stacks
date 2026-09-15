import type { KanbanCard } from './types';

export const WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT = `Review the card description and inspect the repository as needed. Write a complete, self-contained implementation plan that another agent can execute without this conversation. Include the desired outcome, acceptance criteria, technical approach, risks or open questions, and validation plan. When a breakdown would materially improve execution, propose self-contained, independently deployable child cards; do not split work unnecessarily. Include every existing linked draft child in any proposed breakdown. Use finish_refinement only after explicit approval so the final brief and any approved children are persisted atomically. If no breakdown is approved, finish the single card normally.`;

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
