import { useState } from 'react';
import type { Store } from '../types';
import { loadSidebarWidth } from '../utils';
import { DEFAULT_APP_SETTINGS, type ResolvedAppSettings } from '../settingsModel';
import { useWorkspaceState } from './useWorkspaceState';
import { useAppOverlayState } from './useAppOverlayState';
import { useToast } from './useToast';
import { useTerminalActivity } from './useTerminalActivity';

export function useAppStateBundle() {
  const [loaded, setLoaded] = useState(false);
  const [store, setStore] = useState<Store>({ projects: [] });
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [appSettings, setAppSettings] = useState<ResolvedAppSettings>(DEFAULT_APP_SETTINGS);
  const [metaKeyDown, setMetaKeyDown] = useState(false);
  const { state: workspace, actions: workspaceActions } = useWorkspaceState();
  const overlayState = useAppOverlayState();
  const toastState = useToast();
  const terminalActivity = useTerminalActivity(workspace.activeWorkspaceId);

  return {
    loaded,
    setLoaded,
    store,
    setStore,
    sidebarWidth,
    setSidebarWidth,
    sidebarVisible,
    setSidebarVisible,
    appSettings,
    setAppSettings,
    metaKeyDown,
    setMetaKeyDown,
    workspace,
    workspaceActions,
    overlayState,
    toastState,
    terminalActivity,
  };
}
