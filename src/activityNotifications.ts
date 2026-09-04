import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import type { Store } from './types';

export type AttentionEvent = {
  kind: 'pi-complete' | 'process-exit';
  workspaceId: string;
  terminalId: string;
};

export function attentionNotification(event: AttentionEvent, store: Store) {
  const project = store.projects.find((candidate) => candidate.workspaces.some((workspace) => workspace.id === event.workspaceId));
  const workspace = project?.workspaces.find((candidate) => candidate.id === event.workspaceId);
  const location = [project?.name, workspace?.name].filter(Boolean).join(' — ') || 'Background workspace';
  return {
    title: event.kind === 'pi-complete' ? 'Pi finished' : 'Terminal exited',
    body: location,
  };
}

export async function ensureNotificationPermission() {
  if (await isPermissionGranted()) return true;
  return await requestPermission() === 'granted';
}

