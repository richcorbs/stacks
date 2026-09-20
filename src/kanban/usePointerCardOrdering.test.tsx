import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KanbanCard } from './types';
import { usePointerCardOrdering } from './usePointerCardOrdering';

type Ordering = ReturnType<typeof usePointerCardOrdering>;
type PointerHandlerEvent = Parameters<Ordering['beginPointerDrag']>[0];

function card(id: string, overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id, provider: 'local', external_id: id, title: id, content: '', board_id: 'p', board_title: 'P',
    list_id: '', list_title: '', card_url: '', assignee_names: [], status: 'needs_refinement',
    workflow_revision: 1, record_revision: 1, project_id: 'p', parent: null, child_count: 0,
    children: [], hierarchy_finalized: false, environment: null, created_at: 1, updated_at: 1,
    sort_order: 0, events: [], capabilities: [], ...overrides,
  };
}

let ordering: Ordering;
function Harness({ cards, reorder }: { cards: KanbanCard[]; reorder: Parameters<typeof usePointerCardOrdering>[0]['reorder'] }) {
  ordering = usePointerCardOrdering({ allCards: cards, visibleCards: cards, reorder });
  return null;
}

function pointerEvent(overrides: Partial<PointerHandlerEvent> = {}) {
  return {
    button: 0,
    buttons: 1,
    isPrimary: true,
    pointerId: 7,
    clientX: 10,
    clientY: 10,
    currentTarget: {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }),
      setPointerCapture: vi.fn(),
    },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as PointerHandlerEvent;
}

function windowPointerEvent(type: string, overrides: Record<string, unknown> = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId: 7, clientX: 10, clientY: 10, ...overrides });
  return event;
}

function laneElement(status = 'needs_refinement') {
  const cards = [
    { dataset: { kanbanCardId: 'a' }, getBoundingClientRect: () => ({ top: 0, height: 40 }) },
    { dataset: { kanbanCardId: 'b' }, getBoundingClientRect: () => ({ top: 50, height: 40 }) },
  ];
  const lane = {
    dataset: { kanbanLaneStatus: status },
    querySelectorAll: () => cards,
  };
  return { closest: () => lane };
}

describe('usePointerCardOrdering pointer lifecycle', () => {
  let fakeWindow: EventTarget & Pick<Window, 'setTimeout' | 'clearTimeout'>;
  let pointElement: ReturnType<typeof laneElement> | null;
  let renderer: TestRenderer.ReactTestRenderer;

  beforeEach(() => {
    fakeWindow = Object.assign(new EventTarget(), {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    pointElement = laneElement();
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', {
      elementFromPoint: () => pointElement,
      querySelectorAll: () => [],
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });

  async function render(cards = [card('a'), card('b')], reorder = vi.fn(async () => {})) {
    await act(async () => { renderer = TestRenderer.create(<Harness cards={cards} reorder={reorder} />); });
    return reorder;
  }

  it('clears a click below threshold so later movement cannot activate dragging', async () => {
    const reorder = await render();
    const down = pointerEvent();
    act(() => ordering.beginPointerDrag(down, card('a')));
    await act(async () => ordering.finishPointerDrag(pointerEvent()));
    act(() => ordering.updatePointerDrag(pointerEvent({ clientX: 30 })));

    expect(ordering.dragPreview).toBeNull();
    expect(ordering.shouldSuppressCardClick()).toBe(false);
    expect(reorder).not.toHaveBeenCalled();
  });

  it('requires a matching primary pointer with its primary button still held', async () => {
    await render();
    act(() => ordering.beginPointerDrag(pointerEvent(), card('a')));
    act(() => ordering.updatePointerDrag(pointerEvent({ pointerId: 8, clientX: 30 })));
    expect(ordering.dragPreview).toBeNull();

    act(() => ordering.updatePointerDrag(pointerEvent({ buttons: 0, clientX: 30 })));
    act(() => ordering.updatePointerDrag(pointerEvent({ buttons: 1, clientX: 40 })));
    expect(ordering.dragPreview).toBeNull();
  });

  it('commits a valid threshold-crossing reorder once within the source column', async () => {
    const reorder = await render();
    act(() => ordering.beginPointerDrag(pointerEvent(), card('a')));
    act(() => ordering.updatePointerDrag(pointerEvent({ clientX: 30, clientY: 100 })));
    expect(ordering.draggingId).toBe('a');

    await act(async () => { fakeWindow.dispatchEvent(windowPointerEvent('pointerup', { clientX: 30, clientY: 100 })); });
    await act(async () => ordering.finishPointerDrag(pointerEvent({ clientX: 30, clientY: 100 })));
    expect(reorder).toHaveBeenCalledTimes(1);
    expect(reorder).toHaveBeenCalledWith('needs_refinement', ['a', 'b'], ['b', 'a']);
    expect(ordering.dragPreview).toBeNull();
  });

  it('allows a finalized parent to begin and commit a reorder in its effective column', async () => {
    const parent = card('a', {
      hierarchy_finalized: true,
      child_count: 1,
      children: [{ id: 'child', external_id: '3', title: 'Child', status: 'needs_refinement' }],
    });
    const reorder = await render([parent, card('b')]);

    act(() => ordering.beginPointerDrag(pointerEvent(), parent));
    act(() => ordering.updatePointerDrag(pointerEvent({ clientX: 30, clientY: 100 })));
    expect(ordering.dragPreview?.cardIds).toEqual(['b', 'a']);

    await act(async () => ordering.finishPointerDrag(pointerEvent({ clientX: 30, clientY: 100 })));
    expect(reorder).toHaveBeenCalledWith('needs_refinement', ['a', 'b'], ['b', 'a']);
    expect(ordering.dragPreview).toBeNull();
  });

  it('does not reorder when an active drag is released outside its source column', async () => {
    const reorder = await render();
    act(() => ordering.beginPointerDrag(pointerEvent(), card('a')));
    act(() => ordering.updatePointerDrag(pointerEvent({ clientX: 30 })));
    pointElement = laneElement('ready');
    await act(async () => ordering.finishPointerDrag(pointerEvent({ clientX: 30 })));

    expect(reorder).not.toHaveBeenCalled();
    expect(ordering.dragPreview).toBeNull();
  });

  it.each(['pointercancel', 'blur'])('clears active state on %s', async (type) => {
    const reorder = await render();
    act(() => ordering.beginPointerDrag(pointerEvent(), card('a')));
    act(() => ordering.updatePointerDrag(pointerEvent({ clientX: 30 })));
    act(() => { fakeWindow.dispatchEvent(type === 'blur' ? new Event('blur') : windowPointerEvent(type)); });

    expect(ordering.dragPreview).toBeNull();
    act(() => { fakeWindow.dispatchEvent(windowPointerEvent('pointerup', { clientX: 30 })); });
    expect(reorder).not.toHaveBeenCalled();
  });

  it('clears pending and active gestures when the source changes status or disappears', async () => {
    const reorder = await render();
    act(() => ordering.beginPointerDrag(pointerEvent(), card('a')));
    await act(async () => renderer.update(<Harness cards={[card('a', { status: 'ready' }), card('b')]} reorder={reorder} />));
    act(() => ordering.updatePointerDrag(pointerEvent({ clientX: 30 })));
    expect(ordering.dragPreview).toBeNull();

    act(() => ordering.beginPointerDrag(pointerEvent(), card('b')));
    act(() => ordering.updatePointerDrag(pointerEvent({ clientX: 30 })));
    expect(ordering.draggingId).toBe('b');
    await act(async () => renderer.update(<Harness cards={[card('a', { status: 'ready' })]} reorder={reorder} />));
    expect(ordering.dragPreview).toBeNull();
    expect(reorder).not.toHaveBeenCalled();
  });

  it('tears down on unmount and ignores a later release', async () => {
    const reorder = await render();
    act(() => ordering.beginPointerDrag(pointerEvent(), card('a')));
    act(() => ordering.updatePointerDrag(pointerEvent({ clientX: 30 })));
    await act(async () => renderer.unmount());
    act(() => { fakeWindow.dispatchEvent(windowPointerEvent('pointerup', { clientX: 30 })); });

    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(reorder).not.toHaveBeenCalled();
  });
});
