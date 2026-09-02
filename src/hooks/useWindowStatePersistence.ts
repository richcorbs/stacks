import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

type SavedWindowState = { width: number; height: number; x: number; y: number };

export function useWindowStatePersistence(delayMs = 300) {
  const stateRef = useRef<SavedWindowState | null>(null);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlistenResize: (() => void) | undefined;
    let unlistenMove: (() => void) | undefined;
    let timeout: number | undefined;

    const readCurrentState = async (): Promise<SavedWindowState> => {
      const [size, position, scaleFactor] = await Promise.all([
        appWindow.outerSize(),
        appWindow.outerPosition(),
        appWindow.scaleFactor(),
      ]);
      return {
        width: size.width / scaleFactor,
        height: size.height / scaleFactor,
        x: position.x / scaleFactor,
        y: position.y / scaleFactor,
      };
    };

    const save = (state: SavedWindowState) => {
      if (state.width < 780 || state.height < 500) return;
      invoke('save_window_state', {
        state: {
          width: Math.round(state.width),
          height: Math.round(state.height),
          x: Math.round(state.x),
          y: Math.round(state.y),
        },
      }).catch(console.error);
    };

    const persistSoon = () => {
      const state = stateRef.current;
      if (!state) return;
      if (timeout !== undefined) window.clearTimeout(timeout);
      timeout = window.setTimeout(() => save(state), delayMs);
    };

    readCurrentState().then((state) => { stateRef.current = state; }).catch(console.error);

    appWindow.onResized(() => {
      readCurrentState().then((state) => {
        stateRef.current = state;
        persistSoon();
      }).catch(console.error);
    }).then((fn) => { unlistenResize = fn; }).catch(console.error);

    appWindow.onMoved(() => {
      readCurrentState().then((state) => {
        stateRef.current = state;
        persistSoon();
      }).catch(console.error);
    }).then((fn) => { unlistenMove = fn; }).catch(console.error);

    return () => {
      unlistenResize?.();
      unlistenMove?.();
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [delayMs]);
}
