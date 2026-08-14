import { useEffect } from 'react';
import type { MaximizedWorkspaceIds } from '../types';

export function useFocusDebug(state: {
  activeProjectId: string | null;
  activeWorkspaceId: string | null;
  activeTerminalId: string | null;
  maximizedWorkspaceIds: MaximizedWorkspaceIds;
  sidebarFocusedWorkspaceId: string | null;
}) {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (window.localStorage.getItem('stacks.debugFocus') !== '1') return;
    console.debug('[focus] workspace state', state);
  }, [state.activeProjectId, state.activeWorkspaceId, state.activeTerminalId, state.maximizedWorkspaceIds, state.sidebarFocusedWorkspaceId]);
}
