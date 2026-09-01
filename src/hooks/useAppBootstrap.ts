import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AppSettings, Store } from '../types';
import { resolveAppSettings, type ResolvedAppSettings } from '../settingsModel';

export function useAppBootstrap({
  setLoaded,
  setStore,
  setSidebarWidth,
  setAppSettings,
  selectWorkspace,
  setActiveProjectId,
  setFocusedTerminalByWorkspaceId,
  setMaximizedWorkspaceIds,
}: {
  setLoaded: (loaded: boolean) => void;
  setStore: React.Dispatch<React.SetStateAction<Store>>;
  setSidebarWidth: React.Dispatch<React.SetStateAction<number>>;
  setAppSettings: React.Dispatch<React.SetStateAction<ResolvedAppSettings>>;
  selectWorkspace: (projectId: string, workspaceId: string | null) => void;
  setActiveProjectId: (projectId: string | null) => void;
  setFocusedTerminalByWorkspaceId: (focused: Record<string, string>) => void;
  setMaximizedWorkspaceIds: (maximized: Record<string, boolean>) => void;
}) {
  useEffect(() => {
    Promise.all([
      invoke<Store>('load_store'),
      invoke<AppSettings>('load_settings').catch(() => null),
    ]).then(([loadedStore, settings]) => {
      setStore(loadedStore);
      if (settings?.sidebar_width) setSidebarWidth(Math.min(420, Math.max(180, settings.sidebar_width)));
      setAppSettings(resolveAppSettings(settings));
      const focused = settings?.focused_terminal_by_workspace_id ?? {};
      setFocusedTerminalByWorkspaceId(focused);
      setMaximizedWorkspaceIds(settings?.maximized_workspace_ids ?? {});
      const restored = restoredWorkspaceSelection(loadedStore, settings);
      if (restored.projectId) selectWorkspace(restored.projectId, restored.workspaceId);
      else setActiveProjectId(null);
      setLoaded(true);
    }).catch((err) => {
      console.error(err);
      setLoaded(true);
    });
  }, []);
}

export function restoredWorkspaceSelection(store: Store, settings: AppSettings | null) {
  const savedProject = settings?.active_project_id
    ? store.projects.find((project) => project.id === settings.active_project_id)
    : null;
  const project = savedProject ?? store.projects[0] ?? null;
  const savedWorkspace = project && settings?.active_workspace_id
    ? project.workspaces.find((workspace) => workspace.id === settings.active_workspace_id)
    : null;
  return { projectId: project?.id ?? null, workspaceId: savedWorkspace?.id ?? null };
}
