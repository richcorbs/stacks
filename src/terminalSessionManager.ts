import type { TerminalSession } from './types';

const terminalSessions = new Map<string, TerminalSession>();
const pendingScrollAfterFitTerminalIds = new Set<string>();
const stickToBottomUntilBySession = new WeakMap<TerminalSession, number>();

function debugFocus(message: string, detail?: unknown) {
  if (!import.meta.env.DEV) return;
  if (window.localStorage.getItem('stacks.debugFocus') !== '1') return;
  console.debug(`[focus] ${message}`, detail ?? '');
}

export function getTerminalSession(terminalId: string) {
  return terminalSessions.get(terminalId);
}

export function setTerminalSession(terminalId: string, session: TerminalSession) {
  terminalSessions.set(terminalId, session);
}

export function jumpSessionToBottom(session: TerminalSession) {
  const bottomLine = Math.max(0, session.term.buffer.active.length - session.term.rows);
  session.term.scrollToLine(bottomLine);
}

export function isSessionAtBottom(session: TerminalSession) {
  const buffer = session.term.buffer.active;
  return buffer.viewportY >= buffer.baseY;
}

export function fitSessionPreservingBottom(session: TerminalSession) {
  const buffer = session.term.buffer.active;
  const previousViewportY = buffer.viewportY;
  const wasAtBottom = isSessionAtBottom(session);
  const now = Date.now();
  const isStickyBottomResize = (stickToBottomUntilBySession.get(session) ?? 0) > now;
  const shouldStickToBottom = wasAtBottom || isStickyBottomResize;

  if (shouldStickToBottom) {
    // Window resize/maximize can trigger several fit/PTY-resize/reflow passes.
    // The first pass starts at the bottom, but intermediate passes may briefly
    // report as scrolled back. Keep treating the terminal as bottom-pinned for a
    // short resize window so later passes do not preserve that transient offset.
    stickToBottomUntilBySession.set(session, now + 750);
  }

  session.fit.fit();

  if (shouldStickToBottom) {
    // Resizing the PTY can make shells/full-screen apps redraw after xterm's
    // synchronous fit. Keep bottom-pinned terminals pinned through that delayed
    // output instead of only jumping once before the resize settles.
    jumpSessionToBottom(session);
    window.requestAnimationFrame(() => jumpSessionToBottom(session));
    window.setTimeout(() => jumpSessionToBottom(session), 50);
    window.setTimeout(() => jumpSessionToBottom(session), 150);
    window.setTimeout(() => jumpSessionToBottom(session), 300);
    window.setTimeout(() => jumpSessionToBottom(session), 600);
  } else {
    window.requestAnimationFrame(() => session.term.scrollToLine(previousViewportY));
  }

  return shouldStickToBottom;
}

export function focusTerminalSession(terminalId: string, reason: string, options: { scrollToBottom?: boolean } = {}) {
  const session = terminalSessions.get(terminalId);
  if (!session) {
    debugFocus('focus skipped; no session', { terminalId, reason });
    return false;
  }
  debugFocus('focus terminal session', { terminalId, reason, options });
  const wasAtBottom = fitSessionPreservingBottom(session);
  if (options.scrollToBottom || wasAtBottom) jumpSessionToBottom(session);
  session.term.focus();
  return true;
}

export function scrollTerminalSessionToBottom(terminalId: string) {
  const session = terminalSessions.get(terminalId);
  if (!session) return false;
  debugFocus('jump terminal to bottom', { terminalId });
  jumpSessionToBottom(session);
  return true;
}

export function isTerminalSessionAtBottom(terminalId: string) {
  const session = terminalSessions.get(terminalId);
  if (!session) return true;
  return isSessionAtBottom(session);
}

export function requestTerminalSessionsScrollToBottomAfterFit(terminalIds: string[]) {
  terminalIds.forEach((terminalId) => pendingScrollAfterFitTerminalIds.add(terminalId));

  // Fallback in case a terminal's ResizeObserver does not fire for the layout change.
  window.setTimeout(() => terminalIds.forEach(scrollTerminalSessionToBottom), 100);
  window.setTimeout(() => terminalIds.forEach(scrollTerminalSessionToBottom), 250);
}

export function consumeTerminalSessionScrollToBottomAfterFit(terminalId: string) {
  const pending = pendingScrollAfterFitTerminalIds.delete(terminalId);
  if (pending) debugFocus('consume scroll after fit', { terminalId });
  return pending;
}

export function disposeTerminalSession(terminalId: string) {
  const session = terminalSessions.get(terminalId);
  if (!session) return;
  window.dispatchEvent(new CustomEvent('terminal-running-changed', { detail: { terminalId, running: false } }));
  session.resizeObserver?.disconnect();
  session.dataDisposable.dispose();
  session.selectionDisposable.dispose();
  session.unlistenData?.();
  session.unlistenExit?.();
  if (session.outputActivityFrame !== null) window.cancelAnimationFrame(session.outputActivityFrame);
  session.outputQueue = [];
  session.outputQueuedChars = 0;
  session.term.dispose();
  terminalSessions.delete(terminalId);
}

export function disposeTerminalSessions(terminalIds: string[]) {
  terminalIds.forEach(disposeTerminalSession);
}
