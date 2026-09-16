import { useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import type { KanbanCard } from './types';
import { useCanonicalCardSelection } from './useCanonicalCardSelection';

function card(id: string, overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id, provider: 'local', external_id: id, title: id, content: '', board_id: 'p', board_title: 'P',
    list_id: '', list_title: '', card_url: '', assignee_names: [], status: 'needs_refinement',
    workflow_revision: 1, record_revision: 1, project_id: 'p', parent: null, child_count: 0,
    children: [], hierarchy_finalized: false, environment: null, created_at: 1, updated_at: 1,
    sort_order: 0, events: [], capabilities: [], ...overrides,
  };
}

type Selection = ReturnType<typeof useCanonicalCardSelection>;
let selection: Selection;

function DetailProbe({ current }: { current: KanbanCard }) {
  const [draft, setDraft] = useState('local draft');
  return <button type="button" data-card-id={current.id} data-status={current.status} onClick={() => setDraft('edited draft')}>
    {current.title}:{draft}
  </button>;
}

function Harness({ cards }: { cards: KanbanCard[] }) {
  selection = useCanonicalCardSelection(cards);
  return selection.selectedCard ? <DetailProbe current={selection.selectedCard} /> : null;
}

function selectedButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType('button');
}

describe('canonical card selection', () => {
  it('keeps card A selected while a background lifecycle update changes card B', async () => {
    const a = card('a', { title: 'Card A' });
    const b = card('b', { title: 'Card B', status: 'agent_working' });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<Harness cards={[a, b]} />); });
    act(() => selection.selectCard(a.id));

    const settledB = { ...b, status: 'needs_human' as const, record_revision: 2, title: 'Card B refreshed' };
    await act(async () => { renderer.update(<Harness cards={[a, settledB]} />); });

    expect(selection.selectedCardId).toBe(a.id);
    expect(selection.selectedCard).toBe(a);
    expect(selectedButton(renderer).props['data-card-id']).toBe(a.id);
    expect(settledB).toMatchObject({ status: 'needs_human', title: 'Card B refreshed' });
  });

  it('ignores stale work for a previously viewed card and identity-guards stale closes', async () => {
    const a = card('a', { title: 'Card A' });
    const b = card('b', { title: 'Card B' });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<Harness cards={[a, b]} />); });
    act(() => selection.selectCard(a.id));
    act(() => selection.selectCard(b.id));

    const staleA = { ...a, title: 'Late detail response', record_revision: 2 };
    await act(async () => { renderer.update(<Harness cards={[staleA, b]} />); });
    act(() => selection.clearSelection(a.id));

    expect(selection.selectedCardId).toBe(b.id);
    expect(selection.selectedCard).toBe(b);
    expect(selectedButton(renderer).props['data-card-id']).toBe(b.id);
  });

  it('refreshes the selected canonical card without remounting its local detail state', async () => {
    const a = card('a', { title: 'Card A' });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<Harness cards={[a]} />); });
    act(() => selection.selectCard(a.id));
    act(() => selectedButton(renderer).props.onClick());

    const refreshedA = { ...a, title: 'Card A refreshed', status: 'ready' as const, record_revision: 2 };
    await act(async () => { renderer.update(<Harness cards={[refreshedA]} />); });

    expect(selection.selectedCard).toBe(refreshedA);
    expect(selectedButton(renderer).children.join('')).toBe('Card A refreshed:edited draft');
    expect(selectedButton(renderer).props['data-status']).toBe('ready');
  });

  it('exposes selected-card removal and clears only that selection', async () => {
    const a = card('a');
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<Harness cards={[a]} />); });
    act(() => selection.selectCard(a.id));
    await act(async () => { renderer.update(<Harness cards={[]} />); });

    expect(selection.selectedCardId).toBe(a.id);
    expect(selection.selectedCard).toBeNull();
    act(() => selection.clearSelection(a.id));
    expect(selection.selectedCardId).toBeNull();
  });
});
