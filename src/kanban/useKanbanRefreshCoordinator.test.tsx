import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, GitChangeSummary } from '../types';
import type { KanbanCard, KanbanCardSummary } from './types';
import { useKanbanRefreshCoordinator, type KanbanRefreshState } from './useKanbanRefreshCoordinator';
import { deliveryStep } from './deliveryStep';

const { invoke, fetchHealth, refreshPr } = vi.hoisted(() => ({
  invoke: vi.fn(), fetchHealth: vi.fn(), refreshPr: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('./api', () => ({ fetchKanbanEnvironmentHealth: fetchHealth, refreshKanbanPullRequest: refreshPr }));

const project: Project = { id: 'p', name: 'Project', path: '/repo', delivery_workflow: 'github_pull_request' };
function card(id: string, status: KanbanCard['status'] = 'ready'): KanbanCard {
  return {
    id, provider: 'local', external_id: id, title: id, content: '', board_id: 'p', board_title: 'Project', list_id: '', list_title: '', card_url: '',
    assignee_names: [], status, workflow_revision: 1, record_revision: 1, project_id: 'p', parent: null, child_count: 0, children: [], hierarchy_finalized: false,
    environment: { id: id, card_id: id, project_id: 'p', worktree_path: `/repo/${id}`, branch: id, repository_id: 'repo', target_checkout_path: '/repo', target_branch: 'main', source_revision: null, target_revision: null, lifecycle_state: 'ready', revision: 1, layout_revision: 1, split_layout: { kind: 'empty' }, focused_pane_id: null, panes: [] },
    pull_request: { repository: 'owner/repo', number: 42, title: 'PR', url: '', state: 'open', draft: false, ci_status: 'pending', review_state: 'pending', has_conflicts: false, mergeable: false, blockers: [] },
    created_at: 1, updated_at: 1, sort_order: 0, events: [], capabilities: [],
  };
}
let state: KanbanRefreshState;
function Harness({ cards, patchCard }: { cards: KanbanCard[]; patchCard: (card: KanbanCardSummary, expected: KanbanCardSummary) => boolean }) {
  state = useKanbanRefreshCoordinator({ cards, projects: [project], visibleCards: [], activeCardId: 'one', patchCard, intervalMs: 600_000 });
  return null;
}

async function mount(cards: KanbanCard[], patchCard = vi.fn(() => true)) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<Harness cards={cards} patchCard={patchCard} />); });
  invoke.mockClear(); fetchHealth.mockClear(); refreshPr.mockClear(); patchCard.mockClear();
  return { renderer, patchCard };
}

beforeEach(() => { vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('explicit card Git refresh', () => {
  it('reads only the selected worktree and target-branch summary, forcing an existing PR outside polling states', async () => {
    const one = card('one');
    const two = card('two');
    const summary: GitChangeSummary = { added: 3, modified: 1, deleted: 0 };
    invoke.mockImplementation(async (command: string) => command === 'git_change_summary' ? summary : { branch: 'one' });
    fetchHealth.mockResolvedValue([]);
    refreshPr.mockResolvedValue({ card: one, error: null });
    const { renderer, patchCard } = await mount([one, two]);
    await act(async () => { await state.refreshCard('one'); });
    expect(invoke.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['git_info', { path: '/repo/one' }],
      ['git_change_summary', { path: '/repo/one', targetBranch: 'main' }],
    ]);
    expect(state.activeSummary).toEqual(summary);
    expect(refreshPr).toHaveBeenCalledExactlyOnceWith('one');
    expect(patchCard).toHaveBeenCalledWith(one, one);
    await act(async () => { renderer.unmount(); });
  });

  it.each(['record', 'PR', 'environment'] as const)('rejects a late PR response after the %s identity changes', async (changed) => {
    const one = card('one');
    invoke.mockImplementation(async (command: string) => command === 'git_change_summary' ? { added: 1, modified: 0, deleted: 0 } : { branch: 'one' });
    fetchHealth.mockResolvedValue([]);
    refreshPr.mockResolvedValue({ card: one, error: null });
    const { renderer, patchCard } = await mount([one]);
    expect(refreshPr).not.toHaveBeenCalled(); // initial active refresh is not an explicit card request
    let resolve!: (result: unknown) => void;
    refreshPr.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    let pending!: Promise<void>;
    await act(async () => { pending = state.refreshCard('one'); await Promise.resolve(); });
    const newer = changed === 'PR' ? { ...one, pull_request: { ...one.pull_request!, number: 43 } }
      : changed === 'environment' ? { ...one, environment: { ...one.environment!, revision: 2, branch: 'replacement' } }
        : { ...one, record_revision: 2, updated_at: 2 };
    await act(async () => { renderer.update(<Harness cards={[newer]} patchCard={patchCard} />); });
    await act(async () => { resolve({ card: { ...one, pull_request: { ...one.pull_request!, ci_status: 'success', blockers: [], mergeable: true } }, error: null }); await pending; });
    expect(patchCard).not.toHaveBeenCalled();
    if (changed !== 'record') expect(state.prChecks.one).toBeUndefined();
    await act(async () => { renderer.unmount(); });
  });

  it('does not fetch a PR for an ineligible card without one', async () => {
    const one = { ...card('one'), pull_request: null };
    invoke.mockResolvedValue(null);
    fetchHealth.mockResolvedValue([]);
    const { renderer } = await mount([one]);
    await act(async () => { await state.refreshCard('one'); });
    expect(refreshPr).not.toHaveBeenCalled();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(['git_info', 'git_change_summary']);
    await act(async () => { renderer.unmount(); });
  });

  it('preserves persisted merge readiness through refresh failure/retry, then projects confirmed pending CI', async () => {
    const one = card('one', 'approved');
    one.pull_request = { ...one.pull_request!, ci_status: 'success', mergeable: true, blockers: [] };
    invoke.mockResolvedValue(null);
    fetchHealth.mockResolvedValue([]);
    let resolve!: (result: unknown) => void;
    refreshPr.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const { renderer, patchCard } = await mount([one]);
    const projectStep = () => deliveryStep(one, { projects: [project], prChecks: state.prChecks });
    expect(state.prChecks.one).toMatchObject({ checkedAt: null, refreshing: true });
    expect(projectStep()).toEqual({ label: 'PR merge available · Merge PR', actionRequired: true, prMergeReady: true });
    await act(async () => { resolve({ card: one, error: 'rate limit' }); });
    expect(state.prChecks.one).toMatchObject({ checkedAt: null, failed: true, refreshing: false });
    expect(projectStep().label).toBe('PR merge available · Merge PR');
    expect(patchCard).not.toHaveBeenCalled();

    const ciRunning = { ...one, pull_request: { ...one.pull_request!, ci_status: 'pending' as const, blockers: ['CI is pending'] } };
    refreshPr.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    let pending!: Promise<void>;
    await act(async () => { pending = state.refreshCard('one'); await Promise.resolve(); });
    expect(state.prChecks.one).toMatchObject({ failed: true, refreshing: true });
    expect(projectStep().actionRequired).toBe(true);
    await act(async () => { resolve({ card: ciRunning, error: null }); await pending; });
    expect(patchCard).toHaveBeenCalledWith(ciRunning, one);
    await act(async () => { renderer.update(<Harness cards={[ciRunning]} patchCard={patchCard} />); });
    expect(state.prChecks.one).toMatchObject({ failed: false, refreshing: false });
    expect(deliveryStep(ciRunning, { projects: [project], prChecks: state.prChecks })).toEqual({ label: 'PR open · CI running', actionRequired: false });
    await act(async () => { renderer.unmount(); });
  });

  it('records a failed remote read without marking old PR data freshly checked', async () => {
    const one = card('one');
    invoke.mockResolvedValue(null);
    fetchHealth.mockResolvedValue([]);
    refreshPr.mockResolvedValue({ card: one, error: 'rate limit' });
    const { renderer, patchCard } = await mount([one]);
    await act(async () => { await state.refreshCard('one'); });
    expect(state.prChecks.one).toMatchObject({ checkedAt: null, failed: true, refreshing: false });
    expect(patchCard).not.toHaveBeenCalled();
    await act(async () => { renderer.unmount(); });
  });
});
