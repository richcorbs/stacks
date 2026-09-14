import { invoke } from '@tauri-apps/api/core';
import type { SplitNode } from './types';

export type ProjectDirectWorkState = {
  project_id: string;
  revision: number;
  split_layout: SplitNode;
  focused_pane_id: string | null;
  pane_ids: string[];
  created_at: number;
  updated_at: number;
};

export function loadOrCreateDirectWork(projectId: string) {
  return invoke<ProjectDirectWorkState>('project_direct_load_or_create', { projectId });
}

export function saveDirectWorkLayout(projectId: string, splitLayout: SplitNode, focusedPaneId: string | null, paneIds: string[], expectedRevision: number) {
  return invoke<ProjectDirectWorkState>('project_direct_save_layout', { projectId, splitLayout, focusedPaneId, paneIds, expectedRevision });
}
