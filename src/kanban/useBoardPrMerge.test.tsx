import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';
import type { KanbanCard, KanbanCardSummary } from './types';
import { mergeKanbanPullRequest } from './api';
import { useBoardPrMerge } from './useBoardPrMerge';

vi.mock('./api', () => ({ mergeKanbanPullRequest: vi.fn() }));
const project: Project = { id: 'p', name: 'Project', path: '/project', delivery_workflow: 'github_pull_request' };
const card: KanbanCardSummary = { provider: 'local', board_id: 'p', board_title: 'Project', list_title: '', assignee_names: [],
  record_revision: 1, parent: null, hierarchy_finalized: false, created_at: 1, updated_at: 1, sort_order: 0, environment: null,
  id: 'c', external_id: '265', title: 'Merge me', project_id: 'p', status: 'approved', workflow_revision: 7,
  child_count: 0, children: [], pull_request: { number: 98, url: 'https://github.com/a/b/pull/98', state: 'open',
    draft: false, ci_status: 'success', review_state: 'approved', blockers: [], has_conflicts: false } };

describe('board PR merge orchestration', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let model: ReturnType<typeof useBoardPrMerge>;
  let cards: KanbanCardSummary[];
  const reconcile = vi.fn();
  const reload = vi.fn();
  const focus = vi.fn();
  const trigger = { isConnected: true, focus } as unknown as HTMLButtonElement;
  function Harness() {
    model = useBoardPrMerge({ cards, projects: [project], prChecks: {}, reconcile, reload });
    return null;
  }
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
    cards = [card];
    reload.mockResolvedValue({ ...card, workflow_revision: 8 });
    await act(async () => { renderer = TestRenderer.create(<Harness />); });
    act(() => model.request(card, trigger));
  });
  afterEach(() => { act(() => renderer.unmount()); vi.unstubAllGlobals(); });
  it('cancel performs no merge and restores focus', () => {
    act(() => model.close());
    expect(model.target).toBeNull();
    expect(mergeKanbanPullRequest).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();
  });
  it('submits the captured revision once and reconciles success without opening details', async () => {
    let finish!: (card: KanbanCard) => void;
    vi.mocked(mergeKanbanPullRequest).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    let pending!: Promise<void>;
    act(() => { pending = model.confirm(); void model.confirm(); });
    expect(model.busy).toBe(true);
    expect(model.mergingCardId).toBe('c');
    expect(mergeKanbanPullRequest).toHaveBeenCalledExactlyOnceWith('c', 7);
    const merged = { ...card, status: 'done', completion_outcome: 'merged' } as KanbanCard;
    await act(async () => { finish(merged); await pending; });
    expect(reconcile).toHaveBeenCalledWith(merged);
    expect(model.target).toBeNull();
    expect(model.busy).toBe(false);
    expect(focus).toHaveBeenCalled();
  });
  it.each([
    { workflow_revision: 8 },
    { pull_request: { ...card.pull_request!, number: 99 } },
    { pull_request: { ...card.pull_request!, url: 'https://github.com/other/repo/pull/98' } },
    { pull_request: { ...card.pull_request!, blockers: ['New blocker'] } },
  ])('does not retarget changed card or PR (%j)', async (change) => {
    cards = [{ ...card, ...change }];
    act(() => renderer.update(<Harness />));
    await act(async () => { await model.confirm(); });
    expect(mergeKanbanPullRequest).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledWith('c');
    expect(model.error).toContain('Card or PR changed');
    expect(reconcile).toHaveBeenCalled();
  });
  it.each(['stale workflow revision', 'PR is now blocked', 'Network unavailable'])('reconciles and preserves actionable error: %s', async (message) => {
    vi.mocked(mergeKanbanPullRequest).mockRejectedValue(new Error(message));
    await act(async () => { await model.confirm(); });
    expect(model.error).toBe(message);
    expect(reload).toHaveBeenCalledWith('c');
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ workflow_revision: 8 }));
    await act(async () => { await model.confirm(); });
    expect(mergeKanbanPullRequest).toHaveBeenCalledOnce();
  });
  it('reports merged-with-branch-deletion-failure as partial success', async () => {
    const merged = { ...card, status: 'done', completion_outcome: 'merged', delivery_error: 'PR merged, but remote branch deletion needs retry' } as KanbanCard;
    vi.mocked(mergeKanbanPullRequest).mockResolvedValue(merged);
    await act(async () => { await model.confirm(); });
    expect(reconcile).toHaveBeenCalledWith(merged);
    expect(model.error).toBe(merged.delivery_error);
    expect(model.target).not.toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
  it('keeps both operation and reconciliation failures visible', async () => {
    vi.mocked(mergeKanbanPullRequest).mockRejectedValue(new Error('Offline'));
    reload.mockRejectedValue(new Error('Reload offline'));
    await act(async () => { await model.confirm(); });
    expect(model.error).toContain('Offline');
    expect(model.error).toContain('Could not reload current card state');
  });
});
