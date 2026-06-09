import { invoke } from '@tauri-apps/api/core';
import type { PaneSession } from './types';
import { consumePaneSessionScrollToBottomAfterFit, fitSessionPreservingBottom, jumpSessionToBottom } from './terminalSessionManager';
import { safeTermSize } from './terminalSizing';

export function attachPaneResizeObserver({
  session,
  host,
  paneId,
  visible,
}: {
  session: PaneSession;
  host: HTMLElement;
  paneId: string;
  visible: boolean;
}) {
  const resizePtyToXterm = () => {
    const wasAtBottom = fitSessionPreservingBottom(session);
    const shouldScrollToBottom = consumePaneSessionScrollToBottomAfterFit(paneId) || wasAtBottom;
    const size = safeTermSize(session.term);
    if (session.spawned && (!session.lastPtySize || session.lastPtySize.cols !== size.cols || session.lastPtySize.rows !== size.rows)) {
      session.lastPtySize = size;
      invoke('resize_pty', { paneId, cols: size.cols, rows: size.rows }).catch(() => {});
    }
    if (shouldScrollToBottom) {
      requestAnimationFrame(() => jumpSessionToBottom(session));
    }
  };

  session.resizeObserver?.disconnect();
  session.resizeObserver = new ResizeObserver(resizePtyToXterm);
  session.resizeObserver.observe(host);
  if (visible) window.addEventListener('resize', resizePtyToXterm);
  requestAnimationFrame(resizePtyToXterm);

  return () => {
    window.removeEventListener('resize', resizePtyToXterm);
    session.resizeObserver?.disconnect();
    session.resizeObserver = undefined;
  };
}
