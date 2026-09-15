import { describe, expect, it } from 'vitest';
import { deriveCardWorkflowActions } from './workflowActions';
import type { KanbanCard, KanbanStatus } from './types';
import type { Project } from '../types';

function card(status: KanbanStatus, environment: KanbanCard['environment'] = null): KanbanCard {
  return { id: 'local:1', provider: 'local', external_id: '1', title: 'Card', content: '', board_id: '', board_title: '', list_id: '', list_title: '', card_url: '', assignee_names: [], status, workflow_revision: 1, project_id: 'p', parent: null, child_count: 0, children: [], hierarchy_finalized: false, environment, created_at: 1, updated_at: 1, sort_order: 0, events: [] };
}
const localProject = { id: 'p', name: 'P', path: '/repo', workspaces: [], delivery_workflow: 'local_merge', target_branch: 'main' } as Project;
const prProject = { ...localProject, delivery_workflow: 'github_pull_request', supports_feature_environments: true, require_passing_ci: true, require_approval: true } as Project;
const kinds = (status: KanbanStatus, project: Project = localProject) => deriveCardWorkflowActions({ card: card(status), project, projectAvailable: true }).map((action) => action.kind);

describe('delivery workflow actions', () => {
  it('suppresses every action for finalized aggregate parents', () => {
    expect(deriveCardWorkflowActions({ card: { ...card('ready'), hierarchy_finalized: true, child_count: 1 }, project: localProject, projectAvailable: true })).toEqual([]);
  });

  it('offers Close without delivery last on every active status and alone while the agent is working', () => {
    for (const status of ['needs_refinement', 'refining', 'needs_refinement_input', 'ready', 'agent_working', 'needs_human', 'approved'] as KanbanStatus[]) {
      const actions = deriveCardWorkflowActions({ card: card(status), project: localProject, projectAvailable: true });
      expect(actions.at(-1)).toMatchObject({ kind: 'close', label: 'Close without delivery' });
    }
    expect(kinds('refining')).toEqual(['stop_refinement', 'close']);
    expect(kinds('needs_refinement_input')).toEqual(['open_refinement', 'write_plan_and_finish_refinement', 'stop_refinement', 'close']);
    expect(kinds('agent_working')).toEqual(['close']);
    expect(kinds('done')).not.toContain('close');
  });

  it('offers write-and-finish while waiting for refinement input with project-assignment gating', () => {
    const available = deriveCardWorkflowActions({ card: card('needs_refinement_input'), project: localProject, projectAvailable: true });
    const unavailable = deriveCardWorkflowActions({ card: card('needs_refinement_input'), project: null, projectAvailable: false });

    expect(available.find((action) => action.kind === 'write_plan_and_finish_refinement')).toMatchObject({
      label: 'Write plan & finish refinement',
      disabledReason: undefined,
    });
    expect(unavailable.find((action) => action.kind === 'write_plan_and_finish_refinement')?.disabledReason).toBe('Assign a project first');
    expect(kinds('refining')).not.toContain('write_plan_and_finish_refinement');
  });

  it('assigns appearance independently from destructive confirmation semantics', () => {
    const draftActions = deriveCardWorkflowActions({ card: card('needs_refinement'), project: localProject, projectAvailable: true });
    const close = draftActions.find((action) => action.kind === 'close');
    const deleteAction = draftActions.find((action) => action.kind === 'delete');
    const environment = { id: 'e', card_id: 'local:1', project_id: 'p', worktree_path: '/source', branch: 'feature', repository_id: 'r', target_checkout_path: '/repo', target_branch: 'main', source_revision: 'a', target_revision: 'b', lifecycle_state: 'ready' as const, revision: 1, layout_revision: 1, split_layout: { kind: 'empty' as const }, focused_pane_id: null, panes: [], services: [] };
    const cleanup = deriveCardWorkflowActions({ card: card('done', environment), project: localProject, projectAvailable: true })[0];

    expect(close).toMatchObject({
      label: 'Close without delivery',
      destructive: true,
      appearance: 'neutral-ghost',
      confirmation: {
        title: 'Close without delivery?',
        detail: 'Moves this card to Done · Closed and stops its processes. The worktree, branch, and changes are preserved.',
      },
    });
    expect(deleteAction).toMatchObject({ destructive: true, appearance: 'danger-ghost', confirmation: { title: 'Delete card?' } });
    expect(cleanup).toMatchObject({ destructive: true, appearance: 'regular', confirmation: { title: 'Clean up environment?' } });
  });

  it('uses Ship It and conditionally offers feature environment delivery', () => {
    expect(kinds('needs_human')).toEqual(['request_changes', 'ship', 'close']);
    expect(kinds('needs_human', prProject)).toEqual(['request_changes', 'ship', 'ship_with_fe', 'close']);
    expect(deriveCardWorkflowActions({ card: card('needs_human'), project: prProject, projectAvailable: true })[1].label).toBe('Ship It');
  });

  it('allows an approved source to be shipped again before local merge', () => {
    expect(kinds('approved')).toEqual(['request_changes', 'ship', 'merge_local', 'close']);
    expect(deriveCardWorkflowActions({ card: card('approved'), project: localProject, projectAvailable: true })[1].label).toBe('Ship It again');
  });

  it('creates or merges a pull request based on persisted PR state', () => {
    expect(kinds('approved', prProject)).toEqual(['request_changes', 'ship', 'create_pr', 'close']);
    const ready = { ...card('approved'), pull_request: { repository: 'o/r', number: 1, title: 'PR', url: 'https://example.test', state: 'open' as const, draft: false, ci_status: 'success' as const, review_state: 'approved' as const, has_conflicts: false, mergeable: true, blockers: [] } };
    expect(deriveCardWorkflowActions({ card: ready, project: prProject, projectAvailable: true }).map((action) => action.kind)).toEqual(['request_changes', 'open_pr', 'merge_pr', 'close']);
  });

  it('blocks GitHub merge with every readiness reason', () => {
    const blocked = { ...card('approved'), pull_request: { repository: 'o/r', number: 1, title: 'PR', url: '', state: 'open' as const, draft: true, ci_status: 'pending' as const, review_state: 'changes_requested' as const, has_conflicts: true, mergeable: false, blockers: ['Draft', 'CI pending', 'Changes requested'] } };
    const action = deriveCardWorkflowActions({ card: blocked, project: prProject, projectAvailable: true }).find((candidate) => candidate.kind === 'merge_pr');
    expect(action?.disabledReason).toBe('Draft; CI pending; Changes requested');
  });

  it('only offers outcome-aware cleanup for Done cards with environments', () => {
    const environment = { id: 'e', card_id: 'local:1', project_id: 'p', worktree_path: '/source', branch: 'feature', repository_id: 'r', target_checkout_path: '/repo', target_branch: 'main', source_revision: 'a', target_revision: 'b', lifecycle_state: 'ready' as const, revision: 1, layout_revision: 1, split_layout: { kind: 'empty' as const }, focused_pane_id: null, panes: [], services: [] };
    expect(deriveCardWorkflowActions({ card: { ...card('done', environment), completion_outcome: 'closed' }, project: localProject, projectAvailable: true })[0].confirmation?.detail).toContain('branch is retained');
    expect(kinds('done')).toEqual([]);
  });
});
