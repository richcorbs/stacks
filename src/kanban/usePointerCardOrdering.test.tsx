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
let renderCount = 0;
function Harness({ cards, reorder }: { cards: KanbanCard[]; reorder: Parameters<typeof usePointerCardOrdering>[0]['reorder'] }) {
  renderCount += 1;
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
  Object.assign(event, { pointerId: 7, clientX: 10, clientY: 10, isPrimary: true, buttons: 1, ...overrides });
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
  let nextFrameId: number;
  let frames: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    renderCount = 0;
    nextFrameId = 1;
    frames = new Map();
    fakeWindow = Object.assign(new EventTarget(), {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    pointElement = laneElement();
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', {
      elementFromPoint: vi.fn(() => pointElement),
      querySelectorAll: vi.fn(() => []),
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
  });

  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });

  async function render(cards = [card('a'), card('b')], reorder = vi.fn(async () => {})) {
    await act(async () => { renderer = TestRenderer.create(<Harness cards={cards} reorder={reorder} />); });
    return reorder;
  }

  function runNextFrame() {
    const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!next) return;
    frames.delete(next[0]);
    next[1](0);
  }

  function flushFrames() {
    let safety = 10;
    while (frames.size > 0 && safety-- > 0) runNextFrame();
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

  it('uses coalesced window movement and does not rerender for an unchanged insertion target', async () => {
    await render();
    act(() => ordering.beginPointerDrag(pointerEvent(), card('a')));

    act(() => {
      fakeWindow.dispatchEvent(windowPointerEvent('pointermove', { clientX: 30, clientY: 100 }));
      fakeWindow.dispatchEvent(windowPointerEvent('pointermove', { clientX: 31, clientY: 100 }));
    });
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(ordering.dragPreview).toBeNull();
    act(flushFrames);
    expect(ordering.dragPreview?.cardIds).toEqual(['b', 'a']);
    const rendersAfterInsertion = renderCount;

    const overlay = { style: { left: '', top: '' } } as unknown as HTMLDivElement;
    act(() => ordering.setDragOverlayElement(overlay));
    act(() => { fakeWindow.dispatchEvent(windowPointerEvent('lostpointercapture')); });
    act(() => { fakeWindow.dispatchEvent(windowPointerEvent('pointermove', { clientX: 45, clientY: 100 })); });
    act(flushFrames);

    expect(overlay.style.left).toBe('35px');
    expect(overlay.style.top).toBe('90px');
    expect(renderCount).toBe(rendersAfterInsertion);
  });

  it('flushes the latest queued coordinates before committing a valid reorder', async () => {
    const reorder = await render();
    act(() => ordering.beginPointerDrag(pointerEvent(), card('a')));
    act(() => ordering.updatePointerDrag(pointerEvent({ clientX: 30, clientY: 100 })));
    expect(ordering.draggingId).toBeNull();

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
    act(flushFrames);
    expect(ordering.dragPreview?.cardIds).toEqual(['b', 'a']);

    await act(async () => ordering.finishPointerDrag(pointerEvent({ clientX: 30, clientY: 100 })));
    expect(reorder).toHaveBeenCalledWith('needs_refinement', ['a', 'b'], ['b', 'a']);
    expect(ordering.dragPreview).toBeNull();
  });

  it('does not reorder when an active drag is released outside its source column', async () => {
    const reorder = await render();
    act(() => ordering.beginPointerDrag(pointerEvent(), card('a')));
    act(() => ordering.updatePointerDrag(pointerEvent({ clientX: 30 })));
    act(flushFrames);
    pointElement = laneElement('ready');
    await act(async () => ordering.finishPointerDrag(pointerEvent({ clientX: 30 })));

    expect(reorder).not.toHaveBeenCalled();
    expect(ordering.dragPreview).toBeNull();
  });

  it('recalculates the insertion target while auto-scrolling with a stationary pointer', async () => {
    await render();
    const scroller = {
      scrollTop: 0,
      getBoundingClientRect: () => ({ top: 0, bottom: 110, height: 110 }),
    };
    const lane = {
      dataset: { kanbanLaneStatus: 'needs_refinement' },
      querySelector: () => scroller,
    };
    vi.mocked(document.querySelectorAll).mockReturnValue([lane] as unknown as NodeListOf<Element>);

    act(() => ordering.beginPointerDrag(pointerEvent(), card('a')));
    act(() => { fakeWindow.dispatchEvent(windowPointerEvent('pointermove', { clientX: 30, clientY: 100 })); });
    act(runNextFrame); // coalesced pointer movement
    const targetReadsBeforeScroll = vi.mocked(document.elementFromPoint).mock.calls.length;
    act(runNextFrame); // auto-scroll

    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(document.elementFromPoint).toHaveBeenCalledTimes(targetReadsBeforeScroll + 1);
    act(() => ordering.cancelPointerDrag());
  });

  it.each(['pointercancel', 'blur'])('clears active state on %s', async (type) => {
    const reorder = await render();
    act(() => ordering.beginPointerDrag(pointerEvent(), card('a')));
    act(() => ordering.updatePointerDrag(pointerEvent({ clientX: 30 })));
    act(flushFrames);
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
    act(flushFrames);
    expect(ordering.draggingId).toBe('b');
    await act(async () => renderer.update(<Harness cards={[card('a', { status: 'ready' })]} reorder={reorder} />));
    expect(ordering.dragPreview).toBeNull();
    expect(reorder).not.toHaveBeenCalled();
  });

  it('tears down on unmount and ignores a later release', async () => {
    const reorder = await render();
    act(() => ordering.beginPointerDrag(pointerEvent(), card('a')));
    act(() => ordering.updatePointerDrag(pointerEvent({ clientX: 30 })));
    act(flushFrames);
    act(() => ordering.updatePointerDrag(pointerEvent({ clientX: 40 })));
    await act(async () => renderer.unmount());
    act(() => { fakeWindow.dispatchEvent(windowPointerEvent('pointerup', { clientX: 30 })); });

    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(reorder).not.toHaveBeenCalled();
  });
});
