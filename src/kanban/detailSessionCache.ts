import type { CardEventCursor, KanbanCard, KanbanCardSummary } from './types';
import { detailIsCurrent } from './selectedDetailRequestCoordinator';

/** Full details only; never populated from board summaries or persisted between sessions. */
export function sameActionRevisions(displayed: KanbanCard, fresh: KanbanCard) {
  return displayed.id === fresh.id
    && displayed.record_revision === fresh.record_revision
    && displayed.workflow_revision === fresh.workflow_revision
    && displayed.status === fresh.status
    && displayed.environment?.id === fresh.environment?.id
    && (displayed.environment?.revision ?? 0) === (fresh.environment?.revision ?? 0)
    && (displayed.environment?.layout_revision ?? 0) === (fresh.environment?.layout_revision ?? 0);
}

export class DetailSessionCache {
  private snapshots = new Map<string, { card: KanbanCard; cursor: CardEventCursor | null }>();

  get(id: string, canonical?: KanbanCardSummary) {
    const snapshot = this.snapshots.get(id);
    return canonical && snapshot && detailIsCurrent(snapshot.card, canonical) ? snapshot : null;
  }

  remember(card: KanbanCard, cursor: CardEventCursor | null, canonical?: KanbanCardSummary) {
    const prior = this.snapshots.get(card.id);
    if (prior && !detailIsCurrent(card, canonical, prior.card)) return;
    this.snapshots.set(card.id, { card, cursor });
  }

  remove(id: string) { this.snapshots.delete(id); }
  prune(ids: ReadonlySet<string>) {
    for (const id of this.snapshots.keys()) if (!ids.has(id)) this.snapshots.delete(id);
  }
}
