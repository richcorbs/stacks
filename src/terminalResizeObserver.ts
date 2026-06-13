import { invoke } from '@tauri-apps/api/core';
import type { TerminalSession } from './types';
import { consumeTerminalSessionScrollToBottomAfterFit, fitSessionPreservingBottom, jumpSessionToBottom } from './terminalSessionManager';
import { safeTermSize } from './terminalSizing';

export function attachTerminalResizeObserver({
  session,
  host,
  terminalId,
  visible,
}: {
  session: TerminalSession;
  host: HTMLElement;
  terminalId: string;
  visible: boolean;
}) {
  const resizePtyToXterm = () => {
    const wasAtBottom = fitSessionPreservingBottom(session);
    const shouldScrollToBottom = consumeTerminalSessionScrollToBottomAfterFit(terminalId) || wasAtBottom;
    const size = safeTermSize(session.term);
    if (session.spawned && (!session.lastPtySize || session.lastPtySize.cols !== size.cols || session.lastPtySize.rows !== size.rows)) {
      session.lastPtySize = size;
      invoke('resize_pty', { terminalId, cols: size.cols, rows: size.rows }).catch(() => {});
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
