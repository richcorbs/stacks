import type { KanbanCard } from './types';

export const WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT = `The user's click on Write plan & finish refinement is explicit approval and an instruction to finalize refinement now, in this turn. Do not ask for confirmation or merely present the plan for approval. Review the card description and inspect the repository as needed, then write a complete, self-contained final implementation brief that another agent can execute without this conversation. Include the desired outcome, acceptance criteria, technical approach, risks or open questions, and validation plan. Use the appropriate card-management tools available in your context to prepare and persist the final brief and call finish_refinement in this same turn, following their documented sequencing: when finish_refinement persists the brief atomically, pass the complete brief directly to it; when finish_refinement only changes refinement status, first save the complete brief through the source provider and call finish_refinement only after that save succeeds. Finalize a child breakdown only if the user previously explicitly approved it. Do not introduce, propose, create, or include unapproved new child cards as part of this action. If no child breakdown was previously approved, finish the card without adding children. For a previously approved breakdown, preserve every existing linked draft child and pass the complete approved breakdown to the appropriate tool.`;

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
