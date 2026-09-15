import { describe, expect, it } from 'vitest';
import { deriveCardWorkflowActions } from './workflowActions';
import type { KanbanCard, KanbanCapability, KanbanStatus } from './types';
import type { Project } from '../types';

function card(status: KanbanStatus, capabilities: KanbanCapability[], environment: KanbanCard['environment'] = null): KanbanCard {
  return { id: 'local:1', provider: 'local', external_id: '1', title: 'Card', content: '', board_id: '', board_title: '', list_id: '', list_title: '', card_url: '', assignee_names: [], status, workflow_revision: 1, record_revision: 1, project_id: 'p', parent: null, child_count: 0, children: [], hierarchy_finalized: false, environment, created_at: 1, updated_at: 1, sort_order: 0, events: [], capabilities };
}
const project = { id: 'p', name: 'P', path: '/repo', delivery_workflow: 'local_merge', target_branch: 'main' } as Project;
const capability = (action: KanbanCapability['action'], available = true, disabled_reason?: string): KanbanCapability => ({ action, available, disabled_reason });

const environment = { id: 'e', card_id: 'local:1', project_id: 'p', worktree_path: '/source', branch: 'feature', repository_id: 'r', target_checkout_path: '/repo', target_branch: 'main', source_revision: 'a', target_revision: 'b', lifecycle_state: 'ready' as const, revision: 1, layout_revision: 1, split_layout: { kind: 'empty' as const }, focused_pane_id: null, panes: [], services: [] };

describe('workflow action presentation', () => {
  it('preserves backend ordering and availability reasons', () => {
    const actions = deriveCardWorkflowActions({ card: card('needs_human', [capability('request_changes'), capability('ship', false, 'Environment missing'), capability('merge_target'), capability('close')]), project });
    expect(actions.map(({ kind }) => kind)).toEqual(['request_changes', 'ship', 'merge_target', 'close']);
    expect(actions[1]).toMatchObject({ label: 'Ship It', disabledReason: 'Environment missing', primary: true });
  });

  it('adds presentation-only confirmation and appearance', () => {
    const [close] = deriveCardWorkflowActions({ card: card('ready', [capability('close')]), project });
    expect(close).toMatchObject({ destructive: true, appearance: 'neutral-ghost', confirmation: { title: 'Close without delivery?' } });
  });

  it('hides Open refinement only when its destination tab is already open', () => {
    const value = card('needs_refinement', [capability('open_refinement'), capability('finish_refinement')]);
    expect(deriveCardWorkflowActions({ card: value, project, activeTab: 'chat' }).map(({ kind }) => kind)).toEqual(['finish_refinement']);
  });

  it('keeps the active Ship action visible while pending', () => {
    const [ship] = deriveCardWorkflowActions({ card: card('approved', [capability('ship')]), project, operation: { kind: 'ship' } });
    expect(ship).toMatchObject({ kind: 'ship', label: 'Ship It again', loading: true });
  });

  it('presents durable environment creation recovery supplied by the backend', () => {
    const pending = { ...card('ready', [capability('start_work'), capability('cleanup_creation')]), creation_operation: { id: 'operation-1', phase: 'recovery_required' as const, error: 'Setup completion is ambiguous', source_path: '/source', source_branch: 'feature', cleanup_available: true, custom_command: true, revision: 2 } };
    expect(deriveCardWorkflowActions({ card: pending, project })).toMatchObject([
      { kind: 'start_work', label: 'Resume start', primary: true },
      { kind: 'cleanup_creation', label: 'Clean up', destructive: true },
    ]);
  });

  it('retries durable cleanup without repeating destructive confirmation', () => {
    const retry = { ...card('done', [capability('cleanup')]), completion_outcome: 'merged' as const, cleanup_operation: { status: 'failed' as const, phase: 'remove_worktree' as const, error_code: 'cleanup_remove_worktree_failed', error_detail: 'Recover registration', started_at: 1, updated_at: 2, completed_at: null } };
    const [cleanup] = deriveCardWorkflowActions({ card: retry, project });
    expect(cleanup).toMatchObject({ kind: 'cleanup', label: 'Retry cleanup' });
    expect(cleanup.confirmation).toBeUndefined();
  });

  it('presents runtime retry separately from outcome-aware environment cleanup', () => {
    const failed = { ...card('done', [capability('retry_runtime_cleanup'), capability('cleanup')], environment), completion_outcome: 'closed' as const, runtime_cleanup_status: 'failed' as const, runtime_cleanup_error: 'PTY still running' };
    const actions = deriveCardWorkflowActions({ card: failed, project });
    expect(actions.map(({ kind }) => kind)).toEqual(['retry_runtime_cleanup', 'cleanup']);
    expect(actions[1].confirmation?.detail).toContain('branch is retained');
  });
});
