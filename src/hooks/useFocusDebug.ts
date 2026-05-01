import { useEffect } from 'react';

export function useFocusDebug(state: {
  activeProjectId: string | null;
  activeTerminalId: string | null;
  activePaneId: string | null;
  maximizedPaneId: string | null;
  sidebarFocusedTerminalId: string | null;
}) {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (window.localStorage.getItem('stacks.debugFocus') !== '1') return;
    console.debug('[focus] workspace state', state);
  }, [state.activeProjectId, state.activeTerminalId, state.activePaneId, state.maximizedPaneId, state.sidebarFocusedTerminalId]);
}
