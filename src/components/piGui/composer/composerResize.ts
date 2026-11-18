import type { createChatScroll } from '../../../pi/chatScroll';

type ChatScroll = Pick<ReturnType<typeof createChatScroll>, 'layout'>;

export type ComposerResizeOptions = {
  input: HTMLTextAreaElement;
  pane?: HTMLElement | null;
  /** Read live: the transcript remounts on tab switches and replaces the instance. */
  getChatScroll?: () => ChatScroll | null | undefined;
  schedule?: (callback: FrameRequestCallback) => number;
  cancel?: (handle: number) => void;
  defer?: (callback: () => void) => number;
  cancelDefer?: (handle: number) => void;
};

/**
 * Keep the composer autosized and the transcript pinned while either box changes.
 *
 * Neither the scroll correction nor the autosize runs inside ResizeObserver
 * delivery. Writing `scrollTop` there re-enters the observer — WebKit then
 * re-runs layout mid-keystroke, which drops the composer's focus and swallows
 * input on exactly the events that resize these boxes: a line wrapping, the
 * composer collapsing on submit, and a message arriving.
 *
 * The correction is deferred on a timer rather than an animation frame, because
 * an inactive or occluded webview withholds frames and following the bottom must
 * not depend on one (see `createChatScroll`). The frame is only a coalesced second
 * pass for re-measuring the input once its new box has settled.
 */
export function observeComposerResize({ input, pane, getChatScroll, schedule = requestAnimationFrame, cancel = cancelAnimationFrame, defer = (callback) => window.setTimeout(callback, 0), cancelDefer = (handle) => window.clearTimeout(handle) }: ComposerResizeOptions) {
  const resize = () => {
    resizeComposerInput(input);
    getChatScroll?.()?.layout();
  };
  resize();
  let frame = 0;
  let follow = 0;
  const scheduleFollow = () => {
    if (follow) return;
    follow = defer(() => {
      follow = 0;
      getChatScroll?.()?.layout();
    });
  };
  if (typeof ResizeObserver === 'undefined') {
    return () => {
      cancel(frame);
      if (follow) cancelDefer(follow);
    };
  }
  const observer = new ResizeObserver(() => {
    scheduleFollow();
    if (!frame) frame = schedule(resize);
  });
  if (input.parentElement) observer.observe(input.parentElement);
  if (pane) {
    observer.observe(pane);
    const conversation = pane.querySelector<HTMLElement>(':scope > .piGuiConversation');
    if (conversation) observer.observe(conversation);
  }
  return () => {
    cancel(frame);
    if (follow) cancelDefer(follow);
    observer.disconnect();
  };
}

/**
 * Size the composer input so it grows with its content but never past the space the
 * conversation leaves it.
 */
export function resizeComposerInput(input: HTMLTextAreaElement) {
  const pane = input.closest<HTMLElement>('.piGuiPane');
  const conversation = pane?.querySelector<HTMLElement>(':scope > .piGuiConversation');
  const currentHeight = Math.max(23, input.offsetHeight);
  let availableGrowth = 0;
  if (conversation) {
    const style = getComputedStyle(conversation);
    const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    availableGrowth = Math.max(0, conversation.clientHeight - verticalPadding);
  }
  const maxHeight = Math.max(23, currentHeight + availableGrowth);
  input.style.height = 'auto';
  const height = Math.min(input.scrollHeight, maxHeight);
  input.style.maxHeight = `${maxHeight}px`;
  input.style.height = `${height}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
}
