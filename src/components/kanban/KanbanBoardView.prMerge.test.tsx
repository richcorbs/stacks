import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { CleanupPreflight, KanbanCard } from '../../kanban/types';
import { fetchCleanupPreflight, mergeKanbanPullRequest } from '../../kanban/api';
import { showAppToast } from '../../applicationEvents';
import { KanbanBoardView } from './KanbanBoardView';
import { BoardPrMergeDialog } from './BoardPrMergeDialog';
import { CleanupPreflightDialog } from './CleanupPreflightDialog';

vi.mock('../../kanban/api', () => ({ fetchCleanupPreflight: vi.fn(), mergeKanbanPullRequest: vi.fn() }));
vi.mock('../../applicationEvents', () => ({ showAppToast: vi.fn(), applicationEvents: { subscribe: () => () => {} } }));
vi.mock('../../loadingState', () => ({ useLoadingCoordinator: () => ({ settleStartup: vi.fn() }) }));
vi.mock('../../kanban/useKanbanRefreshCoordinator', () => ({ useKanbanRefreshCoordinator: () => ({ statuses: {}, prChecks: {} }) }));
vi.mock('../../kanban/useBoardKeyboardNavigation', () => ({ useBoardKeyboardNavigation: () => ({}) }));
vi.mock('../../kanban/usePointerCardOrdering', () => ({ usePointerCardOrdering: () => ({}) }));
vi.mock('./BoardCardServerServices', () => ({ BoardCardServerServices: () => null }));
vi.mock('./NewCardDialog', () => ({ NewCardDialog: () => null }));
vi.mock('./KanbanLanes', () => ({ KanbanLanes: (props: object) => <div data-entry="board" {...props} /> }));
vi.mock('./KanbanList', () => ({ KanbanList: (props: object) => <div data-entry="list" {...props} /> }));

const card = { id: 'c', external_id: '266', title: 'Merge me', project_id: 'p', status: 'approved', workflow_revision: 7,
  child_count: 0, children: [], environment: { id: 'env-c', revision: 12, worktree_path: '/project/card-c', branch: 'card-c' }, pull_request: { number: 98, url: 'https://github.com/a/b/pull/98', state: 'open',
    draft: false, ci_status: 'success', review_state: 'approved', blockers: [], has_conflicts: false } } as unknown as KanbanCard;
const merged = { ...card, status: 'done', workflow_revision: 8, completion_outcome: 'merged' } as KanbanCard;
const evidence = { card_id: 'c', project_id: 'p', source_path: '/project/card-c', source_branch: 'card-c', card_number: '266', card_title: 'Merge me', merged: true, has_resources: true,
  blocked: false, workflow_revision: 8, environment_revision: 12 } as CleanupPreflight;

describe.each(['board', 'list'] as const)('%s merge cleanup handoff', (view) => {
  let renderer: TestRenderer.ReactTestRenderer;
  const cleanup = vi.fn();
  const reload = vi.fn();
  const reconcile = vi.fn((updated) => updated);
  const focus = vi.fn();
  const fallbackFocus = vi.fn();
  const trigger = { isConnected: true, focus };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('document', { querySelectorAll: () => [{ dataset: { kanbanOpenCardId: 'c' }, focus: fallbackFocus }], querySelector: () => null });
    trigger.isConnected = true;
    vi.mocked(mergeKanbanPullRequest).mockResolvedValue(merged);
    vi.mocked(fetchCleanupPreflight).mockResolvedValue(evidence);
    reload.mockResolvedValue(merged);
    cleanup.mockResolvedValue(true);
    const props = { view, projects: [{ id: 'p', name: 'Project', path: '/project', delivery_workflow: 'github_pull_request' }],
      projectsHydrated: false, selectedProjectId: 'p', onPaletteCardsChange: vi.fn(), onCleanupCard: cleanup,
      board: { cards: [card], cardsHydrated: false, loading: false, applyCardSnapshot: reconcile,
        loadPersistedDetails: reload, subscribeDetailInvalidations: () => () => {} },
    } as unknown as ComponentProps<typeof KanbanBoardView>;
    act(() => { renderer = TestRenderer.create(<KanbanBoardView {...props} />); });
    act(() => renderer.root.findByProps({ 'data-entry': view }).props.onMergePullRequest(card, trigger));
  });
  afterEach(() => { act(() => renderer.unmount()); vi.unstubAllGlobals(); });
  async function confirm(intent: 'merge' | 'merge-and-cleanup' = 'merge-and-cleanup') {
    await act(async () => renderer.root.findByType(BoardPrMergeDialog).props.onConfirm(intent));
  }
  it('uses fresh single-card evidence, closes merge first, and restores focus after cleanup cancellation', async () => {
    await confirm();
    expect(fetchCleanupPreflight).toHaveBeenCalledExactlyOnceWith('c');
    expect(renderer.root.findAllByType(BoardPrMergeDialog)).toHaveLength(0);
    const dialog = renderer.root.findByType(CleanupPreflightDialog);
    expect(dialog.props.bulk).toBeUndefined();
    expect(dialog.props.inventory.entries).toEqual([evidence]);
    expect(focus).not.toHaveBeenCalled();
    trigger.isConnected = false; // Merge moved the card and removed its icon.
    act(() => dialog.props.onCancel());
    expect(cleanup).not.toHaveBeenCalled();
    expect(fallbackFocus).toHaveBeenCalledOnce();
    expect(mergeKanbanPullRequest).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(merged);
  });
  it('keeps the merge dialog busy and rejects duplicate submissions while fetching cleanup evidence', async () => {
    let finish!: (entry: CleanupPreflight) => void;
    vi.mocked(fetchCleanupPreflight).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await confirm();
    expect(renderer.root.findByType(BoardPrMergeDialog).props.busy).toBe(true);
    await confirm('merge');
    expect(mergeKanbanPullRequest).toHaveBeenCalledOnce();
    expect(focus).not.toHaveBeenCalled();
    await act(async () => finish(evidence));
    expect(renderer.root.findAllByType(BoardPrMergeDialog)).toHaveLength(0);
    expect(renderer.root.findAllByType(CleanupPreflightDialog)).toHaveLength(1);
  });
  it('rejects cleanup evidence for another card after merge success', async () => {
    vi.mocked(fetchCleanupPreflight).mockResolvedValueOnce({ ...evidence, card_id: 'other' });
    await confirm();
    expect(renderer.root.findByType(BoardPrMergeDialog).props.error).toContain('PR merged successfully, but cleanup could not begin');
    expect(renderer.root.findAllByType(CleanupPreflightDialog)).toHaveLength(0);
  });
  it('continues immediately when GitHub already deleted the remote branch after merging', async () => {
    vi.mocked(mergeKanbanPullRequest).mockResolvedValueOnce({ ...merged,
      delivery_operation_stage: 'deleting_remote_branch', delivery_error: 'PR merged, but remote branch deletion needs retry: unable to resolve reference' });
    // Preflight refresh publishes a newer persisted snapshot, just as the backend does.
    const refreshed = { ...merged, record_revision: 30 };
    vi.mocked(fetchCleanupPreflight).mockImplementationOnce(async () => {
      reload.mockResolvedValue(refreshed);
      return evidence;
    });
    await confirm();
    expect(renderer.root.findAllByType(BoardPrMergeDialog)).toHaveLength(0);
    expect(renderer.root.findByType(CleanupPreflightDialog).props.inventory.entries).toEqual([evidence]);
    await act(async () => renderer.root.findByType(CleanupPreflightDialog).props.onConfirm([evidence]));
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(refreshed, evidence);
  });
  it.each([{ workflow_revision: 7 }, { environment_revision: 99 }, { project_id: 'other' }, { source_path: '/project/unrelated' }])('rejects stale evidence %j and can recover without another merge', async (stale) => {
    vi.mocked(fetchCleanupPreflight).mockResolvedValueOnce({ ...evidence, ...stale });
    await confirm();
    expect(cleanup).not.toHaveBeenCalled();
    expect(renderer.root.findByType(BoardPrMergeDialog).props.error).toContain('revision');
    await act(async () => renderer.root.findByType(BoardPrMergeDialog).props.onRetryCleanup());
    expect(renderer.root.findAllByType(CleanupPreflightDialog)).toHaveLength(1);
    expect(mergeKanbanPullRequest).toHaveBeenCalledOnce();
  });
  it('merge-only retains the environment without fetching cleanup evidence', async () => {
    await confirm('merge');
    expect(fetchCleanupPreflight).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();
  });
  it('reports preflight failure as merge success without opening cleanup or repeating the merge', async () => {
    vi.mocked(fetchCleanupPreflight).mockRejectedValueOnce(new Error('Offline'));
    await confirm();
    expect(renderer.root.findByType(BoardPrMergeDialog).props.error).toContain('PR merged successfully, but cleanup could not begin: Offline');
    expect(renderer.root.findAllByType(CleanupPreflightDialog)).toHaveLength(0);
    await confirm();
    expect(mergeKanbanPullRequest).toHaveBeenCalledOnce();
  });
  it('shows safety blockers with cleanup-only recovery instead of bypassing them', async () => {
    vi.mocked(fetchCleanupPreflight).mockResolvedValueOnce({ ...evidence, blocked: true, override_available: false,
      blockers: ['Source path is not a registered worktree.'] });
    await confirm();
    expect(renderer.root.findAllByType(CleanupPreflightDialog)).toHaveLength(0);
    expect(renderer.root.findByType(BoardPrMergeDialog).props.error).toContain('not a registered worktree');
    expect(renderer.root.findByType(BoardPrMergeDialog).props.onRetryCleanup).toBeTypeOf('function');
    expect(cleanup).not.toHaveBeenCalled();
  });
  it('preserves explicitly authorized override confirmation', async () => {
    vi.mocked(fetchCleanupPreflight).mockResolvedValueOnce({ ...evidence, blocked: true, override_available: true,
      blockers: ['Source worktree is dirty'] });
    await confirm();
    expect(renderer.root.findByType(CleanupPreflightDialog).props.inventory.entries[0].override_available).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
  });
  it('does not clean a replacement environment during cleanup-only recovery', async () => {
    vi.mocked(fetchCleanupPreflight).mockRejectedValueOnce(new Error('Offline'));
    await confirm();
    reload.mockResolvedValue({ ...merged, environment: { ...merged.environment, id: 'replacement' } });
    await act(async () => renderer.root.findByType(BoardPrMergeDialog).props.onRetryCleanup());
    expect(renderer.root.findAllByType(CleanupPreflightDialog)).toHaveLength(0);
    expect(cleanup).not.toHaveBeenCalled();
    expect(mergeKanbanPullRequest).toHaveBeenCalledOnce();
  });
  it.each([
    { workflow_revision: 9 },
    { environment: { ...merged.environment, revision: 13 } },
    { environment: { ...merged.environment, id: 'other-environment' } },
    { id: 'other-card' },
  ])('retains resources when confirmation reload changed: %j', async (change) => {
    await confirm();
    reload.mockResolvedValueOnce({ ...merged, ...change });
    await act(async () => renderer.root.findByType(CleanupPreflightDialog).props.onConfirm([evidence]));
    expect(cleanup).not.toHaveBeenCalled();
    expect(renderer.root.findByType(BoardPrMergeDialog).props.error).toContain('changed after cleanup confirmation');
    expect(renderer.root.findByType(BoardPrMergeDialog).props.onRetryCleanup).toBeTypeOf('function');
    expect(mergeKanbanPullRequest).toHaveBeenCalledOnce();
  });
  it('guards duplicate cleanup confirmation before the persisted reload completes', async () => {
    await confirm();
    let finish!: (value: KanbanCard) => void;
    reload.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const dialog = renderer.root.findByType(CleanupPreflightDialog);
    let pending!: Promise<void>;
    act(() => { pending = dialog.props.onConfirm([evidence]); void dialog.props.onConfirm([evidence]); });
    await act(async () => { finish(merged); await pending; });
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(merged, evidence);
  });
  it.each([true, false, 'failure'])('cleans the exact merged card and reconciles even after cleanup outcome %s', async (outcome) => {
    await confirm();
    const fresh = { ...merged, record_revision: 22 };
    reload.mockResolvedValue(fresh);
    if (outcome === 'failure') cleanup.mockRejectedValueOnce(new Error('Dirty worktree'));
    else cleanup.mockResolvedValueOnce(outcome);
    await act(async () => renderer.root.findByType(CleanupPreflightDialog).props.onConfirm([evidence]));
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(fresh, evidence);
    expect(reload).toHaveBeenCalledWith('c');
    expect(reconcile).toHaveBeenLastCalledWith(fresh);
    expect(renderer.root.findAllByType(CleanupPreflightDialog)).toHaveLength(0);
    expect(mergeKanbanPullRequest).toHaveBeenCalledOnce();
    if (outcome === true) expect(focus).toHaveBeenCalledOnce();
    else {
      expect(renderer.root.findByType(BoardPrMergeDialog).props.onRetryCleanup).toBeTypeOf('function');
      expect(focus).not.toHaveBeenCalled();
      await act(async () => renderer.root.findByType(BoardPrMergeDialog).props.onRetryCleanup());
      expect(renderer.root.findAllByType(CleanupPreflightDialog)).toHaveLength(1);
      expect(mergeKanbanPullRequest).toHaveBeenCalledOnce();
    }
    if (outcome === 'failure') expect(showAppToast).toHaveBeenCalledWith(expect.stringContaining('PR merged successfully, but cleanup failed'));
  });
});
