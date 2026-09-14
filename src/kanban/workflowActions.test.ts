import { describe, expect, it } from 'vitest';
import { deriveCardWorkflowActions } from './workflowActions';
import type { KanbanCard, KanbanStatus } from './types';

function card(status: KanbanStatus, environment: KanbanCard['environment'] = null): KanbanCard {
  return { id: 'local:1', provider: 'local', external_id: '1', title: 'Card', content: '', board_id: '', board_title: '', list_id: '', list_title: '', card_url: '', assignee_names: [], status, workflow_revision: 1, project_id: 'p', environment, created_at: 1, updated_at: 1, sort_order: 0, events: [] };
}

it.each([
  ['needs_refinement', ['open_refinement', 'finish_refinement', 'delete']],
  ['ready', ['return_to_refinement', 'start_work']],
  ['agent_working', ['open_agent']],
  ['needs_human', ['request_changes', 'approve']],
] as const)('derives %s actions', (status, kinds) => {
  expect(deriveCardWorkflowActions({ card: card(status), projectAvailable: true }).map((action) => action.kind)).toEqual(kinds);
});

describe('merge and reopen actions', () => {
  it('requires explicit target metadata for a legacy environment', () => {
    const environment = { id: 'e', card_id: 'local:1', project_id: 'p', worktree_path: '/source', branch: 'feature', repository_id: null, target_checkout_path: null, target_branch: null, source_revision: null, target_revision: null, lifecycle_state: 'ready' as const, revision: 1, split_layout: { kind: 'empty' as const }, focused_pane_id: null, panes: [], services: [] };
    expect(deriveCardWorkflowActions({ card: card('approved', environment), projectAvailable: true })[1].kind).toBe('set_merge_target');
    expect(deriveCardWorkflowActions({ card: card('merged', environment), projectAvailable: true }).map((action) => action.kind)).toEqual(['reopen', 'cleanup']);
  });
  it('keeps workflow actions stable on every tab', () => {
    const tabs = ['overview', 'chat', 'diff', 'terminal', 'server', 'console'] as const;
    expect(tabs.map((activeTab) => deriveCardWorkflowActions({ card: card('needs_human'), projectAvailable: true, activeTab }).map((action) => action.kind)))
      .toEqual(tabs.map(() => ['request_changes', 'approve']));
  });
  it('hides Open refinement on the Agent tab only', () => {
    const tabs = ['overview', 'chat', 'diff', 'terminal', 'server', 'console'] as const;
    expect(tabs.map((activeTab) => deriveCardWorkflowActions({ card: card('needs_refinement'), projectAvailable: true, activeTab }).map((action) => action.kind)))
      .toEqual([
        ['open_refinement', 'finish_refinement', 'delete'],
        ['finish_refinement', 'delete'],
        ['open_refinement', 'finish_refinement', 'delete'],
        ['open_refinement', 'finish_refinement', 'delete'],
        ['open_refinement', 'finish_refinement', 'delete'],
        ['open_refinement', 'finish_refinement', 'delete'],
      ]);
  });
  it('never offers deletion for provider cards', () => {
    const providerCard = { ...card('needs_refinement'), provider: 'superthread' as const };
    expect(deriveCardWorkflowActions({ card: providerCard, projectAvailable: true }).some((action) => action.kind === 'delete')).toBe(false);
  });
  it('explains that cleaned merged cards need a new environment', () => {
    expect(deriveCardWorkflowActions({ card: card('merged'), projectAvailable: true })[0].label).toContain('Ready for agent');
  });
});
