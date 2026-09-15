import { describe, expect, it, vi } from 'vitest';
import { canonicalCardById, KanbanEntityStore } from './boardStore';
import type { BoardChange, KanbanCard } from './types';

function card(id: string, revision = 1, overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id, provider: 'local', external_id: id, title: id, content: '', board_id: 'p', board_title: 'P',
    list_id: '', list_title: '', card_url: '', assignee_names: [], status: 'needs_refinement',
    workflow_revision: 1, record_revision: revision, project_id: 'p', parent: null, child_count: 0,
    children: [], hierarchy_finalized: false, environment: null, created_at: 1, updated_at: 1,
    sort_order: 0, events: [], ...overrides,
  };
}

function change(board_revision: number, upserts: KanbanCard[] = [], removed_ids: string[] = []): BoardChange {
  return { board_revision, upserts, removed_ids };
}

describe('KanbanEntityStore revision ordering', () => {
  it('accepts only newer record revisions and treats equal delivery as idempotent', () => {
    const store = new KanbanEntityStore();
    store.applyBoardSnapshot({ board_revision: 1, cards: [card('a', 2, { title: 'current' })] });
    store.applyPartialChange(change(3, [card('a', 1, { title: 'older' })]));
    store.applyPartialChange(change(3, [card('a', 2, { title: 'duplicate with different data' })]));
    expect(store.card('a')?.title).toBe('current');
    store.applyPartialChange(change(4, [card('a', 3, { title: 'newer' })]));
    expect(store.card('a')?.title).toBe('newer');
  });

  it('buffers out-of-order events and drains them contiguously', () => {
    const store = new KanbanEntityStore();
    store.applyBoardSnapshot({ board_revision: 5, cards: [card('a')] });
    store.applyBoardChange(change(7, [card('a', 3, { title: 'seven' })]));
    expect(store.card('a')?.title).toBe('a');
    store.applyBoardChange(change(6, [card('a', 2, { title: 'six' })]));
    expect(store.card('a')?.title).toBe('seven');
    expect(store.contiguousBoardRevision).toBe(7);
  });

  it('requests an authoritative reload for a persistent revision gap', () => {
    vi.useFakeTimers();
    const onGap = vi.fn();
    const store = new KanbanEntityStore({ onGap, gapTimeoutMs: 10 });
    store.applyBoardSnapshot({ board_revision: 1, cards: [card('a')] });
    store.applyBoardChange(change(3, [card('a', 2)]));
    vi.advanceTimersByTime(11);
    expect(onGap).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('does not let stale full loads overwrite mutations or resurrect deletions', () => {
    const store = new KanbanEntityStore();
    store.applyBoardSnapshot({ board_revision: 5, cards: [card('a', 2, { title: 'five' }), card('b')] });
    store.applyBoardChange(change(6, [card('a', 3, { title: 'six' })], ['b']));
    expect(store.applyBoardSnapshot({ board_revision: 5, cards: [card('a', 2), card('b')] })).toBe(false);
    expect(store.card('a')?.title).toBe('six');
    expect(store.card('b')).toBeUndefined();
  });

  it('keeps partial command watermarks separate from board completeness', () => {
    const store = new KanbanEntityStore();
    store.applyBoardSnapshot({ board_revision: 2, cards: [card('a')] });
    store.applyPartialChange(change(5, [card('a', 5, { title: 'command' })]));
    expect(store.contiguousBoardRevision).toBe(2);
    store.applyBoardChange(change(3, [card('b')]));
    expect(store.contiguousBoardRevision).toBe(3);
    expect(store.card('a')?.title).toBe('command');
  });
});

describe('KanbanEntityStore optimistic operation isolation', () => {
  it('a failed move removes only its field and preserves another card update', () => {
    const store = new KanbanEntityStore();
    store.applyBoardSnapshot({ board_revision: 1, cards: [card('a'), card('b')] });
    const move = store.beginOptimistic(new Map([['a', { status: 'ready' as const }]]));
    store.applyPartialChange(change(2, [card('b', 2, { title: 'updated' })]));
    store.finishOptimistic(move);
    expect(store.card('a')?.status).toBe('needs_refinement');
    expect(store.card('b')?.title).toBe('updated');
  });

  it('two moves on one card resolve by generation and authoritative revision', () => {
    const store = new KanbanEntityStore();
    store.applyBoardSnapshot({ board_revision: 1, cards: [card('a')] });
    const first = store.beginOptimistic(new Map([['a', { status: 'ready' as const }]]));
    const second = store.beginOptimistic(new Map([['a', { status: 'refining' as const }]]));
    store.applyPartialChange(change(2, [card('a', 2, { status: 'ready' })]));
    store.finishOptimistic(first);
    expect(store.card('a')?.status).toBe('refining');
    store.finishOptimistic(second);
    expect(store.card('a')?.status).toBe('ready');
  });

  it('reorder rollback removes only still-current sort overlays', () => {
    const store = new KanbanEntityStore();
    store.applyBoardSnapshot({ board_revision: 1, cards: [card('a'), card('b', 1, { sort_order: 1 })] });
    const reorder = store.beginOptimistic(new Map([['a', { sort_order: 1 }], ['b', { sort_order: 0 }]]));
    const move = store.beginOptimistic(new Map([['a', { status: 'ready' as const }]]));
    store.applyPartialChange(change(2, [card('b', 2, { sort_order: 3, title: 'event' })]));
    store.finishOptimistic(reorder);
    expect(store.card('a')?.status).toBe('ready');
    expect(store.card('b')?.sort_order).toBe(3);
    expect(store.card('b')?.title).toBe('event');
    store.finishOptimistic(move);
  });

  it('uses card id as a deterministic final ordering tie-breaker', () => {
    const store = new KanbanEntityStore();
    store.applyBoardSnapshot({ board_revision: 1, cards: [card('z'), card('a')] });
    expect(store.cards().map(({ id }) => id)).toEqual(['a', 'z']);
  });

  it('reconciles selected detail from the canonical entity and reports deletion', () => {
    const store = new KanbanEntityStore();
    store.applyBoardSnapshot({ board_revision: 1, cards: [card('a')] });
    expect(canonicalCardById(store.cards(), 'a')).toBe(store.card('a'));
    store.applyBoardChange(change(2, [], ['a']));
    expect(canonicalCardById(store.cards(), 'a')).toBeNull();
  });
});
