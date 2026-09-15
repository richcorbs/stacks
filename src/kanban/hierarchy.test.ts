import { describe, expect, it } from 'vitest';
import { candidateParents, childCountLabel, hierarchyStatusLabel } from './hierarchy';
import type { KanbanCard, KanbanStatus } from './types';

function card(id: string, projectId = 'p', status: KanbanStatus = 'needs_refinement'): KanbanCard {
  return { id, provider: 'local', external_id: id, title: `Card ${id}`, content: '', board_id: projectId, board_title: '', list_id: '', list_title: '', card_url: '', assignee_names: [], status, workflow_revision: 1, record_revision: 1, project_id: projectId, parent: null, child_count: 0, children: [], hierarchy_finalized: false, environment: null, created_at: 1, updated_at: 1, sort_order: 0, events: [], capabilities: [] };
}

describe('card hierarchy presentation', () => {
  it('offers only same-project top-level local cards without environments', () => {
    const child = card('child');
    const parent = card('parent');
    const nested = { ...card('nested'), parent: { id: 'x', external_id: 'x', title: 'X', status: 'ready' as const } };
    const remote = { ...card('remote'), provider: 'superthread' as const };
    expect(candidateParents([child, parent, nested, remote, card('other', 'q')], child).map(({ id }) => id)).toEqual(['parent']);
  });

  it('labels counts and complete aggregates', () => {
    expect(childCountLabel(1)).toBe('1 child');
    expect(childCountLabel(3)).toBe('3 children');
    const parent: KanbanCard = { ...card('parent', 'p', 'done'), hierarchy_finalized: true, child_count: 1,
      children: [{ id: 'c', external_id: '2', title: 'Child', status: 'done' }] };
    expect(hierarchyStatusLabel(parent)).toBe('Done · Children complete');
    parent.children[0].status = 'needs_refinement';
    parent.status = 'needs_refinement';
    expect(hierarchyStatusLabel(parent)).toBe('Needs refinement');
  });
});
