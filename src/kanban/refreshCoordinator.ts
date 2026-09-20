import type { Project } from '../types';
import type { KanbanCard } from './types';

export const ENVIRONMENT_DEPENDENT_STATUSES = new Set<KanbanCard['status']>(['agent_working', 'needs_human', 'approved']);
export const PR_REFRESH_STATUSES = new Set<KanbanCard['status']>(['agent_working', 'needs_human', 'approved']);

export type RefreshSnapshot = {
  cards: KanbanCard[];
  projects: Project[];
  visibleCardIds: string[];
  activeCardId: string | null;
};

export type RefreshRequest = {
  full: boolean;
  visible: boolean;
  active: boolean;
  cardIds: Set<string>;
  healthOnlyCardIds: Set<string>;
};

export type RefreshTarget = {
  card: KanbanCard;
  project: Project | null;
  identity: string;
};

export type RefreshCyclePlan = {
  targets: RefreshTarget[];
  healthTargets: RefreshTarget[];
  activeCardId: string | null;
};

export function isPeriodicRefreshEligible(card: KanbanCard) {
  return !card.hierarchy_finalized
    && card.status !== 'done'
    && (Boolean(card.environment) || ENVIRONMENT_DEPENDENT_STATUSES.has(card.status));
}

export function shouldRefreshPullRequest(target: RefreshTarget) {
  return !target.card.hierarchy_finalized
    && Boolean(target.card.environment)
    && target.project?.delivery_workflow === 'github_pull_request'
    && PR_REFRESH_STATUSES.has(target.card.status);
}

export function targetIdentity(card: KanbanCard, project: Project | null) {
  const environment = card.environment;
  return JSON.stringify([
    card.id,
    card.status,
    card.workflow_revision,
    environment?.revision ?? null,
    environment?.worktree_path ?? null,
    environment?.target_branch ?? null,
    project?.id ?? null,
    project?.delivery_workflow ?? 'local_merge',
    project?.target_branch ?? null,
  ]);
}

/** Includes edit/layout fields that reject stale writes but do not schedule work. */
export function targetSnapshotIdentity(card: KanbanCard, project: Project | null) {
  return JSON.stringify([targetIdentity(card, project), card.record_revision, card.updated_at, card.environment?.layout_revision ?? null]);
}

export function targetFor(card: KanbanCard, projects: Project[], visible = false, active = false): RefreshTarget {
  const project = projects.find((candidate) => candidate.id === card.project_id) ?? null;
  return { card, project, identity: JSON.stringify([targetSnapshotIdentity(card, project), visible, active]) };
}

export function isRefreshTargetCurrent(target: RefreshTarget, snapshot: RefreshSnapshot) {
  const card = snapshot.cards.find((candidate) => candidate.id === target.card.id);
  if (!card) return false;
  const project = snapshot.projects.find((candidate) => candidate.id === card.project_id) ?? null;
  return JSON.stringify([
    targetSnapshotIdentity(card, project),
    snapshot.visibleCardIds.includes(card.id),
    card.id === snapshot.activeCardId,
  ]) === target.identity;
}

export function buildRefreshCyclePlan(snapshot: RefreshSnapshot, request: RefreshRequest): RefreshCyclePlan {
  const byId = new Map(snapshot.cards.map((card) => [card.id, card]));
  const generalIds = new Set<string>();
  if (request.full) {
    snapshot.cards.filter(isPeriodicRefreshEligible).forEach((card) => generalIds.add(card.id));
  } else {
    if (request.visible) snapshot.visibleCardIds.forEach((id) => {
      const card = byId.get(id);
      if (card && isPeriodicRefreshEligible(card)) generalIds.add(id);
    });
    request.cardIds.forEach((id) => generalIds.add(id));
  }
  if (request.active && snapshot.activeCardId) generalIds.add(snapshot.activeCardId);
  // Full refreshes include the active card, including an open Done card whose
  // environment needs current cleanup health.
  if (request.full && snapshot.activeCardId) generalIds.add(snapshot.activeCardId);

  const targets = [...generalIds]
    .map((id) => byId.get(id))
    .filter((card): card is KanbanCard => Boolean(card))
    .filter((card) => !card.hierarchy_finalized)
    .filter((card) => card.status !== 'done' || card.id === snapshot.activeCardId)
    .map((card) => targetFor(card, snapshot.projects, snapshot.visibleCardIds.includes(card.id), card.id === snapshot.activeCardId));
  const healthIds = new Set([...generalIds, ...request.healthOnlyCardIds]);
  const healthTargets = [...healthIds]
    .map((id) => byId.get(id))
    .filter((card): card is KanbanCard => Boolean(card))
    .filter((card) => !card.hierarchy_finalized)
    .filter((card) => isPeriodicRefreshEligible(card) || (card.id === snapshot.activeCardId && Boolean(card.environment)) || request.healthOnlyCardIds.has(card.id))
    .map((card) => targetFor(card, snapshot.projects, snapshot.visibleCardIds.includes(card.id), card.id === snapshot.activeCardId));
  return { targets, healthTargets, activeCardId: snapshot.activeCardId };
}

export function emptyRefreshRequest(): RefreshRequest {
  return { full: false, visible: false, active: false, cardIds: new Set(), healthOnlyCardIds: new Set() };
}

function mergeRequest(target: RefreshRequest, incoming: RefreshRequest) {
  target.full ||= incoming.full;
  target.visible ||= incoming.visible;
  target.active ||= incoming.active;
  incoming.cardIds.forEach((id) => target.cardIds.add(id));
  incoming.healthOnlyCardIds.forEach((id) => target.healthOnlyCardIds.add(id));
}

function immediateTargetMap(snapshot: RefreshSnapshot) {
  const visible = new Set(snapshot.visibleCardIds);
  return new Map(snapshot.cards
    .filter((card) => visible.has(card.id) && isPeriodicRefreshEligible(card))
    .map((card) => [card.id, targetIdentity(card, snapshot.projects.find((project) => project.id === card.project_id) ?? null)]));
}

/** Owns the single timer and reduces in-flight requests to one queued cycle. */
export class KanbanRefreshCoordinator {
  private snapshot: RefreshSnapshot;
  private pending: RefreshRequest | null = null;
  private pendingWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  private running = false;
  private disposed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private immediateTargets = new Map<string, string>();
  private activeIdentity: string | null = null;

  constructor(
    snapshot: RefreshSnapshot,
    private readonly runCycle: (request: RefreshRequest, snapshot: RefreshSnapshot) => Promise<void>,
  ) {
    this.snapshot = snapshot;
  }

  start(intervalMs: number) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.request({ visible: true }); }, intervalMs);
    if (this.immediateTargets.size === 0 && this.activeIdentity === null) this.updateSnapshot(this.snapshot, true);
  }

  updateSnapshot(snapshot: RefreshSnapshot, initial = false) {
    const previousTargets = this.immediateTargets;
    const nextTargets = immediateTargetMap(snapshot);
    const changedIds = [...nextTargets].filter(([id, identity]) => previousTargets.get(id) !== identity).map(([id]) => id);
    const activeCard = snapshot.activeCardId ? snapshot.cards.find((card) => card.id === snapshot.activeCardId) : null;
    const nextActiveIdentity = activeCard ? targetIdentity(activeCard, snapshot.projects.find((project) => project.id === activeCard.project_id) ?? null) : null;
    const activeChanged = nextActiveIdentity !== this.activeIdentity;
    this.snapshot = snapshot;
    this.immediateTargets = nextTargets;
    this.activeIdentity = nextActiveIdentity;
    if (initial || changedIds.length || activeChanged) {
      void this.request({ cardIds: changedIds, active: Boolean(snapshot.activeCardId && activeChanged) });
    }
  }

  request(input: Partial<Omit<RefreshRequest, 'cardIds' | 'healthOnlyCardIds'>> & { cardIds?: Iterable<string>; healthOnlyCardIds?: Iterable<string> } = {}) {
    if (this.disposed) return Promise.reject(new Error('Refresh coordinator has been disposed'));
    const request: RefreshRequest = {
      full: input.full ?? false,
      visible: input.visible ?? false,
      active: input.active ?? false,
      cardIds: new Set(input.cardIds ?? []),
      healthOnlyCardIds: new Set(input.healthOnlyCardIds ?? []),
    };
    if (!this.pending) this.pending = emptyRefreshRequest();
    mergeRequest(this.pending, request);
    const promise = new Promise<void>((resolve, reject) => this.pendingWaiters.push({ resolve, reject }));
    if (!this.running) void this.drain();
    return promise;
  }

  private async drain() {
    this.running = true;
    while (this.pending && !this.disposed) {
      const request = this.pending;
      const waiters = this.pendingWaiters;
      this.pending = null;
      this.pendingWaiters = [];
      try {
        await this.runCycle(request, this.snapshot);
        waiters.forEach(({ resolve }) => resolve());
      } catch (error) {
        waiters.forEach(({ reject }) => reject(error));
      }
    }
    this.running = false;
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const error = new Error('Refresh coordinator has been disposed');
    this.pendingWaiters.forEach(({ reject }) => reject(error));
    this.pendingWaiters = [];
    this.pending = null;
  }
}
