import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AppSettings, Store } from '../types';
import { resolveAppSettings, type ResolvedAppSettings } from '../settingsModel';

export function useAppBootstrap({
  setLoaded,
  setStore,
  setSidebarWidth,
  setAppSettings,
  selectTerminal,
  setActiveProjectId,
}: {
  setLoaded: (loaded: boolean) => void;
  setStore: React.Dispatch<React.SetStateAction<Store>>;
  setSidebarWidth: React.Dispatch<React.SetStateAction<number>>;
  setAppSettings: React.Dispatch<React.SetStateAction<ResolvedAppSettings>>;
  selectTerminal: (projectId: string, terminalId: string | null) => void;
  setActiveProjectId: (projectId: string | null) => void;
}) {
  useEffect(() => {
    Promise.all([
      invoke<Store>('load_store'),
      invoke<AppSettings>('load_settings').catch(() => null),
    ]).then(([loadedStore, settings]) => {
      setStore(loadedStore);
      if (settings?.sidebar_width) setSidebarWidth(Math.min(420, Math.max(180, settings.sidebar_width)));
      setAppSettings(resolveAppSettings(settings));
      const firstProject = loadedStore.projects[0];
      if (firstProject) selectTerminal(firstProject.id, null);
      else setActiveProjectId(null);
      setLoaded(true);
    }).catch((err) => {
      console.error(err);
      setLoaded(true);
    });
  }, []);
}
