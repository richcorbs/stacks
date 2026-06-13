import { useEffect } from 'react';

export function useFocusDebug(state: {
  activeProjectId: string | null;
  activeWorkspaceId: string | null;
  activeTerminalId: string | null;
  maximizedWorkspaceId: string | null;
  sidebarFocusedWorkspaceId: string | null;
}) {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (window.localStorage.getItem('stacks.debugFocus') !== '1') return;
    console.debug('[focus] workspace state', state);
  }, [state.activeProjectId, state.activeWorkspaceId, state.activeTerminalId, state.maximizedWorkspaceId, state.sidebarFocusedWorkspaceId]);
}
