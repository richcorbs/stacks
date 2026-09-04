import { invoke } from '@tauri-apps/api/core';
import type { PendingPrCleanup, PrCleanupStage } from '../types';

export function loadPendingPrCleanup() {
  return invoke<PendingPrCleanup | null>('load_pending_pr_cleanup');
}

export async function savePendingPrCleanup(operation: PendingPrCleanup, stage: PrCleanupStage = operation.stage) {
  const next = { ...operation, stage };
  await invoke('save_pending_pr_cleanup', { operation: next });
  return next;
}

export function clearPendingPrCleanup() {
  return invoke('clear_pending_pr_cleanup');
}
