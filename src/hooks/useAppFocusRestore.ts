import { focusPaneSession } from '../terminalSessionManager';

export function useAppFocusRestore(activePaneId: string | null) {
  function restoreActivePaneFocus(reason: string) {
    if (!activePaneId) return;
    const paneId = activePaneId;
    const restore = (suffix: string) => focusPaneSession(paneId, `${reason}${suffix}`, { scrollToBottom: false });
    requestAnimationFrame(() => {
      if (restore('')) return;
      requestAnimationFrame(() => restore('-delayed'));
      window.setTimeout(() => restore('-retry'), 50);
    });
  }

  return { restoreActivePaneFocus };
}
