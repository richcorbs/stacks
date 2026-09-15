import { describe, expect, it } from 'vitest';
import type { KanbanCard } from './types';
import { cardChatPrompt, cardPaneId, cardTerminalId, cardWorkspaceId } from './cardWorkspace';

function card(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: 'local:74', provider: 'local', external_id: '74', title: 'Split the monolith', content: 'Keep behavior stable.',
    board_id: 'p', board_title: '', list_id: '', list_title: '', card_url: '', assignee_names: [], status: 'agent_working',
    workflow_revision: 1, record_revision: 1, project_id: 'p', parent: null, child_count: 0, children: [], hierarchy_finalized: false,
    environment: null, created_at: 1, updated_at: 1, sort_order: 0, events: [], ...overrides,
  };
}

describe('card workspace contracts', () => {
  it('keeps owner, agent, and terminal ids stable', () => {
    expect(cardWorkspaceId('local:74')).toBe('kanban-card:local:74');
    expect(cardPaneId('local:74', 'planning')).toBe('kanban-card:local:74:planning');
    expect(cardTerminalId('local:74', 'shell')).toBe('kanban-card:local:74:terminal:shell');
  });

  it('builds distinct planning and implementation prompts', () => {
    expect(cardChatPrompt(card(), 'planning')).toContain('Do not implement or modify files');
    expect(cardChatPrompt(card(), 'planning')).toContain('update_card_description');
    expect(cardChatPrompt(card(), 'work')).toContain('You are running in the dedicated worktree and branch');
    expect(cardChatPrompt(card(), 'work')).toContain('Description:\nKeep behavior stable.');
  });
});
