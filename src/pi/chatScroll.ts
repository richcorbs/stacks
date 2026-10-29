// Scroll events also come from browser anchoring, viewport resizing, and our own
// writes. Only upward movement in unchanged geometry means the reader scrolled
// away; a growing transcript must not revoke the intent to follow it.
export function createChatScroll(viewport: HTMLElement, schedule: (callback: FrameRequestCallback) => number = requestAnimationFrame, cancel = cancelAnimationFrame) {
  let following = true;
  let frame = 0;
  const measure = () => ({ top: viewport.scrollTop, height: viewport.scrollHeight, viewport: viewport.clientHeight });
  let previous = measure();
  const follow = () => {
    if (following) viewport.scrollTop = viewport.scrollHeight;
    previous = measure();
  };
  const layout = () => {
    if (frame) cancel(frame);
    frame = schedule(() => { frame = 0; follow(); });
  };
  return {
    layout,
    follow,
    resume() { following = true; layout(); },
    pause() { following = false; },
    scroll() {
      const current = measure();
      const sameGeometry = current.height === previous.height && current.viewport === previous.viewport;
      if (sameGeometry) {
        if (current.top < previous.top) following = false;
        else if (current.height - current.top - current.viewport < 80) following = true;
      }
      previous = current;
      if (!sameGeometry) layout();
    },
    dispose() { if (frame) cancel(frame); },
  };
}
