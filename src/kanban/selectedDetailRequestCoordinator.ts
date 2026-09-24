import type { CardEvent, KanbanCardDetail, KanbanCardSummary } from './types';

export type DetailRequestKind = 'authoritative' | 'local';

type Configuration<T> = {
  run: (cardId: string, kind: DetailRequestKind) => Promise<T>;
  success: (value: T, kind: DetailRequestKind, cardId: string) => boolean;
  failure: (error: unknown, kind: DetailRequestKind, cardId: string) => void;
};

type Waiter<T> = { resolve: (value: T | undefined) => void; reject: (error: unknown) => void };
type Pending<T> = { cardId: string; kind: DetailRequestKind; waiters: Waiter<T>[] };

/** Serializes detail requests for the selected card and coalesces local invalidations. */
export class SelectedDetailRequestCoordinator<T> {
  private selectedId: string | null = null;
  private generation = 0;
  private selectionEpoch = 0;
  private active = false;
  private pending: Pending<T> | null = null;

  constructor(private configuration: Configuration<T>) {}

  configure(configuration: Configuration<T>) { this.configuration = configuration; }

  select(cardId: string | null) {
    if (cardId === this.selectedId) return;
    this.selectedId = cardId;
    this.generation += 1;
    this.selectionEpoch += 1;
    // A read for the previous card must not hold up this card's first detail.
    // Its completion is still guarded by generation and cannot project stale data.
    this.active = false;
    this.resolvePending(undefined);
  }

  authoritative(cardId: string) {
    if (cardId !== this.selectedId) return Promise.resolve(undefined);
    // A newer explicit request supersedes the application of an older response.
    this.generation += 1;
    return this.schedule(cardId, 'authoritative');
  }

  local(cardId: string) {
    if (cardId !== this.selectedId) return Promise.resolve(undefined);
    return this.schedule(cardId, 'local');
  }

  private schedule(cardId: string, kind: DetailRequestKind): Promise<T | undefined> {
    if (!this.active) return this.start(cardId, kind, []);
    return new Promise<T | undefined>((resolve, reject) => {
      if (!this.pending) this.pending = { cardId, kind, waiters: [] };
      else if (kind === 'authoritative') this.pending.kind = kind;
      this.pending.waiters.push({ resolve, reject });
    });
  }

  private async start(cardId: string, kind: DetailRequestKind, waiters: Waiter<T>[]): Promise<T | undefined> {
    this.active = true;
    const generation = this.generation;
    const selectionEpoch = this.selectionEpoch;
    try {
      const value = await this.configuration.run(cardId, kind);
      const current = this.selectedId === cardId && this.generation === generation;
      const accepted = current && this.configuration.success(value, kind, cardId);
      for (const waiter of waiters) waiter.resolve(accepted ? value : undefined);
      return accepted ? value : undefined;
    } catch (error) {
      const current = this.selectedId === cardId && this.generation === generation;
      if (current) this.configuration.failure(error, kind, cardId);
      for (const waiter of waiters) current ? waiter.reject(error) : waiter.resolve(undefined);
      if (current) throw error;
      return undefined;
    } finally {
      if (selectionEpoch === this.selectionEpoch) {
        this.active = false;
        const pending = this.pending;
        this.pending = null;
        if (pending && this.selectedId === pending.cardId) void this.start(pending.cardId, pending.kind, pending.waiters).catch(() => {});
        else if (pending) pending.waiters.forEach(({ resolve }) => resolve(undefined));
      }
    }
  }

  private resolvePending(value: T | undefined) {
    this.pending?.waiters.forEach(({ resolve }) => resolve(value));
    this.pending = null;
  }
}

/** A detail mutation belongs only to the card that is still selected and displayed. */
export function canProjectSelectedDetail(selectedCardId: string | null, cardId: string, displayed?: KanbanCardDetail | null) {
  return selectedCardId === cardId && (!displayed || displayed.id === cardId);
}

/** Detail responses may be fuller than summaries, but may never regress revision-bearing state or cross card identities. */
export function detailIsCurrent(candidate: KanbanCardDetail, canonical?: KanbanCardSummary, displayed?: KanbanCardDetail | null) {
  return [canonical, displayed].filter((card): card is KanbanCardSummary | KanbanCardDetail => Boolean(card)).every((card) => (
    candidate.id === card.id
    && candidate.record_revision >= card.record_revision
    && candidate.workflow_revision >= card.workflow_revision
    && (candidate.workflow_revision > card.workflow_revision || candidate.status === card.status)
    && candidate.updated_at >= card.updated_at
    && (candidate.environment?.id !== card.environment?.id
      ? Boolean(canonical && canonical.environment?.id === candidate.environment?.id
        && candidate.record_revision > card.record_revision)
      : (!candidate.environment || (candidate.environment.revision >= card.environment!.revision
        && candidate.environment.layout_revision >= card.environment!.layout_revision)))
  ));
}

export function mergeCardEvents(current: readonly CardEvent[] = [], incoming: readonly CardEvent[] = []) {
  const events = new Map<number, CardEvent>();
  for (const event of [...current, ...incoming]) events.set(event.id, event);
  return [...events.values()].sort((a, b) => b.created_at - a.created_at || b.id - a.id);
}
