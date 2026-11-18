// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { observeComposerResize } from './composerResize';

type ObserverCallback = () => void;

/**
 * These box changes happen while the user is typing: a line wraps, the composer
 * collapses on submit, a message arrives. Writing scrollTop inside the observer
 * callback re-entered it and (in WebKit) dropped the composer's focus and
 * swallowed input, so the callback must only *schedule* work.
 */
describe('composer resize wiring', () => {
  let callbacks: ObserverCallback[];
  let observed: Element[];
  let disconnected: number;
  let pendingFrames: Map<number, FrameRequestCallback>;
  let pendingTimers: Map<number, () => void>;
  let nextHandle: number;

  beforeEach(() => {
    callbacks = [];
    observed = [];
    disconnected = 0;
    pendingFrames = new Map();
    pendingTimers = new Map();
    nextHandle = 0;
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
    const due = [...pendingFrames.values()];
    pendingFrames.clear();
    due.forEach((callback) => callback(0));
  };
  const runTimers = () => {
    const due = [...pendingTimers.values()];
    pendingTimers.clear();
    due.forEach((callback) => callback());
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
    const scroll = { layout };
    const dispose = observeComposerResize({
      input,
      pane,
      getChatScroll: () => scroll,
      schedule: (callback) => { const handle = ++nextHandle; pendingFrames.set(handle, callback); return handle; },
      cancel: (handle) => { pendingFrames.delete(handle); },
      defer: (callback) => { const handle = ++nextHandle; pendingTimers.set(handle, callback); return handle; },
      cancelDefer: (handle) => { pendingTimers.delete(handle); },
    });
    return { input, parent, pane, conversation, layout, scroll, dispose };
  }

  it('observes the composer, the pane and the conversation', () => {
    const { parent, pane, conversation, dispose } = setup();
    expect(observed).toEqual([parent, pane, conversation]);
    dispose();
  });

  it('never writes layout inside observer delivery', () => {
    const { layout, dispose } = setup();
    layout.mockClear();
    notifyResize();
    expect(layout).not.toHaveBeenCalled();
    dispose();
  });

  it('re-pins the transcript without any animation frame', () => {
    const { layout, dispose } = setup();
    layout.mockClear();
    notifyResize();
    expect(pendingFrames.size).toBe(1);
    runTimers();                       // timers run in an occluded webview
    expect(layout).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('coalesces repeated notifications into one correction and one frame', () => {
    const { layout, dispose } = setup();
    layout.mockClear();
    notifyResize();
    notifyResize();
    notifyResize();
    expect(pendingTimers.size).toBe(1);
    expect(pendingFrames.size).toBe(1);
    runTimers();
    expect(layout).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('follows a replaced transcript instance instead of a captured one', () => {
    let live = { layout: vi.fn() };
    const input = document.createElement('textarea');
    const parent = document.createElement('div');
    parent.appendChild(input);
    const dispose = observeComposerResize({
      input,
      getChatScroll: () => live,
      schedule: () => 1,
      cancel: () => {},
      defer: (callback) => { const handle = ++nextHandle; pendingTimers.set(handle, callback); return handle; },
      cancelDefer: (handle) => { pendingTimers.delete(handle); },
    });
    live.layout.mockClear();
    notifyResize();
    runTimers();
    expect(live.layout).toHaveBeenCalled();
    const replacement = { layout: vi.fn() };
    live = replacement;
    notifyResize();
    runTimers();
    expect(replacement.layout).toHaveBeenCalled();
    dispose();
  });

  it('cancels pending work and disconnects on teardown', () => {
    const { dispose } = setup();
    notifyResize();
    expect(pendingTimers.size).toBe(1);
    dispose();
    expect(pendingTimers.size).toBe(0);
    expect(pendingFrames.size).toBe(0);
    expect(disconnected).toBe(1);
  });
});
