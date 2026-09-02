import { useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Store } from '../types';

export type SaveStoreNow = (store: Store) => Promise<void>;

export function useDebouncedStoreSave(loaded: boolean, store: Store, delayMs = 250): SaveStoreNow {
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  const saveStoreNow = useCallback<SaveStoreNow>((nextStore) => {
    const save = saveChainRef.current
      .catch(() => undefined)
      .then(() => invoke<void>('save_store', { store: nextStore }));
    saveChainRef.current = save;
    return save;
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const timeout = window.setTimeout(() => {
      saveStoreNow(store).catch(console.error);
    }, delayMs);
    return () => window.clearTimeout(timeout);
  }, [loaded, store, delayMs, saveStoreNow]);

  return saveStoreNow;
}
