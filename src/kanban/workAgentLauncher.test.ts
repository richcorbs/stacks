import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';
import type { PiSessionConfig } from '../pi/sessionController';
import type { KanbanCard } from './types';
import { launchWorkAgent, resetWorkAgentLaunchesForTests, runWorkAgentLaunch, type WorkAgentLaunchDependencies } from './workAgentLauncher';

const projects: Project[] = [{ id: 'project', name: 'Project', path: '/checkout' }];
function card(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: 'local:99', provider: 'local', external_id: '99', title: 'Agent does not start', content: 'Do the work',
    board_id: '', board_title: '', list_id: '', list_title: '', card_url: '', assignee_names: [], status: 'agent_working',
    workflow_revision: 2, record_revision: 2, project_id: 'project', parent: null, child_count: 0, children: [], hierarchy_finalized: false,
    environment: { id: 'env', card_id: 'local:99', project_id: 'project', worktree_path: '/worktree', branch: 'card-99', repository_id: null,
      target_checkout_path: '/checkout', target_branch: 'main', source_revision: null, target_revision: null, lifecycle_state: 'ready', revision: 1,
      layout_revision: 1, split_layout: { kind: 'empty' }, focused_pane_id: null, panes: [] },
    created_at: 1, updated_at: 2, sort_order: 0, events: [], capabilities: [], ...overrides,
  };
}
function dependencies(current: { card: KanbanCard | null }): WorkAgentLaunchDependencies {
  return {
    latestCard: vi.fn(async () => current.card),
    submit: vi.fn(async (_config: PiSessionConfig, _prompt: string, eligible: () => Promise<boolean>) => eligible()),
    recordFailure: vi.fn(async () => {}),
    releaseController: vi.fn(),
  };
}

describe('work agent launcher', () => {
  it.each(['local', 'superthread'] as const)('launches a %s card without a mounted detail view', async (provider) => {
    const current = { card: card({ provider }) as KanbanCard | null };
    const deps = dependencies(current);
    expect(await runWorkAgentLaunch(current.card!.id, projects, deps)).toBe(true);
    expect(deps.submit).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'kanban-card:local:99:work', cwd: '/worktree', projectId: 'project' }),
      expect.stringContaining(provider === 'local' ? 'local card #99' : 'Superthread card #99'),
      expect.any(Function),
    );
  });

  it('revalidates ownership and environment after hydration before submitting', async () => {
    const current = { card: card() as KanbanCard | null };
    const deps = dependencies(current);
    deps.submit = vi.fn(async (_config, _prompt, eligible) => {
      current.card = card({ project_id: 'other' });
      return eligible();
    });
    expect(await runWorkAgentLaunch('local:99', projects, deps)).toBe(false);
  });

  it('records initialization or prompt failure and releases only frontend ownership for retry', async () => {
    const current = { card: card() as KanbanCard | null };
    const deps = dependencies(current);
    deps.submit = vi.fn(async () => { throw new Error('Pi prompt timed out'); });
    await expect(runWorkAgentLaunch('local:99', projects, deps)).rejects.toThrow('Pi prompt timed out');
    expect(deps.recordFailure).toHaveBeenCalledWith(current.card, 'Pi prompt timed out');
    expect(deps.releaseController).toHaveBeenCalledWith('kanban-card:local:99:work');
  });

  it('deduplicates overlapping attempts and permits a later Needs you retry in the same environment', async () => {
    resetWorkAgentLaunchesForTests();
    const current = { card: card() as KanbanCard | null };
    let accept!: () => void;
    const waiting = new Promise<void>((resolve) => { accept = resolve; });
    const deps = dependencies(current);
    deps.submit = vi.fn(async () => { await waiting; return true; });
    const first = launchWorkAgent('local:99', projects, deps);
    const overlap = launchWorkAgent('local:99', projects, deps);
    expect(overlap).toBe(first);
    accept();
    await first;
    current.card = card({ status: 'needs_human' });
    await launchWorkAgent('local:99', projects, deps);
    expect(deps.submit).toHaveBeenCalledTimes(2);
    resetWorkAgentLaunchesForTests();
  });
});
