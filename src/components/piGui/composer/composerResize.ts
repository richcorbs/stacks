import type { createChatScroll } from '../../../pi/chatScroll';

type ChatScroll = Pick<ReturnType<typeof createChatScroll>, 'layout'>;

export type ComposerResizeOptions = {
  input: HTMLTextAreaElement;
  pane?: HTMLElement | null;
  /** Read live: the transcript remounts on tab switches and replaces the instance. */
  getChatScroll?: () => ChatScroll | null | undefined;
  schedule?: (callback: FrameRequestCallback) => number;
  cancel?: (handle: number) => void;
};

/**
 * Keep the composer autosized and the transcript pinned while either box changes.
 *
 * The scroll correction runs synchronously on every resize notification. An
 * inactive or occluded webview withholds animation frames, and `layout()` is
 * deliberately frame-independent (see `createChatScroll`); routing it through a
 * frame leaves the transcript unpinned exactly when the composer collapses on
 * submit. The coalesced frame is only for re-measuring the input once the new box
 * has settled, which is a post-layout read rather than a visibility requirement.
 */
export function observeComposerResize({ input, pane, getChatScroll, schedule = requestAnimationFrame, cancel = cancelAnimationFrame }: ComposerResizeOptions) {
  const resize = () => {
    resizeComposerInput(input);
    getChatScroll?.()?.layout();
  };
  resize();
  let frame = 0;
  if (typeof ResizeObserver === 'undefined') return () => { cancel(frame); };
  const observer = new ResizeObserver(() => {
    getChatScroll?.()?.layout();
    cancel(frame);
    frame = schedule(resize);
  });
  if (input.parentElement) observer.observe(input.parentElement);
  if (pane) {
    observer.observe(pane);
    const conversation = pane.querySelector<HTMLElement>(':scope > .piGuiConversation');
    if (conversation) observer.observe(conversation);
  }
  return () => {
    cancel(frame);
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
