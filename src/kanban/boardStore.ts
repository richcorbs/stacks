import type { BoardChange, BoardSnapshot, KanbanCardSummary } from './types';

type OptimisticField = 'status' | 'sort_order';
type Overlay = { generation: number; value: KanbanCardSummary[OptimisticField] };
type EntityMeta = { observedAtBoardRevision: number };

export type KanbanStoreOptions = {
  onGap?: () => void;
  gapTimeoutMs?: number;
  maxPendingDeltas?: number;
};

/**
 * Revision-aware canonical Kanban entity store. Command responses use
 * applyPartialChange; broadcast events use applyBoardChange so only the latter
 * advance board completeness in contiguous order.
 */
export class KanbanEntityStore {
  private entities = new Map<string, KanbanCardSummary>();
  private entityMeta = new Map<string, EntityMeta>();
  private removedAt = new Map<string, number>();
  private pending = new Map<number, BoardChange>();
  private overlays = new Map<string, Map<OptimisticField, Overlay>>();
  private generation = 0;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onGap?: () => void;
  private readonly gapTimeoutMs: number;
  private readonly maxPendingDeltas: number;

  contiguousBoardRevision = 0;
  completeBoardRevision = 0;

  constructor(options: KanbanStoreOptions = {}) {
    this.onGap = options.onGap;
    this.gapTimeoutMs = options.gapTimeoutMs ?? 1_500;
    this.maxPendingDeltas = options.maxPendingDeltas ?? 64;
  }

  dispose() {
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.gapTimer = null;
  }

  cards(): KanbanCardSummary[] {
    return [...this.entities.values()]
      .map((card) => {
        const overlay = this.overlays.get(card.id);
        if (!overlay?.size) return card;
        const visible = { ...card };
        for (const [field, entry] of overlay) {
          if (field === 'status') visible.status = entry.value as KanbanCardSummary['status'];
          else visible.sort_order = entry.value as number;
        }
        return visible;
      })
      .sort(compareCards);
  }

  card(id: string) {
    return this.cards().find((card) => card.id === id);
  }

  applyCard(card: KanbanCardSummary, observedAtBoardRevision = 0) {
    const removedRevision = this.removedAt.get(card.id) ?? 0;
    if (observedAtBoardRevision && removedRevision >= observedAtBoardRevision) return false;
    const current = this.entities.get(card.id);
    if (current && card.record_revision <= current.record_revision) return false;
    this.entities.set(card.id, card);
    this.entityMeta.set(card.id, {
      observedAtBoardRevision: Math.max(observedAtBoardRevision, this.entityMeta.get(card.id)?.observedAtBoardRevision ?? 0),
    });
    if (observedAtBoardRevision > removedRevision) this.removedAt.delete(card.id);
    return true;
  }

  /** Applies an affected-entity command response without claiming completeness. */
  applyPartialChange(change: BoardChange) {
    this.mergeChangeEntities(change);
  }

  /** Applies broadcast deltas only when every preceding revision is present. */
  applyBoardChange(change: BoardChange) {
    if (change.board_revision <= this.contiguousBoardRevision) {
      // Duplicate event delivery may still carry a newer record than a command
      // response observed for the same board revision.
      this.mergeChangeEntities(change);
      return;
    }
    if (change.board_revision !== this.contiguousBoardRevision + 1) {
      this.pending.set(change.board_revision, change);
      if (this.pending.size > this.maxPendingDeltas) this.requestGapRecovery();
      else this.armGapTimer();
      return;
    }
    this.applyContiguous(change);
    this.drainPending();
  }

  applyBoardSnapshot(snapshot: BoardSnapshot) {
    if (snapshot.board_revision < this.completeBoardRevision || snapshot.board_revision < this.contiguousBoardRevision) return false;
    const present = new Set(snapshot.cards.map((card) => card.id));
    for (const [id] of this.entities) {
      const observed = this.entityMeta.get(id)?.observedAtBoardRevision ?? 0;
      if (!present.has(id) && observed <= snapshot.board_revision) {
        this.entities.delete(id);
        this.entityMeta.delete(id);
        this.removedAt.set(id, snapshot.board_revision);
        this.overlays.delete(id);
      }
    }
    for (const card of snapshot.cards) this.applyCard(card, snapshot.board_revision);
    this.completeBoardRevision = snapshot.board_revision;
    this.contiguousBoardRevision = snapshot.board_revision;
    for (const revision of this.pending.keys()) {
      if (revision <= snapshot.board_revision) this.pending.delete(revision);
    }
    this.clearGapTimer();
    this.drainPending();
    return true;
  }

  beginOptimistic(fieldsByCard: Map<string, Partial<Pick<KanbanCardSummary, OptimisticField>>>) {
    const generation = ++this.generation;
    for (const [id, fields] of fieldsByCard) {
      const card = this.entities.get(id);
      if (!card) continue;
      const entityOverlays = this.overlays.get(id) ?? new Map<OptimisticField, Overlay>();
      if (fields.status !== undefined) entityOverlays.set('status', { generation, value: fields.status });
      if (fields.sort_order !== undefined) entityOverlays.set('sort_order', { generation, value: fields.sort_order });
      this.overlays.set(id, entityOverlays);
    }
    return generation;
  }

  finishOptimistic(generation: number) {
    for (const [id, fields] of this.overlays) {
      for (const [field, overlay] of fields) {
        if (overlay.generation === generation) fields.delete(field);
      }
      if (!fields.size) this.overlays.delete(id);
    }
  }

  private mergeChangeEntities(change: BoardChange) {
    for (const id of change.removed_ids) {
      if ((this.entityMeta.get(id)?.observedAtBoardRevision ?? 0) > change.board_revision) continue;
      this.entities.delete(id);
      this.entityMeta.delete(id);
      this.overlays.delete(id);
      this.removedAt.set(id, Math.max(change.board_revision, this.removedAt.get(id) ?? 0));
    }
    for (const card of change.upserts) this.applyCard(card, change.board_revision);
  }

  private applyContiguous(change: BoardChange) {
    this.mergeChangeEntities(change);
    this.contiguousBoardRevision = change.board_revision;
  }

  private drainPending() {
    let next: BoardChange | undefined;
    while ((next = this.pending.get(this.contiguousBoardRevision + 1))) {
      this.pending.delete(next.board_revision);
      this.applyContiguous(next);
    }
    if (this.pending.size) this.armGapTimer();
    else this.clearGapTimer();
  }

  private armGapTimer() {
    if (this.gapTimer || !this.onGap) return;
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      if (this.pending.size) this.onGap?.();
    }, this.gapTimeoutMs);
  }

  private requestGapRecovery() {
    this.clearGapTimer();
    this.onGap?.();
  }

  private clearGapTimer() {
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.gapTimer = null;
  }
}

export function canonicalCardById(cards: KanbanCardSummary[], id: string) {
  return cards.find((card) => card.id === id) ?? null;
}

export function compareCards(a: KanbanCardSummary, b: KanbanCardSummary) {
  return a.sort_order - b.sort_order || a.created_at - b.created_at || a.id.localeCompare(b.id);
}
