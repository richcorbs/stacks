import { describe, expect, it, vi } from 'vitest';
import type { PiRpcEnvelope } from '../pi/types';
import type { PiUiRequestWorkflowHandler } from '../pi/uiRequestWorkflow';
import { KanbanWorkflowLifecycleService } from './workflowLifecycleService';
import type { KanbanCard, KanbanCardSummary } from './types';

function card(revision = 1, status: KanbanCard['status'] = 'agent_working'): KanbanCard {
  return { id: 'c', provider: 'local', external_id: 'c', title: 'C', content: '', board_id: 'p', board_title: '', list_id: '', list_title: '', card_url: '', assignee_names: [], status, workflow_revision: revision, record_revision: revision, project_id: 'p', parent: null, child_count: 0, children: [], hierarchy_finalized: true, environment: null, created_at: 1, updated_at: revision, sort_order: 0, events: [], capabilities: [] };
}
function envelope(type: string, generation = 'g', order = 1): PiRpcEnvelope {
  return { pane_id: 'kanban-card:c:work', generation, event_id: `e${order}`, event_order: order, event: { type } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe('KanbanWorkflowLifecycleService', () => {
  it('serializes lifecycle intents per card', async () => {
    let listener!: (event: PiRpcEnvelope) => void;
    let current: KanbanCardSummary = card();
    const first = deferred<{ card: KanbanCard; board_revision: number }>();
    const calls: string[] = [];
    const service = new KanbanWorkflowLifecycleService({
      card: () => current, applyCard: (next) => (current = next),
      applyIntent: async (_id, _thread, intent) => { calls.push(intent); return calls.length === 1 ? first.promise : { card: card(3), board_revision: 3 }; },
      applyAction: async () => ({ card: card(current.workflow_revision, current.status), board_revision: 1 }), subscribePi: async (next) => { listener = next; return () => {}; },
      registerUiRequests: () => () => {}, session: () => ({ lifecycleGeneration: () => 'g', stopRefinement: async () => {} }),
      load: async () => {}, reportError: () => {},
    });
    service.start(); await Promise.resolve();
    listener(envelope('agent_start', 'g', 1));
    listener(envelope('agent_settled', 'g', 2));
    await vi.waitFor(() => expect(calls).toEqual(['agent_started']));
    first.resolve({ card: card(2), board_revision: 2 });
    await vi.waitFor(() => expect(calls).toEqual(['agent_started', 'agent_settled']));
    await vi.waitFor(() => expect(current.workflow_revision).toBe(3));
    service.dispose();
  });

  it('ignores failure events from replaced process generations', async () => {
    let listener!: (event: PiRpcEnvelope) => void;
    const applyIntent = vi.fn(async () => ({ card: card(2), board_revision: 2 }));
    const service = new KanbanWorkflowLifecycleService({
      card: () => card(), applyCard: (next) => next, applyIntent, applyAction: async () => ({ card: card(), board_revision: 1 }),
      subscribePi: async (next) => { listener = next; return () => {}; }, registerUiRequests: () => () => {},
      session: () => ({ lifecycleGeneration: () => 'new', stopRefinement: async () => {} }), load: async () => {}, reportError: () => {},
    });
    service.start(); await Promise.resolve();
    listener(envelope('pi_process_exit', 'old'));
    await Promise.resolve();
    expect(applyIntent).not.toHaveBeenCalled();
    service.dispose();
  });

  it('blocks UI response until Needs you succeeds and restores only its expected revision', async () => {
    let handler!: PiUiRequestWorkflowHandler;
    let current: KanbanCardSummary = card(1);
    const requested = deferred<{ card: KanbanCard; board_revision: number }>();
    const intents: string[] = [];
    const service = new KanbanWorkflowLifecycleService({
      card: () => current, applyCard: (next) => (current = next),
      applyIntent: async (_id, _thread, intent) => { intents.push(intent); return intent === 'ui_input_requested' ? requested.promise : { card: card(3), board_revision: 3 }; },
      applyAction: async () => ({ card: card(current.workflow_revision, current.status), board_revision: 1 }), subscribePi: async () => () => {},
      registerUiRequests: (next) => { handler = next; return () => {}; }, session: () => ({ lifecycleGeneration: () => 'g', stopRefinement: async () => {} }),
      load: async () => {}, reportError: () => {},
    });
    service.start();
    await handler.received('kanban-card:c:work', 'r', false);
    const response = handler.beforeResponse('kanban-card:c:work', 'r');
    requested.resolve({ card: card(2, 'needs_human'), board_revision: 2 });
    await response;
    expect(intents).toEqual(['ui_input_requested', 'ui_input_resolved']);
    service.dispose();
  });
});
