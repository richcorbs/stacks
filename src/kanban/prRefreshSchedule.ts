import type { Project } from '../types';
import type { KanbanCardSummary } from './types';
import type { RefreshTarget } from './refreshCoordinator';

/** Process a single coordinator cycle, active first, with a hard concurrency cap. */
export async function runPrBatch<T>(targets: RefreshTarget[], activeId: string | null, fetch: (target: RefreshTarget) => Promise<T>): Promise<Map<string, T>> {
  const ordered = [...targets].sort((a, b) => Number(b.card.id === activeId) - Number(a.card.id === activeId));
  const results = new Map<string, T>();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(2, ordered.length) }, async () => {
    while (cursor < ordered.length) {
      const target = ordered[cursor++];
      results.set(target.card.id, await fetch(target));
    }
  }));
  return results;
}

// The local Git/health interval remains 30s. Only GitHub reads use these TTLs.
export const PR_ACTIVE_MS = 60_000;
export const PR_FOREGROUND_MS = 180_000;
export const PR_HIDDEN_MS = 600_000;

type Entry = { identity: string; checkedAt: number | null; failures: number; retryAt: number };

/** Ephemeral schedule; never used as merge authorization (the backend preflights merges). */
export class PrRefreshSchedule {
  private entries = new Map<string, Entry>();
  private disposed = false;
  constructor(private readonly now = () => Date.now()) {}

  identity(card: KanbanCardSummary, project: Project | null) {
    const env = card.environment;
    return JSON.stringify([
      card.id, card.workflow_revision, card.status, project?.id, project?.path,
      project?.delivery_workflow, project?.target_branch, env?.id, env?.revision,
      env?.worktree_path, env?.branch, env?.target_branch, card.pull_request?.number,
      card.pull_request?.state,
    ]);
  }

  prune(cards: KanbanCardSummary[], projects: Project[]) {
    const identities = new Map(cards.map((card) => [card.id, this.identity(card, projects.find((p) => p.id === card.project_id) ?? null)]));
    for (const [id, entry] of this.entries) if (identities.get(id) !== entry.identity) this.entries.delete(id);
  }

  due(target: RefreshTarget, active: boolean, hidden: boolean, force = false) {
    if (this.disposed || hidden && !force) return false;
    const identity = this.identity(target.card, target.project);
    const entry = this.entries.get(target.card.id);
    if (!entry || entry.identity !== identity) return true;
    if (force) return true;
    const now = this.now();
    if (entry.failures) return now >= entry.retryAt;
    return entry.checkedAt === null || now - entry.checkedAt >= (hidden ? PR_HIDDEN_MS : active ? PR_ACTIVE_MS : PR_FOREGROUND_MS);
  }

  finish(target: RefreshTarget, error: boolean) {
    if (this.disposed) return;
    const identity = this.identity(target.card, target.project);
    const previous = this.entries.get(target.card.id);
    const failures = error ? (previous?.identity === identity ? previous.failures : 0) + 1 : 0;
    const now = this.now();
    // A failed read schedules a retry but must not make the last successful observation look fresh.
    const checkedAt = error ? (previous?.identity === identity ? previous.checkedAt : null) : now;
    // Deterministic per-card jitter; retry is always finite (at most two minutes).
    const jitter = [...target.card.id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % 5000;
    this.entries.set(target.card.id, { identity, checkedAt, failures, retryAt: now + Math.min(120_000, 15_000 * 2 ** Math.min(failures - 1, 3) + jitter) });
  }

  get isDisposed() { return this.disposed; }
  checkedAt(id: string) { return this.entries.get(id)?.checkedAt ?? null; }
  failed(id: string) { return Boolean(this.entries.get(id)?.failures); }
  dispose() { this.disposed = true; this.entries.clear(); }
}
