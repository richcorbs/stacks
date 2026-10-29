import { describe, expect, it } from 'vitest';
import { createChatScroll } from './chatScroll';
import { prependAnchoredScrollTop } from './transcript';

function harness() {
  let height = 1200;
  let viewportHeight = 400;
  let top = 800;
  const viewport = {
    get scrollHeight() { return height; },
    get clientHeight() { return viewportHeight; },
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(value, height - viewportHeight)); },
  } as HTMLElement;
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const scroll = createChatScroll(viewport, (callback) => { frames.set(++id, callback); return id; }, (key) => { frames.delete(key); });
  return {
    viewport, scroll, frames,
    grow(value: number) { height += value; },
    resize(value: number) { viewportHeight = value; viewport.scrollTop = top; },
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); },
    expectBottom() { expect(top).toBe(height - viewportHeight); },
  };
}

describe('Pi chat bottom-follow (shared card and workspace presentation)', () => {
  it('retains submit intent through code-block growth, composer collapse, and delayed scroll events', () => {
    const h = harness();
    h.viewport.scrollTop = 100;
    h.scroll.scroll();
    h.scroll.resume(); // Sending re-enables following, even from history.
    h.grow(600); // Fenced user message renders before the composer settles.
    h.scroll.scroll(); // A queued programmatic/layout scroll sees the new gap.
    h.resize(650); // Multiline composer collapses.
    h.scroll.scroll();
    h.flush();
    h.expectBottom();
    h.scroll.scroll(); // The browser delivers the programmatic scroll later.
    h.grow(500); // Streaming assistant code block.
    h.scroll.layout();
    h.flush();
    h.expectBottom();
  });

  it('follows content-only growth, wrapping, and viewport changes without message updates', () => {
    const h = harness();
    for (const growth of [20, 300, 900]) {
      h.grow(growth);
      h.scroll.layout(); // Transcript ResizeObserver, not just viewport resize.
      h.flush();
      h.expectBottom();
    }
    h.resize(200);
    h.scroll.scroll();
    h.scroll.layout();
    h.flush();
    h.expectBottom();
  });

  it('pauses when the reader scrolls up and resumes on returning to the bottom', () => {
    const h = harness();
    h.viewport.scrollTop = 300;
    h.scroll.scroll();
    h.grow(400);
    h.scroll.layout();
    h.flush();
    expect(h.viewport.scrollTop).toBe(300);
    h.viewport.scrollTop = h.viewport.scrollHeight;
    h.scroll.scroll();
    h.grow(100);
    h.scroll.layout();
    h.flush();
    h.expectBottom();
  });

  it('does not override a small upward scroll within the bottom threshold', () => {
    const h = harness();
    h.viewport.scrollTop -= 20;
    h.scroll.scroll();
    h.grow(200);
    h.scroll.layout();
    h.flush();
    expect(h.viewport.scrollTop).toBe(780);
  });

  it('honors explicit scroll-away intent during simultaneous streaming growth', () => {
    const h = harness();
    h.scroll.layout();
    h.scroll.pause(); // Wheel/trackpad up before the browser scrolls.
    h.grow(500);
    h.viewport.scrollTop = 500;
    h.scroll.scroll();
    h.flush();
    expect(h.viewport.scrollTop).toBe(500);
  });

  it('preserves the older-history prepend anchor and does not follow later growth', () => {
    const h = harness();
    h.viewport.scrollTop = 100;
    h.scroll.scroll();
    const oldHeight = h.viewport.scrollHeight;
    const oldTop = h.viewport.scrollTop;
    h.scroll.pause();
    h.grow(700);
    h.viewport.scrollTop = prependAnchoredScrollTop(oldHeight, oldTop, h.viewport.scrollHeight);
    h.scroll.scroll();
    h.scroll.layout();
    h.flush();
    expect(h.viewport.scrollTop).toBe(800);
    h.grow(400);
    h.scroll.layout();
    h.flush();
    expect(h.viewport.scrollTop).toBe(800);
  });

  it('coalesces layout work and cancels pending frames on unmount', () => {
    const h = harness();
    h.scroll.layout();
    h.scroll.layout();
    expect(h.frames.size).toBe(1);
    h.scroll.dispose();
    expect(h.frames.size).toBe(0);
  });
});
