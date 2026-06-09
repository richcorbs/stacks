import type React from 'react';
import type { Store } from '../types';
import type { ResolvedAppSettings } from '../settingsModel';
import { useDebouncedStoreSave } from './useDebouncedSave';
import { usePersistentAppSettings, usePersistentSidebarWidth } from './useSettingsPersistence';
import { useWindowStatePersistence } from './useWindowStatePersistence';
import { useAppBootstrap } from './useAppBootstrap';
import { useAppCloseRequest, useAppToastEvents } from './useAppWindowEvents';
import { useContextMenuDismissal } from './useContextMenuDismissal';
import { usePaneCwd } from './usePaneCwd';
import { useImageDropToTerminal } from './useImageDropToTerminal';
import { useFocusDebug } from './useFocusDebug';
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
  selectTerminal,
  setActiveProjectId,
  activeProjectId,
  activeTerminalId,
  activePaneId,
  maximizedTerminalId,
  sidebarFocusedTerminalId,
  setConfirmQuitOpen,
  setContextMenu,
  rememberPaneCwd,
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
  selectTerminal: (projectId: string, terminalId: string | null) => void;
  setActiveProjectId: React.Dispatch<React.SetStateAction<string | null>>;
  activeProjectId: string | null;
  activeTerminalId: string | null;
  activePaneId: string | null;
  maximizedTerminalId: string | null;
  sidebarFocusedTerminalId: string | null;
  setConfirmQuitOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setContextMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>;
  rememberPaneCwd: (paneId: string, cwd: string) => void;
  showToast: (message: string) => void;
}) {
  useFocusDebug({ activeProjectId, activeTerminalId, activePaneId, maximizedTerminalId, sidebarFocusedTerminalId });

  useDebouncedStoreSave(loaded, store);
  usePersistentSidebarWidth(loaded, sidebarWidth);
  usePersistentAppSettings(loaded, appSettings);
  useWindowStatePersistence();
  useAppBootstrap({ setLoaded, setStore, setSidebarWidth, setAppSettings, selectTerminal, setActiveProjectId });
  useAppToastEvents(showToast);
  useAppCloseRequest(appSettings.confirm_close, setConfirmQuitOpen);
  useContextMenuDismissal(setContextMenu);
  usePaneCwd(activePaneId, rememberPaneCwd, setStore);
  useImageDropToTerminal(activePaneId);
}
