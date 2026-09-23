import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';
import type { PiSessionConfig } from '../pi/sessionController';
import type { KanbanCard } from './types';
import { launchPlanningAgent, resetPlanningLaunchesForTests, runPlanningLaunch, type PlanningLaunchDependencies } from './planningLauncher';

const projects: Project[] = [{ id: 'project', name: 'Project', path: '/checkout' }];
function card(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: 'local:172', provider: 'local', external_id: '172', title: 'Plan this', content: 'Description',
    board_id: '', board_title: '', list_id: '', list_title: '', card_url: '', assignee_names: [], status: 'needs_refinement',
    workflow_revision: 1, record_revision: 1, project_id: 'project', parent: null, child_count: 0, children: [], hierarchy_finalized: false,
    environment: null, created_at: 1, updated_at: 1, sort_order: 0, events: [], capabilities: [], ...overrides,
  };
}
function dependencies(current: { card: KanbanCard | null }): PlanningLaunchDependencies {
  return {
    latestCard: vi.fn(async () => current.card),
    beginRefinement: vi.fn(async () => {
      current.card = card({ ...(current.card ?? {}), status: 'refining', workflow_revision: 2, record_revision: 2 });
      return { card: current.card, board_revision: 4 };
    }),
    submit: vi.fn(async (_config: PiSessionConfig, _prompt: string, eligible: () => Promise<boolean>) => eligible()),
    recordFailure: vi.fn(async (attempted, message) => ({ card: card({ ...attempted, status: 'needs_refinement_input', workflow_revision: attempted.workflow_revision + 1, delivery_error: message }), board_revision: 5 })),
    releaseController: vi.fn(),
    applyCard: vi.fn(),
  };
}

describe('planning launcher', () => {
  it.each(['local', 'superthread'] as const)('starts headless planning for a %s card in its primary checkout', async (provider) => {
    const current = { card: card({ provider }) as KanbanCard | null };
    const deps = dependencies(current);
    expect(await runPlanningLaunch(current.card!.id, projects, deps)).toBe(true);
    expect(deps.beginRefinement).toHaveBeenCalledWith(expect.objectContaining({ status: 'needs_refinement' }));
    expect(deps.submit).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'kanban-card:local:172:planning', cwd: '/checkout', projectId: 'project' }),
      expect.stringContaining(provider === 'local' ? 'local card #172' : 'Superthread card #172'),
      expect.any(Function),
    );
    expect(deps.applyCard).toHaveBeenCalledWith(expect.objectContaining({ status: 'refining' }), 4);
  });

  it('revalidates status and project immediately before prompt submission', async () => {
    const current = { card: card() as KanbanCard | null };
    const deps = dependencies(current);
    deps.submit = vi.fn(async (_config, _prompt, eligible) => {
      current.card = card({ status: 'ready', workflow_revision: 3 });
      return eligible();
    });
    expect(await runPlanningLaunch('local:172', projects, deps)).toBe(false);
    expect(deps.recordFailure).not.toHaveBeenCalled();
  });

  it('retries once silently, releasing failed frontend ownership', async () => {
    const current = { card: card() as KanbanCard | null };
    const deps = dependencies(current);
    deps.submit = vi.fn().mockRejectedValueOnce(new Error('first start failed')).mockResolvedValueOnce(true);
    expect(await runPlanningLaunch('local:172', projects, deps)).toBe(true);
    expect(deps.submit).toHaveBeenCalledTimes(2);
    expect(deps.releaseController).toHaveBeenCalledOnce();
    expect(deps.recordFailure).not.toHaveBeenCalled();
  });

  it('records exhausted failure, applies its snapshot, and releases each failed controller', async () => {
    const current = { card: card() as KanbanCard | null };
    const deps = dependencies(current);
    deps.submit = vi.fn().mockRejectedValue(new Error('Pi unavailable'));
    await expect(runPlanningLaunch('local:172', projects, deps)).rejects.toThrow('Refinement could not be started: Pi unavailable');
    expect(deps.submit).toHaveBeenCalledTimes(2);
    expect(deps.releaseController).toHaveBeenCalledTimes(2);
    expect(deps.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ status: 'refining', project_id: 'project' }), 'Pi unavailable');
    expect(deps.applyCard).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'needs_refinement_input' }), 5);
  });

  it('deduplicates concurrent requests', async () => {
    resetPlanningLaunchesForTests();
    const current = { card: card() as KanbanCard | null };
    const deps = dependencies(current);
    let resolve!: (value: boolean) => void;
    deps.submit = vi.fn(() => new Promise<boolean>((accept) => { resolve = accept; }));
    const first = launchPlanningAgent('local:172', projects, deps.applyCard, deps);
    const overlap = launchPlanningAgent('local:172', projects, deps.applyCard, deps);
    expect(overlap).toBe(first);
    await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
    resolve(true);
    await expect(first).resolves.toBe(true);
    expect(deps.submit).toHaveBeenCalledOnce();
    resetPlanningLaunchesForTests();
  });
});
