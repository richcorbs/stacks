import { describe, expect, it } from 'vitest';
import { DetailSessionCache, sameActionRevisions } from './detailSessionCache';
import type { KanbanCard } from './types';

function card(id: string, revision: number): KanbanCard {
  return {
    id, provider: 'local', external_id: id, title: 'Full detail', content: 'Body', board_id: '', board_title: '', list_id: '', list_title: '', card_url: '', assignee_names: [],
    status: 'approved', workflow_revision: revision, record_revision: revision, project_id: 'p', parent: null, child_count: 0, children: [], hierarchy_finalized: true,
    environment: null, created_at: 1, updated_at: revision, sort_order: 0, events: [], capabilities: [],
  };
}

describe('in-session full detail cache', () => {
  it('reopens local and Superthread details with their pagination cursor without waiting for a refresh', () => {
    const cache = new DetailSessionCache();
    const local = card('local', 1);
    const remote = { ...card('remote', 2), provider: 'superthread' as const };
    const cursor = { created_at: 42, id: 3 };
    cache.remember(local, null);
    cache.remember(remote, cursor);
    expect(cache.get('local', local)?.card.content).toBe('Body');
    expect(cache.get('remote', remote)?.cursor).toEqual(cursor);
    expect(cache.get('remote', remote)?.card.status).toBe('approved');
  });

  it('does not regress on out-of-order refreshes or reuse a stale detail after a board change', () => {
    const cache = new DetailSessionCache();
    cache.remember(card('c', 3), null);
    cache.remember(card('c', 2), null);
    expect(cache.get('c', card('c', 3))?.card.record_revision).toBe(3);
    expect(cache.get('c', card('c', 4))).toBeNull();
    expect(cache.get('other', card('other', 1))).toBeNull();
  });

  it('requires a fresh action preflight to agree on all revision-bearing fields', () => {
    const displayed = card('c', 2);
    expect(sameActionRevisions(displayed, card('c', 2))).toBe(true);
    expect(sameActionRevisions(displayed, card('c', 3))).toBe(false);
    expect(sameActionRevisions(displayed, { ...displayed, workflow_revision: 3 })).toBe(false);
    expect(sameActionRevisions(displayed, { ...displayed, status: 'done' })).toBe(false);
    expect(sameActionRevisions(displayed, card('other', 2))).toBe(false);
  });

  it('evicts deleted cards, including ones closed before deletion', () => {
    const cache = new DetailSessionCache();
    cache.remember(card('a', 1), null);
    cache.remember(card('b', 1), null);
    cache.prune(new Set(['b']));
    expect(cache.get('a', card('a', 1))).toBeNull();
    cache.remove('b');
    expect(cache.get('b', card('b', 1))).toBeNull();
  });
});
