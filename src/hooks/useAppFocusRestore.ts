import { focusTerminalSession } from '../terminalSessionManager';

export function useAppFocusRestore(activeTerminalId: string | null) {
  function restoreActiveTerminalFocus(reason: string) {
    if (!activeTerminalId) return;
    const terminalId = activeTerminalId;
    const restore = (suffix: string) => {
      const focusReason = `${reason}${suffix}`;
      if (focusTerminalSession(terminalId, focusReason, { scrollToBottom: false })) return true;
      window.dispatchEvent(new CustomEvent('pane-focus-request', { detail: { terminalId, reason: focusReason } }));
      return false;
    };
    requestAnimationFrame(() => {
      if (restore('')) return;
      requestAnimationFrame(() => restore('-delayed'));
      window.setTimeout(() => restore('-retry'), 50);
    });
  }

  return { restoreActiveTerminalFocus };
}
