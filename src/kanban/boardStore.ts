import type { BoardChange, BoardSnapshot, KanbanCardSummary } from './types';

type OptimisticField = 'status' | 'sort_order';
type Overlay = { generation: number; value: KanbanCardSummary[OptimisticField] };
type EntityMeta = { observedAtBoardRevision: number };
type VisibleProjection = {
  entity: KanbanCardSummary;
  status: KanbanCardSummary['status'];
  sortOrder: number;
  card: KanbanCardSummary;
};

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
  private visibleProjections = new Map<string, VisibleProjection>();
  private boardProjection: readonly KanbanCardSummary[] | null = null;
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

  cards(): readonly KanbanCardSummary[] {
    if (!this.boardProjection) {
      this.boardProjection = Object.freeze([...this.entities.values()]
        .map((card) => this.visibleCard(card))
        .sort(compareCards));
    }
    return this.boardProjection;
  }

  card(id: string) {
    const card = this.entities.get(id);
    return card ? this.visibleCard(card) : undefined;
  }

  applyCard(card: KanbanCardSummary, observedAtBoardRevision = 0) {
    const changed = this.applyCardEntity(card, observedAtBoardRevision);
    if (changed) this.invalidateBoardProjection();
    return changed;
  }

  /** Applies an affected-entity command response without claiming completeness. */
  applyPartialChange(change: BoardChange) {
    const changed = this.mergeChangeEntities(change);
    if (changed) this.invalidateBoardProjection();
    return changed;
  }

  /** Applies broadcast deltas only when every preceding revision is present. */
  applyBoardChange(change: BoardChange) {
    let changed: boolean;
    if (change.board_revision <= this.contiguousBoardRevision) {
      // Duplicate event delivery may still carry a newer record than a command
      // response observed for the same board revision.
      changed = this.mergeChangeEntities(change);
    } else if (change.board_revision !== this.contiguousBoardRevision + 1) {
      this.pending.set(change.board_revision, change);
      if (this.pending.size > this.maxPendingDeltas) this.requestGapRecovery();
      else this.armGapTimer();
      return false;
    } else {
      changed = this.applyContiguous(change);
      changed = this.drainPending() || changed;
    }
    if (changed) this.invalidateBoardProjection();
    return changed;
  }

  applyBoardSnapshot(snapshot: BoardSnapshot) {
    if (snapshot.board_revision < this.completeBoardRevision || snapshot.board_revision < this.contiguousBoardRevision) return false;
    let changed = false;
    const present = new Set(snapshot.cards.map((card) => card.id));
    for (const [id] of this.entities) {
      const observed = this.entityMeta.get(id)?.observedAtBoardRevision ?? 0;
      if (!present.has(id) && observed <= snapshot.board_revision) {
        this.entities.delete(id);
        this.entityMeta.delete(id);
        this.removedAt.set(id, snapshot.board_revision);
        this.overlays.delete(id);
        this.visibleProjections.delete(id);
        changed = true;
      }
    }
    for (const card of snapshot.cards) changed = this.applyCardEntity(card, snapshot.board_revision) || changed;
    this.completeBoardRevision = snapshot.board_revision;
    this.contiguousBoardRevision = snapshot.board_revision;
    for (const revision of this.pending.keys()) {
      if (revision <= snapshot.board_revision) this.pending.delete(revision);
    }
    this.clearGapTimer();
    changed = this.drainPending() || changed;
    if (changed) this.invalidateBoardProjection();
    return changed;
  }

  beginOptimistic(fieldsByCard: Map<string, Partial<Pick<KanbanCardSummary, OptimisticField>>>) {
    const generation = ++this.generation;
    let changed = false;
    for (const [id, fields] of fieldsByCard) {
      const card = this.entities.get(id);
      if (!card) continue;
      const before = this.effectiveOverlayValues(card);
      const entityOverlays = this.overlays.get(id) ?? new Map<OptimisticField, Overlay>();
      if (fields.status !== undefined) entityOverlays.set('status', { generation, value: fields.status });
      if (fields.sort_order !== undefined) entityOverlays.set('sort_order', { generation, value: fields.sort_order });
      this.overlays.set(id, entityOverlays);
      const after = this.effectiveOverlayValues(card);
      if (before.status !== after.status || before.sortOrder !== after.sortOrder) {
        this.visibleProjections.delete(id);
        changed = true;
      }
    }
    if (changed) this.invalidateBoardProjection();
    return generation;
  }

  finishOptimistic(generation: number) {
    let changed = false;
    for (const [id, fields] of this.overlays) {
      const card = this.entities.get(id);
      const before = card ? this.effectiveOverlayValues(card) : null;
      for (const [field, overlay] of fields) {
        if (overlay.generation === generation) fields.delete(field);
      }
      if (!fields.size) this.overlays.delete(id);
      if (card && before) {
        const after = this.effectiveOverlayValues(card);
        if (before.status !== after.status || before.sortOrder !== after.sortOrder) {
          this.visibleProjections.delete(id);
          changed = true;
        }
      }
    }
    if (changed) this.invalidateBoardProjection();
  }

  private applyCardEntity(card: KanbanCardSummary, observedAtBoardRevision = 0) {
    const removedRevision = this.removedAt.get(card.id) ?? 0;
    if (observedAtBoardRevision && removedRevision >= observedAtBoardRevision) return false;
    const current = this.entities.get(card.id);
    if (current && card.record_revision <= current.record_revision) return false;
    this.entities.set(card.id, card);
    this.entityMeta.set(card.id, {
      observedAtBoardRevision: Math.max(observedAtBoardRevision, this.entityMeta.get(card.id)?.observedAtBoardRevision ?? 0),
    });
    if (observedAtBoardRevision > removedRevision) this.removedAt.delete(card.id);
    this.visibleProjections.delete(card.id);
    return true;
  }

  private mergeChangeEntities(change: BoardChange) {
    let changed = false;
    for (const id of change.removed_ids) {
      if ((this.entityMeta.get(id)?.observedAtBoardRevision ?? 0) > change.board_revision) continue;
      const removed = this.entities.delete(id);
      this.entityMeta.delete(id);
      this.overlays.delete(id);
      this.removedAt.set(id, Math.max(change.board_revision, this.removedAt.get(id) ?? 0));
      if (removed) {
        this.visibleProjections.delete(id);
        changed = true;
      }
    }
    for (const card of change.upserts) changed = this.applyCardEntity(card, change.board_revision) || changed;
    return changed;
  }

  private applyContiguous(change: BoardChange) {
    const changed = this.mergeChangeEntities(change);
    this.contiguousBoardRevision = change.board_revision;
    return changed;
  }

  private drainPending() {
    let changed = false;
    let next: BoardChange | undefined;
    while ((next = this.pending.get(this.contiguousBoardRevision + 1))) {
      this.pending.delete(next.board_revision);
      changed = this.applyContiguous(next) || changed;
    }
    if (this.pending.size) this.armGapTimer();
    else this.clearGapTimer();
    return changed;
  }

  private visibleCard(card: KanbanCardSummary) {
    const { status, sortOrder } = this.effectiveOverlayValues(card);
    const cached = this.visibleProjections.get(card.id);
    if (cached?.entity === card && cached.status === status && cached.sortOrder === sortOrder) return cached.card;
    const visible = status === card.status && sortOrder === card.sort_order
      ? card
      : { ...card, status, sort_order: sortOrder };
    this.visibleProjections.set(card.id, { entity: card, status, sortOrder, card: visible });
    return visible;
  }

  private effectiveOverlayValues(card: KanbanCardSummary) {
    const overlay = this.overlays.get(card.id);
    return {
      status: (overlay?.get('status')?.value ?? card.status) as KanbanCardSummary['status'],
      sortOrder: (overlay?.get('sort_order')?.value ?? card.sort_order) as number,
    };
  }

  private invalidateBoardProjection() {
    this.boardProjection = null;
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

export function canonicalCardById(cards: readonly KanbanCardSummary[], id: string) {
  return cards.find((card) => card.id === id) ?? null;
}

export function compareCards(a: KanbanCardSummary, b: KanbanCardSummary) {
  return a.sort_order - b.sort_order || a.created_at - b.created_at || a.id.localeCompare(b.id);
}
