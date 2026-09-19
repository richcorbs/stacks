import { describe, expect, it } from 'vitest';
import { adjacentKanbanStatus, KANBAN_LANES, reorderKanbanCardIds } from './workflow';

describe('Kanban workflow', () => {
  it('orders refinement ownership before the execution lifecycle', () => {
    expect(KANBAN_LANES.map(({ status, label }) => [status, label])).toEqual([
      ['needs_refinement', 'Needs refinement'],
      ['refining', 'Refining'],
      ['needs_refinement_input', 'Needs you for refinement'],
      ['ready', 'Ready for agent'],
      ['agent_working', 'Agent working'],
      ['needs_human', 'Needs you'],
      ['approved', 'Ready to merge'],
      ['done', 'Done'],
    ]);
  });

  it('moves through the local workflow in order', () => {
    expect(adjacentKanbanStatus('needs_refinement', 1)).toBe('refining');
    expect(adjacentKanbanStatus('refining', 1)).toBe('needs_refinement_input');
    expect(adjacentKanbanStatus('needs_refinement_input', 1)).toBe('ready');
    expect(adjacentKanbanStatus('needs_human', -1)).toBe('agent_working');
    expect(adjacentKanbanStatus('done', 1)).toBeNull();
  });

  it('reorders cards without changing their column membership', () => {
    expect(reorderKanbanCardIds(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(reorderKanbanCardIds(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a']);
  });
});
