import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KanbanCardSummary } from './types';
import { useBoardKeyboardNavigation } from './useBoardKeyboardNavigation';

type Options = Parameters<typeof useBoardKeyboardNavigation>[0];
const card = { id: 'a', status: 'needs_refinement', sort_order: 0 } as KanbanCardSummary;
const openNewCard = vi.fn();
const openCard = vi.fn();
let navigation: ReturnType<typeof useBoardKeyboardNavigation>;

function Harness(props: Options) {
  navigation = useBoardKeyboardNavigation(props);
  return null;
}

function options(view: 'board' | 'list', overrides: Partial<Options> = {}): Options {
  return {
    visibleCards: [card], doneCollapsed: false, backlogCollapsed: false,
    selectedCard: null, openCard, view, creationAvailable: true,
    shortcutBlocked: false, openNewCard, ...overrides,
  };
}

describe.each(['board', 'list'] as const)('%s keyboard shortcut', (view) => {
  let renderer: TestRenderer.ReactTestRenderer;
  let fakeWindow: EventTarget;
  beforeEach(() => {
    vi.clearAllMocks();
    fakeWindow = new EventTarget();
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', { querySelectorAll: () => [] });
    vi.stubGlobal('requestAnimationFrame', () => 1);
  });
  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });

  async function render(overrides: Partial<Options> = {}) {
    await act(async () => { renderer = TestRenderer.create(<Harness {...options(view, overrides)} />); });
  }

  function key(value: string, overrides: Record<string, unknown> = {}) {
    const event = new Event('keydown', { cancelable: true });
    const { target = { closest: () => null }, ...rest } = overrides;
    Object.defineProperty(event, 'target', { value: target });
    Object.assign(event, { key: value, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...rest });
    act(() => { fakeWindow.dispatchEvent(event); });
    return event;
  }

  const arrows = ['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight'];
  const directions = { ArrowLeft: 'h', ArrowDown: 'j', ArrowUp: 'k', ArrowRight: 'l' };
  // Deliberately not in presentation order; the progress column is empty.
  const cards = [
    { ...card, id: 'ready-1', status: 'ready' as const },
    { ...card, id: 'backlog-1' },
    { ...card, id: 'done', status: 'done' as const },
    { ...card, id: 'ready-2', status: 'ready' as const },
    { ...card, id: 'backlog-2' },
  ];

  it.each(Object.entries(directions))('matches %s to %s for initial selection and every card', async (arrow, vim) => {
    await render({ visibleCards: cards });
    for (const start of [null, ...cards.map((candidate) => candidate.id)]) {
      act(() => navigation.setFocusedCardId(start));
      const vimHandled = key(vim).defaultPrevented;
      const vimFocus = navigation.focusedCardId;
      act(() => navigation.setFocusedCardId(start));
      expect(key(arrow).defaultPrevented).toBe(vimHandled);
      expect(navigation.focusedCardId).toBe(vimFocus);
      if (view === 'list' && ['ArrowLeft', 'ArrowRight'].includes(arrow)) {
        expect(vimHandled).toBe(false);
        expect(navigation.focusedCardId).toBe(start);
      }
    }
  });

  it('preserves ordering, boundaries, empty-column skipping and Enter after arrows', async () => {
    await render({ visibleCards: cards });
    const steps = view === 'board'
      ? [
        ['ArrowUp', 'backlog-1'], ['ArrowLeft', 'backlog-1'],
        ['ArrowDown', 'backlog-2'], ['ArrowDown', 'backlog-2'],
        ['ArrowRight', 'ready-2'], ['ArrowRight', 'done'], ['ArrowRight', 'done'],
        ['ArrowLeft', 'ready-1'], ['ArrowLeft', 'backlog-1'],
      ]
      : [
        ['ArrowUp', 'ready-1'], ['ArrowUp', 'ready-1'],
        ['ArrowDown', 'ready-2'], ['ArrowDown', 'backlog-1'],
        ['ArrowDown', 'backlog-2'], ['ArrowDown', 'done'], ['ArrowDown', 'done'],
        ['ArrowUp', 'backlog-2'],
      ];
    for (const [arrow, expected] of steps) {
      expect(key(arrow).defaultPrevented).toBe(true);
      expect(navigation.focusedCardId).toBe(expected);
    }
    expect(key('Enter').defaultPrevented).toBe(true);
    expect(openCard).toHaveBeenCalledExactlyOnceWith(cards.find((candidate) => candidate.id === navigation.focusedCardId));
  });

  it('focuses the destination without jumping, then scrolls it into view', async () => {
    const elements = cards.map((candidate) => ({
      dataset: { kanbanCardId: candidate.id }, focus: vi.fn(), scrollIntoView: vi.fn(),
    }));
    vi.stubGlobal('document', { querySelectorAll: vi.fn(() => elements) });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    await render({ visibleCards: cards });
    for (const arrow of ['ArrowDown', 'ArrowDown', 'ArrowUp']) {
      expect(key(arrow).defaultPrevented).toBe(true);
      const destination = elements.find((element) => element.dataset.kanbanCardId === navigation.focusedCardId)!;
      expect(destination.focus).toHaveBeenLastCalledWith({ preventScroll: true });
      expect(destination.scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' });
      expect(destination.focus.mock.invocationCallOrder.at(-1)).toBeLessThan(destination.scrollIntoView.mock.invocationCallOrder.at(-1)!);
    }
  });

  it.each(['metaKey', 'ctrlKey', 'altKey', 'shiftKey'])('leaves all arrows with %s unhandled', async (modifier) => {
    await render({ visibleCards: cards });
    act(() => navigation.setFocusedCardId('ready-1'));
    for (const arrow of arrows) {
      expect(key(arrow, { [modifier]: true }).defaultPrevented).toBe(false);
      expect(navigation.focusedCardId).toBe('ready-1');
    }
  });

  it.each(['input', 'textarea', 'select', '[contenteditable="true"]'])('leaves arrows in %s unhandled', async (selector) => {
    await render();
    for (const arrow of arrows) {
      expect(key(arrow, { target: { closest: () => selector } }).defaultPrevented).toBe(false);
    }
    expect(navigation.focusedCardId).toBeNull();
  });

  it.each([{ selectedCard: card }, { shortcutBlocked: true }])('respects navigation guards %j', async (guard) => {
    await render({ visibleCards: cards, ...guard });
    act(() => navigation.setFocusedCardId('ready-1'));
    for (const arrow of arrows) {
      expect(key(arrow).defaultPrevented).toBe(false);
      expect(navigation.focusedCardId).toBe('ready-1');
    }
  });

  it('leaves list group-header arrows alone without blocking board navigation', async () => {
    await render();
    const target = { closest: (selector: string) => selector === '.kanbanListGroupHeader' ? {} : null };
    for (const arrow of arrows) {
      expect(key(arrow, { target }).defaultPrevented).toBe(view === 'board');
    }
    expect(navigation.focusedCardId).toBe(view === 'board' ? 'a' : null);
  });

  it('does not consume navigation keys in an empty view', async () => {
    await render({ visibleCards: [] });
    for (const value of [...arrows, ...Object.values(directions), 'Enter']) {
      expect(key(value).defaultPrevented).toBe(false);
    }
    expect(navigation.focusedCardId).toBeNull();
  });

  it('excludes collapsed groups from arrow navigation', async () => {
    const grouped = [...cards, { ...card, id: 'progress', status: 'agent_working' as const }];
    await render({ visibleCards: grouped, doneCollapsed: true, backlogCollapsed: true, attentionCollapsed: true });
    expect(key('ArrowDown').defaultPrevented).toBe(true);
    expect(navigation.focusedCardId).toBe(view === 'list' ? 'progress' : 'backlog-1');
    expect(key(view === 'list' ? 'ArrowDown' : 'ArrowRight').defaultPrevented).toBe(true);
    expect(navigation.focusedCardId).toBe('progress');
    await act(async () => renderer.update(<Harness {...options(view, {
      visibleCards: grouped, doneCollapsed: true, backlogCollapsed: true, attentionCollapsed: true, progressCollapsed: true,
    })} />));
    expect(navigation.focusedCardId).toBe(view === 'list' ? null : 'progress');
    expect(key('ArrowDown').defaultPrevented).toBe(view === 'board');
    if (view === 'board') {
      expect(key('ArrowRight').defaultPrevented).toBe(true);
      expect(navigation.focusedCardId).toBe('ready-1');
      expect(key('ArrowRight').defaultPrevented).toBe(true);
      expect(navigation.focusedCardId).toBe('ready-1'); // Done remains excluded.
    }
  });

  it('keeps Shift+Vim navigation unchanged', async () => {
    await render();
    expect(key('J', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(navigation.focusedCardId).toBe('a');
  });

  it('clears focus when its list-only group collapses and restores board navigation', async () => {
    const attention = { ...card, id: 'attention', status: 'needs_human' as const };
    const progress = { ...card, id: 'progress', status: 'agent_working' as const };
    await render({ visibleCards: [attention, progress] });
    act(() => navigation.setFocusedCardId('attention'));
    expect(navigation.focusedCardId).toBe('attention');
    await act(async () => renderer.update(<Harness {...options(view, { visibleCards: [attention, progress], attentionCollapsed: true })} />));
    expect(navigation.focusedCardId).toBe(view === 'list' ? null : 'attention');
    expect(key('j').defaultPrevented).toBe(true);
    expect(navigation.focusedCardId).toBe(view === 'list' ? 'progress' : 'attention');
    await act(async () => renderer.update(<Harness {...options(view, { visibleCards: [attention, progress], attentionCollapsed: true, progressCollapsed: true })} />));
    expect(navigation.focusedCardId).toBe(view === 'list' ? null : 'attention');
    expect(key('j').defaultPrevented).toBe(view === 'board');
  });

  it('opens once while unobstructed and leaves unrelated typing alone', async () => {
    await render();
    expect(key('n').defaultPrevented).toBe(true);
    expect(openNewCard).toHaveBeenCalledTimes(1);
    expect(key('x').defaultPrevented).toBe(false);
    await act(async () => renderer.update(<Harness {...options(view, { shortcutBlocked: true })} />)); // Add card dialog now open
    expect(key('n').defaultPrevented).toBe(false);
    expect(openNewCard).toHaveBeenCalledTimes(1);
  });

  it('respects creation availability, the combined overlay/loading guard and selected details', async () => {
    await render({ creationAvailable: false });
    expect(key('n').defaultPrevented).toBe(false);
    await act(async () => renderer.update(<Harness {...options(view, { shortcutBlocked: true })} />));
    expect(key('n').defaultPrevented).toBe(false);
    await act(async () => renderer.update(<Harness {...options(view, { selectedCard: card })} />));
    expect(key('n').defaultPrevented).toBe(false);
    expect(openNewCard).not.toHaveBeenCalled();
  });

  it('ignores editors and modified n, including Shift combinations', async () => {
    await render();
    for (const selector of ['input', 'textarea', 'select', '[contenteditable="true"]']) {
      expect(key('n', { target: { closest: () => selector } }).defaultPrevented).toBe(false);
    }
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) {
      expect(key(modifier === 'shiftKey' ? 'N' : 'n', { [modifier]: true }).defaultPrevented).toBe(false);
    }
    expect(key('n', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(openNewCard).not.toHaveBeenCalled();
  });

  it('preserves card navigation and Enter', async () => {
    await render();
    expect(key('j').defaultPrevented).toBe(true);
    expect(navigation.focusedCardId).toBe('a');
    expect(key('enter').defaultPrevented).toBe(true);
    expect(openCard).toHaveBeenCalledWith(card);
    expect(openNewCard).not.toHaveBeenCalled();
  });

  it('ignores Enter and navigation while an overlay blocks the board, even with a card still focused', async () => {
    const nextCard = { ...card, id: 'b', sort_order: 1 };
    await render({ visibleCards: [card, nextCard] });
    const cardTarget = { closest: () => null }; // Focus can remain on a card until palette focus runs.
    expect(key('j', { target: cardTarget }).defaultPrevented).toBe(true);
    expect(navigation.focusedCardId).toBe('a');

    await act(async () => renderer.update(<Harness {...options(view, {
      visibleCards: [card, nextCard], shortcutBlocked: true,
    })} />));
    for (const blockedKey of ['Enter', 'j', 'k', 'h', 'l', 'n']) {
      expect(key(blockedKey, { target: cardTarget }).defaultPrevented).toBe(false);
    }
    expect(navigation.focusedCardId).toBe('a');
    expect(openCard).not.toHaveBeenCalled();
    expect(openNewCard).not.toHaveBeenCalled();

    await act(async () => renderer.update(<Harness {...options(view, { visibleCards: [card, nextCard] })} />));
    expect(key('Enter', { target: cardTarget }).defaultPrevented).toBe(true);
    expect(openCard).toHaveBeenCalledExactlyOnceWith(card);
    expect(key('j', { target: cardTarget }).defaultPrevented).toBe(true);
    expect(navigation.focusedCardId).toBe('b');
  });
});
