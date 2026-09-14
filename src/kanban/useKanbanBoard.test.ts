import { describe, expect, it } from 'vitest';
import { cardAgentSession, mergeChangedKanbanCard, shouldRestoreUiRequestCard } from './useKanbanBoard';
import type { KanbanCard } from './types';

function card(id: string, title: string): KanbanCard {
  return {
    id,
    provider: 'local',
    external_id: id,
    title,
    content: '',
    board_id: 'p1',
    board_title: 'Project',
    list_id: '',
    list_title: '',
    card_url: '',
    assignee_names: [],
    status: 'needs_refinement',
    workflow_revision: 1,
    project_id: 'p1',
    environment: null,
    created_at: 1,
    updated_at: 1,
    sort_order: 0,
    events: [],
  };
}

describe('card Pi workflow requests', () => {
  it('distinguishes work sessions from planning sessions', () => {
    expect(cardAgentSession('kanban-card:local:23:work')).toEqual({ cardId: 'local:23', thread: 'work' });
    expect(cardAgentSession('kanban-card:local:23:planning')).toEqual({ cardId: 'local:23', thread: 'planning' });
    expect(cardAgentSession('workspace:pi')).toBeNull();
  });

  it('restores only the exact automatic Needs you revision', () => {
    const blocked = { ...card('1', 'Blocked'), status: 'needs_human' as const, workflow_revision: 3 };
    expect(shouldRestoreUiRequestCard(blocked, blocked)).toBe(true);
    expect(shouldRestoreUiRequestCard({ ...blocked, status: 'approved' }, blocked)).toBe(false);
    expect(shouldRestoreUiRequestCard({ ...blocked, workflow_revision: 4 }, blocked)).toBe(false);
  });
});

describe('mergeChangedKanbanCard', () => {
  it('adds an externally created card to an already-open board', () => {
    const existing = card('1', 'Existing');
    const created = card('2', 'Created externally');
    expect(mergeChangedKanbanCard([existing], created)).toEqual([existing, created]);
  });

  it('replaces a matching card instead of duplicating it', () => {
    const changed = card('1', 'Updated');
    expect(mergeChangedKanbanCard([card('1', 'Old')], changed)).toEqual([changed]);
  });
});
