import type { PaneSession } from './types';

const paneSessions = new Map<string, PaneSession>();

export function getPaneSession(paneId: string) {
  return paneSessions.get(paneId);
}

export function setPaneSession(paneId: string, session: PaneSession) {
  paneSessions.set(paneId, session);
}

export function disposePaneSession(paneId: string) {
  const session = paneSessions.get(paneId);
  if (!session) return;
  window.dispatchEvent(new CustomEvent('pane-running-changed', { detail: { paneId, running: false } }));
  session.resizeObserver?.disconnect();
  session.dataDisposable.dispose();
  session.unlistenData?.();
  session.unlistenExit?.();
  session.term.dispose();
  paneSessions.delete(paneId);
}

export function disposePaneSessions(paneIds: string[]) {
  paneIds.forEach(disposePaneSession);
}
