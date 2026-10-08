import { describe, expect, it } from 'vitest';
import type { KanbanStatus } from './types';
import { BOARD_GROUPS, WORK_GROUPS, groupCards, validateWorkGroups, workGroup } from './workflowGroups';

describe('work groups', () => {
  it('projects every canonical workflow status into exactly one of four groups', () => {
    expect(WORK_GROUPS.map((group) => group.id)).toEqual(['attention', 'progress', 'backlog', 'done']);
    expect(BOARD_GROUPS.map((group) => group.id)).toEqual(['backlog', 'progress', 'attention', 'done']);
    expect(validateWorkGroups()).toBe(true);
    expect(workGroup('needs_refinement_input')).toBe('attention');
    expect(workGroup('ready')).toBe('attention');
    expect(workGroup('needs_human')).toBe('attention');
    expect(workGroup('approved')).toBe('attention');
    expect(workGroup('refining')).toBe('progress');
    expect(workGroup('agent_working')).toBe('progress');
    expect(workGroup('needs_refinement')).toBe('backlog');
    expect(workGroup('done')).toBe('done');
  });

  it('retains status-specific order inside a group without changing card status', () => {
    const cards: { id: string; status: KanbanStatus }[] = [
      { id: 'review', status: 'needs_human' },
      { id: 'start', status: 'ready' },
      { id: 'other-review', status: 'needs_human' },
    ];
    expect(groupCards(cards, WORK_GROUPS[0]).map((card) => card.id)).toEqual(['start', 'review', 'other-review']);
    expect(cards.map((card) => card.status)).toEqual(['needs_human', 'ready', 'needs_human']);
  });
});
