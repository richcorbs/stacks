import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Store } from '../types';

export function useDebouncedStoreSave(loaded: boolean, store: Store, delayMs = 250) {
  useEffect(() => {
    if (!loaded) return;
    const timeout = window.setTimeout(() => {
      invoke('save_store', { store }).catch(console.error);
    }, delayMs);
    return () => window.clearTimeout(timeout);
  }, [loaded, store, delayMs]);
}

export function usePersistentSidebarWidth(sidebarWidth: number) {
  useEffect(() => {
    window.localStorage.setItem('stacks.sidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);
}
