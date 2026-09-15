import { describe, expect, it, vi } from 'vitest';
import type { KanbanCard, KanbanStatus } from './types';
import {
  runWritePlanAndFinishRefinement,
  WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT,
} from './writePlanAndFinishRefinement';

function card(status: KanbanStatus): KanbanCard {
  return { id: 'local:1', provider: 'local', external_id: '1', title: 'Card', content: 'Plan', board_id: '', board_title: '', list_id: '', list_title: '', card_url: '', assignee_names: [], status, workflow_revision: 2, project_id: 'p', parent: null, child_count: 0, children: [], hierarchy_finalized: false, environment: null, created_at: 1, updated_at: 2, sort_order: 0, events: [] };
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
    expect(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT).toContain('complete, self-contained implementation plan');
    expect(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT).toContain('self-contained, independently deployable child cards');
    expect(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT).toContain('do not split work unnecessarily');
    expect(WRITE_PLAN_AND_FINISH_REFINEMENT_PROMPT).toContain('only after explicit approval');
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
