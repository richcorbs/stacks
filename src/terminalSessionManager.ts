import type { PaneSession } from './types';

const paneSessions = new Map<string, PaneSession>();
const pendingScrollAfterFitPaneIds = new Set<string>();

function debugFocus(message: string, detail?: unknown) {
  if (!import.meta.env.DEV) return;
  if (window.localStorage.getItem('stacks.debugFocus') !== '1') return;
  console.debug(`[focus] ${message}`, detail ?? '');
}

export function getPaneSession(paneId: string) {
  return paneSessions.get(paneId);
}

export function setPaneSession(paneId: string, session: PaneSession) {
  paneSessions.set(paneId, session);
}

export function jumpSessionToBottom(session: PaneSession) {
  const bottomLine = Math.max(0, session.term.buffer.active.length - session.term.rows);
  session.term.scrollToLine(bottomLine);
}

export function isSessionAtBottom(session: PaneSession) {
  const buffer = session.term.buffer.active;
  return buffer.viewportY >= buffer.baseY;
}

export function fitSessionPreservingBottom(session: PaneSession) {
  const wasAtBottom = isSessionAtBottom(session);
  session.fit.fit();
  if (wasAtBottom) {
    window.requestAnimationFrame(() => jumpSessionToBottom(session));
  }
  return wasAtBottom;
}

export function focusPaneSession(paneId: string, reason: string, options: { scrollToBottom?: boolean } = {}) {
  const session = paneSessions.get(paneId);
  if (!session) {
    debugFocus('focus skipped; no session', { paneId, reason });
    return false;
  }
  debugFocus('focus pane session', { paneId, reason, options });
  const wasAtBottom = fitSessionPreservingBottom(session);
  if (options.scrollToBottom || wasAtBottom) jumpSessionToBottom(session);
  session.term.focus();
  return true;
}

export function scrollPaneSessionToBottom(paneId: string) {
  const session = paneSessions.get(paneId);
  if (!session) return false;
  debugFocus('jump pane to bottom', { paneId });
  jumpSessionToBottom(session);
  return true;
}

export function isPaneSessionAtBottom(paneId: string) {
  const session = paneSessions.get(paneId);
  if (!session) return true;
  return isSessionAtBottom(session);
}

export function requestPaneSessionsScrollToBottomAfterFit(paneIds: string[]) {
  paneIds.forEach((paneId) => pendingScrollAfterFitPaneIds.add(paneId));

  // Fallback in case a pane's ResizeObserver does not fire for the layout change.
  window.setTimeout(() => paneIds.forEach(scrollPaneSessionToBottom), 100);
  window.setTimeout(() => paneIds.forEach(scrollPaneSessionToBottom), 250);
}

export function consumePaneSessionScrollToBottomAfterFit(paneId: string) {
  const pending = pendingScrollAfterFitPaneIds.delete(paneId);
  if (pending) debugFocus('consume scroll after fit', { paneId });
  return pending;
}

export function disposePaneSession(paneId: string) {
  const session = paneSessions.get(paneId);
  if (!session) return;
  window.dispatchEvent(new CustomEvent('pane-running-changed', { detail: { paneId, running: false } }));
  session.resizeObserver?.disconnect();
  session.dataDisposable.dispose();
  session.selectionDisposable.dispose();
  session.unlistenData?.();
  session.unlistenExit?.();
  session.term.dispose();
  paneSessions.delete(paneId);
}

export function disposePaneSessions(paneIds: string[]) {
  paneIds.forEach(disposePaneSession);
}
