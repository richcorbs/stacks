import { describe, expect, it, vi } from 'vitest';
import type { KanbanCard, KanbanStatus } from './types';
import {
  runWritePlanAndFinishRefinement,
  WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT,
} from './writePlanAndFinishRefinement';

function card(status: KanbanStatus): KanbanCard {
  return { id: 'local:1', provider: 'local', external_id: '1', title: 'Card', content: 'Plan', board_id: '', board_title: '', list_id: '', list_title: '', card_url: '', assignee_names: [], status, workflow_revision: 2, record_revision: 1, project_id: 'p', parent: null, child_count: 0, children: [], hierarchy_finalized: false, environment: null, created_at: 1, updated_at: 2, sort_order: 0, events: [], capabilities: [] };
}

describe('write plan and finish refinement workflow', () => {
  it('opens Agent, sends the provider-neutral sequencing prompt, refreshes, and verifies Ready', async () => {
    const calls: string[] = [];
    const updated = card('ready');
    const result = await runWritePlanAndFinishRefinement({
      showAgent: () => calls.push('agent'),
      sendPromptAndWait: async (prompt) => {
        calls.push('prompt');
        expect(prompt).toBe(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT);
        return true;
      },
      refresh: async () => { calls.push('refresh'); return updated; },
    });

    expect(result).toBe(updated);
    expect(calls).toEqual(['agent', 'prompt', 'refresh']);
    expect(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT).toContain("user's click on Write plan & finish refinement is explicit approval");
    expect(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT).toContain('finalize refinement now, in this turn');
    expect(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT).toContain('Do not ask for confirmation or merely present the plan for approval');
    expect(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT).toContain('complete, self-contained final implementation brief');
    expect(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT).toContain('prepare and persist the final brief and call finish_refinement in this same turn');
    expect(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT).toContain('when finish_refinement persists the brief atomically');
    expect(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT).toContain('first save the complete brief through the source provider');
    expect(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT).not.toContain('update_card_description');
  });

  it('finalizes only a previously approved breakdown and otherwise adds no children', () => {
    expect(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT).toContain('only if the user previously explicitly approved it');
    expect(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT).toContain('Do not introduce, propose, create, or include unapproved new child cards');
    expect(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT).toContain('finish the card without adding children');
    expect(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT).toContain('preserve every existing linked draft child');
  });

  it('refreshes and reports prompt delivery or execution failure without another transition', async () => {
    const refresh = vi.fn().mockResolvedValue(card('needs_refinement'));
    await expect(runWritePlanAndFinishRefinement({
      showAgent: vi.fn(),
      sendPromptAndWait: vi.fn().mockResolvedValue(false),
      refresh,
    })).rejects.toThrow('card remains in refinement');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('surfaces thrown execution failures after refreshing', async () => {
    const refresh = vi.fn().mockResolvedValue(card('needs_refinement'));
    await expect(runWritePlanAndFinishRefinement({
      showAgent: vi.fn(),
      sendPromptAndWait: vi.fn().mockRejectedValue(new Error('agent unavailable')),
      refresh,
    })).rejects.toThrow('agent unavailable');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('rejects when the refreshed card still needs refinement', async () => {
    await expect(runWritePlanAndFinishRefinement({
      showAgent: vi.fn(),
      sendPromptAndWait: vi.fn().mockResolvedValue(true),
      refresh: vi.fn().mockResolvedValue(card('needs_refinement')),
    })).rejects.toThrow('refreshed card still needs refinement');
  });
});
