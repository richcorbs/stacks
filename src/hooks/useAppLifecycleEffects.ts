import type React from 'react';
import type { MaximizedWorkspaceIds, Store, ToastDetail } from '../types';
import type { ResolvedAppSettings } from '../settingsModel';
import { useDebouncedStoreSave } from './useDebouncedSave';
import { usePersistentAppSettings, usePersistentSidebarWidth } from './useSettingsPersistence';
import { useWindowStatePersistence } from './useWindowStatePersistence';
import { useAppBootstrap } from './useAppBootstrap';
import { useAppCloseRequest, useAppToastEvents } from './useAppWindowEvents';
import { useContextMenuDismissal } from './useContextMenuDismissal';
import { useTerminalCwd } from './useTerminalCwd';
import { useImageDropToTerminal } from './useImageDropToTerminal';
import { useFocusDebug } from './useFocusDebug';
import { useAppWindowFocusClass } from './useAppWindowFocusClass';
import type { ContextMenuState } from '../types';

export function useAppLifecycleEffects({
  loaded,
  store,
  sidebarWidth,
  appSettings,
  setLoaded,
  setStore,
  setSidebarWidth,
  setAppSettings,
  selectWorkspace,
  setActiveProjectId,
  activeProjectId,
  activeWorkspaceId,
  activeTerminalId,
  maximizedWorkspaceIds,
  sidebarFocusedWorkspaceId,
  setConfirmQuitOpen,
  setContextMenu,
  rememberTerminalCwd,
  showToast,
}: {
  loaded: boolean;
  store: Store;
  sidebarWidth: number;
  appSettings: ResolvedAppSettings;
  setLoaded: React.Dispatch<React.SetStateAction<boolean>>;
  setStore: React.Dispatch<React.SetStateAction<Store>>;
  setSidebarWidth: React.Dispatch<React.SetStateAction<number>>;
  setAppSettings: React.Dispatch<React.SetStateAction<ResolvedAppSettings>>;
  selectWorkspace: (projectId: string, workspaceId: string | null) => void;
  setActiveProjectId: React.Dispatch<React.SetStateAction<string | null>>;
  activeProjectId: string | null;
  activeWorkspaceId: string | null;
  activeTerminalId: string | null;
  maximizedWorkspaceIds: MaximizedWorkspaceIds;
  sidebarFocusedWorkspaceId: string | null;
  setConfirmQuitOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setContextMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>;
  rememberTerminalCwd: (terminalId: string, cwd: string) => void;
  showToast: (toast: string | ToastDetail) => void;
}) {
  useFocusDebug({ activeProjectId, activeWorkspaceId, activeTerminalId, maximizedWorkspaceIds, sidebarFocusedWorkspaceId });
  useAppWindowFocusClass();

  const saveStoreNow = useDebouncedStoreSave(loaded, store);
  usePersistentSidebarWidth(loaded, sidebarWidth);
  usePersistentAppSettings(loaded, appSettings);
  useWindowStatePersistence();
  useAppBootstrap({ setLoaded, setStore, setSidebarWidth, setAppSettings, selectWorkspace, setActiveProjectId });
  useAppToastEvents(showToast);
  useAppCloseRequest(appSettings.confirm_close, setConfirmQuitOpen);
  useContextMenuDismissal(setContextMenu);
  useTerminalCwd(activeTerminalId, rememberTerminalCwd, setStore);
  useImageDropToTerminal(activeTerminalId);

  return { saveStoreNow };
}
