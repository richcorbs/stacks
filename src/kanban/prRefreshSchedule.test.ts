import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';
import type { KanbanCardSummary } from './types';
import { targetFor } from './refreshCoordinator';
import { PrRefreshSchedule, runPrBatch } from './prRefreshSchedule';

const project = { id: 'p', path: '/repo', delivery_workflow: 'github_pull_request', target_branch: 'main' } as Project;
const card = (id: string): KanbanCardSummary => ({ id, project_id: 'p', workflow_revision: 1, status: 'approved', environment: { id: id + '-env', revision: 1, worktree_path: '/repo/' + id, branch: id, target_branch: 'main' }, pull_request: { number: 1, state: 'open' } } as KanbanCardSummary);

describe('PR refresh schedule (fake clock / fake gh)', () => {
  it('reduces a 10-card 5-minute foreground idle board from 100 gh invocations to 20', () => {
    let now = 0;
    const schedule = new PrRefreshSchedule(() => now);
    const gh = vi.fn();
    const targets = Array.from({ length: 10 }, (_, i) => targetFor(card(String(i)), [project]));
    for (now = 0; now < 300_000; now += 30_000) {
      for (const target of targets) if (schedule.due(target, false, false)) { gh(); schedule.finish(target, false); }
    }
    // Baseline: 10 cards x 10 cycles. Two scheduled reads per card.
    expect(gh).toHaveBeenCalledTimes(20);
  });

  it('prioritizes active TTL, forces explicit actions, and invalidates head/target/environment identity', () => {
    let now = 0;
    const schedule = new PrRefreshSchedule(() => now);
    const original = card('1');
    const target = targetFor(original, [project]);
    schedule.finish(target, false);
    now = 60_000;
    expect(schedule.due(target, true, false)).toBe(true);
    expect(schedule.due(target, false, false)).toBe(false);
    expect(schedule.due(target, false, false, true)).toBe(true);
    expect(schedule.due(targetFor({ ...original, environment: { ...original.environment!, revision: 2 } }, [project]), false, false)).toBe(true);
    expect(schedule.due(targetFor({ ...original, environment: { ...original.environment!, branch: 'new-head' } }, [project]), false, false)).toBe(true);
    expect(schedule.due(targetFor(original, [{ ...project, target_branch: 'release' }]), false, false)).toBe(true);
    expect(schedule.due(targetFor({ ...original, pull_request: { ...original.pull_request!, number: 2 } }, [project]), false, false)).toBe(true);
    schedule.prune([], []);
    expect(schedule.due(target, false, false)).toBe(true);
  });

  it('runs active first, bounds concurrent fake gh processes and accepts out-of-order completions', async () => {
    const targets = ['one', 'two', 'active', 'four'].map((id) => targetFor(card(id), [project]));
    const started: string[] = [];
    const resolve = new Map<string, (value: string) => void>();
    const batch = runPrBatch(targets, 'active', (target) => {
      started.push(target.card.id);
      return new Promise<string>((done) => resolve.set(target.card.id, done));
    });
    expect(started).toEqual(['active', 'one']);
    resolve.get('one')!('one-result');
    await Promise.resolve();
    expect(started).toEqual(['active', 'one', 'two']);
    resolve.get('active')!('active-result');
    await Promise.resolve();
    expect(started).toEqual(['active', 'one', 'two', 'four']);
    resolve.get('four')!('four-result');
    resolve.get('two')!('two-result');
    expect([...await batch]).toHaveLength(4);
  });

  it('pauses hidden work, refreshes stale entries on return, retries failures, and disposes cleanly', () => {
    let now = 0;
    const schedule = new PrRefreshSchedule(() => now);
    const target = targetFor(card('1'), [project]);
    schedule.finish(target, false);
    now = 400_000;
    expect(schedule.due(target, false, true)).toBe(false);
    expect(schedule.due(target, false, false)).toBe(true);
    schedule.finish(target, true);
    expect(schedule.failed('1')).toBe(true);
    expect(schedule.due(target, false, false)).toBe(false);
    now += 20_000;
    expect(schedule.due(target, false, false)).toBe(true);
    schedule.dispose();
    expect(schedule.due(target, false, false)).toBe(false);
  });
});
