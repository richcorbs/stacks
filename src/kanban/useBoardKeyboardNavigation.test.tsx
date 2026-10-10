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
});
