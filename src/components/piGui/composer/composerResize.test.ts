// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { observeComposerResize } from './composerResize';

type ObserverCallback = () => void;

/**
 * The transcript must be re-pinned by the resize notification itself, not by a
 * later animation frame: an inactive or occluded webview withholds frames, and
 * `tests/pi-chat-scroll.mjs` simulates exactly that by holding every frame while
 * the composer collapses on submit.
 */
describe('composer resize wiring', () => {
  let callbacks: ObserverCallback[];
  let observed: Element[];
  let disconnected: number;
  let pendingFrames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    callbacks = [];
    observed = [];
    disconnected = 0;
    pendingFrames = new Map();
    nextFrame = 0;
    vi.stubGlobal('ResizeObserver', class {
      private callback: ObserverCallback;
      constructor(callback: ObserverCallback) {
        this.callback = callback;
        callbacks.push(callback);
      }
      observe(element: Element) { observed.push(element); }
      disconnect() { disconnected++; }
    });
  });

  const notifyResize = () => callbacks.forEach((callback) => callback());
  const runFrame = () => {
    const due = [...pendingFrames.entries()];
    pendingFrames.clear();
    due.forEach(([, callback]) => callback(0));
  };

  function setup() {
    const parent = document.createElement('div');
    const input = document.createElement('textarea');
    parent.appendChild(input);
    document.body.appendChild(parent);
    const pane = document.createElement('div');
    pane.className = 'piGuiPane';
    const conversation = document.createElement('div');
    conversation.className = 'piGuiConversation';
    pane.appendChild(conversation);
    document.body.appendChild(pane);

    const layout = vi.fn();
    const scroll: { layout: typeof layout } = { layout };
    const dispose = observeComposerResize({
      input,
      pane,
      getChatScroll: () => scroll,
      schedule: (callback) => { const handle = ++nextFrame; pendingFrames.set(handle, callback); return handle; },
      cancel: (handle) => { pendingFrames.delete(handle); },
    });
    return { input, parent, pane, conversation, layout, dispose };
  }

  it('observes the composer, the pane and the conversation', () => {
    const { parent, pane, conversation, dispose } = setup();
    expect(observed).toEqual([parent, pane, conversation]);
    dispose();
  });

  it('re-pins the transcript synchronously, before any frame runs', () => {
    const { layout, dispose } = setup();
    layout.mockClear();
    notifyResize();
    expect(layout).toHaveBeenCalled();
    dispose();
  });

  it('still coalesces the input remeasure onto a single frame', () => {
    const { layout, dispose } = setup();
    layout.mockClear();
    notifyResize();
    notifyResize();
    notifyResize();
    expect(layout).toHaveBeenCalledTimes(3);
    expect(pendingFrames.size).toBe(1);
    runFrame();
    expect(layout).toHaveBeenCalledTimes(4);
    dispose();
  });

  it('follows a replaced transcript instance instead of a captured one', () => {
    // Tabs remount the transcript, which disposes the old chat-scroll and creates a
    // new one. A captured reference would pin a dead instance forever.
    let live = { layout: vi.fn() };
    const input = document.createElement('textarea');
    const parent = document.createElement('div');
    parent.appendChild(input);
    const dispose = observeComposerResize({
      input,
      getChatScroll: () => live,
      schedule: () => 1,
      cancel: () => {},
    });
    live.layout.mockClear();
    notifyResize();
    expect(live.layout).toHaveBeenCalled();
    const replacement = { layout: vi.fn() };
    live = replacement;
    notifyResize();
    expect(replacement.layout).toHaveBeenCalled();
    dispose();
  });

  it('cancels the pending frame and disconnects on teardown', () => {
    const { dispose } = setup();
    notifyResize();
    expect(pendingFrames.size).toBe(1);
    dispose();
    expect(pendingFrames.size).toBe(0);
    expect(disconnected).toBe(1);
  });
});
