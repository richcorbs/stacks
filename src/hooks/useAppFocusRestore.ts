import { focusTerminalSession } from '../terminalSessionManager';

export function useAppFocusRestore(activeTerminalId: string | null) {
  function restoreActiveTerminalFocus(reason: string) {
    if (!activeTerminalId) return;
    const terminalId = activeTerminalId;
    const restore = (suffix: string) => focusTerminalSession(terminalId, `${reason}${suffix}`, { scrollToBottom: false });
    requestAnimationFrame(() => {
      if (restore('')) return;
      requestAnimationFrame(() => restore('-delayed'));
      window.setTimeout(() => restore('-retry'), 50);
    });
  }

  return { restoreActiveTerminalFocus };
}
