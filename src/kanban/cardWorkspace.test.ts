import { describe, expect, it } from 'vitest';
import type { KanbanCard } from './types';
import { cardChatPrompt, cardPaneId, cardTerminalId, cardWorkspaceId } from './cardWorkspace';

function card(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: 'local:74', provider: 'local', external_id: '74', title: 'Split the monolith', content: 'Keep behavior stable.',
    board_id: 'p', board_title: '', list_id: '', list_title: '', card_url: '', assignee_names: [], status: 'agent_working',
    workflow_revision: 1, record_revision: 1, project_id: 'p', parent: null, child_count: 0, children: [], hierarchy_finalized: false,
    environment: null, created_at: 1, updated_at: 1, sort_order: 0, events: [], ...overrides, capabilities: overrides.capabilities ?? [],
  };
}

describe('card workspace contracts', () => {
  it('keeps owner, agent, and terminal ids stable', () => {
    expect(cardWorkspaceId('local:74')).toBe('kanban-card:local:74');
    expect(cardPaneId('local:74', 'planning')).toBe('kanban-card:local:74:planning');
    expect(cardTerminalId('local:74', 'shell')).toBe('kanban-card:local:74:terminal:shell');
  });

  it('keeps planning read-only and approval-gated while requesting a self-contained brief', () => {
    const prompt = cardChatPrompt(card(), 'planning');
    expect(prompt).toContain('planning conversation for local card #74: Split the monolith');
    expect(prompt).toContain('Do not implement or modify files');
    expect(prompt).toContain('ask focused questions one at a time');
    expect(prompt).toContain('concise, self-contained brief');
    expect(prompt).toContain('desired outcome, acceptance criteria, technical approach, risks or open questions, and validation plan');
    expect(prompt).toContain('Do not finish refinement until I explicitly approve');
    expect(prompt).toContain('Description:\nKeep behavior stable.');
  });

  it('preserves local breakdown guidance and existing-child context without repeating tool contracts', () => {
    const prompt = cardChatPrompt(card({
      children: [{ id: 'local:75', external_id: '75', title: 'Extract service', status: 'needs_refinement' }],
      child_count: 1,
    }), 'planning');
    expect(prompt).toContain('self-contained, independently deployable child cards');
    expect(prompt).toContain('preserve every one in an approved breakdown');
    expect(prompt).toContain('local:75 (#75 Extract service, Needs refinement)');
    expect(prompt).not.toContain('update_card_description');
    expect(prompt).not.toContain('start_work');
    expect(prompt).not.toContain('call finish_refinement');
  });

  it('preserves provider-specific card identity', () => {
    const prompt = cardChatPrompt(card({ id: 'superthread:abc', provider: 'superthread', external_id: 'ST-9' }), 'planning');
    expect(prompt).toContain('Superthread card #ST-9: Split the monolith');
    expect(prompt).not.toContain('independently deployable child cards');
  });

  it('keeps the work kickoff scoped to implementation in the dedicated worktree', () => {
    const prompt = cardChatPrompt(card(), 'work');
    expect(prompt).toContain('Implement local card #74: Split the monolith');
    expect(prompt).toContain('dedicated worktree and branch');
    expect(prompt).toContain('make the required changes');
    expect(prompt).toContain('validate them');
    expect(prompt).toContain('report relevant progress or decisions');
    expect(prompt).toContain('Ask when human input is required');
    expect(prompt).toContain('Description:\nKeep behavior stable.');
  });
});
