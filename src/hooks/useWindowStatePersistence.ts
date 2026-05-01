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

    const persistSoon = () => {
      const state = stateRef.current;
      if (!state || state.width < 780 || state.height < 500) return;
      if (timeout !== undefined) window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        invoke('save_window_state', {
          state: {
            width: Math.round(state.width),
            height: Math.round(state.height),
            x: Math.round(state.x),
            y: Math.round(state.y),
          },
        }).catch(console.error);
      }, delayMs);
    };

    const loadCurrentState = async () => {
      const [size, position] = await Promise.all([
        appWindow.outerSize(),
        appWindow.outerPosition(),
      ]);
      stateRef.current = { width: size.width, height: size.height, x: position.x, y: position.y };
    };

    loadCurrentState().catch(console.error);

    appWindow.onResized(({ payload }) => {
      const current = stateRef.current;
      stateRef.current = {
        width: payload.width,
        height: payload.height,
        x: current?.x ?? 0,
        y: current?.y ?? 0,
      };
      persistSoon();
    }).then((fn) => { unlistenResize = fn; }).catch(console.error);

    appWindow.onMoved(({ payload }) => {
      const current = stateRef.current;
      stateRef.current = {
        width: current?.width ?? 1200,
        height: current?.height ?? 800,
        x: payload.x,
        y: payload.y,
      };
      persistSoon();
    }).then((fn) => { unlistenMove = fn; }).catch(console.error);

    return () => {
      unlistenResize?.();
      unlistenMove?.();
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [delayMs]);
}
