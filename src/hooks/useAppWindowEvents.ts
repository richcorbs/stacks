import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ToastDetail } from '../types';

export function useAppToastEvents(showToast: (toast: string | ToastDetail) => void) {
  useEffect(() => {
    const onToast = (event: Event) => {
      showToast((event as CustomEvent<ToastDetail>).detail);
    };
    const unlistenPromise = getCurrentWindow().listen<string>('app-toast', (event) => showToast(event.payload));
    window.addEventListener('app-toast', onToast);
    return () => {
      window.removeEventListener('app-toast', onToast);
      unlistenPromise.then((unlisten) => unlisten()).catch(console.error);
    };
  }, [showToast]);
}

export function useAppCloseRequest(confirmClose: boolean, setConfirmQuitOpen: (open: boolean) => void) {
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    appWindow.onCloseRequested((event) => {
      event.preventDefault();
      invoke('save_current_window_state').catch(console.error);
      if (confirmClose) {
        setConfirmQuitOpen(true);
      } else {
        invoke('quit_app').catch(console.error);
      }
    }).then((fn) => { unlisten = fn; }).catch(console.error);
    return () => unlisten?.();
  }, [confirmClose]);
}
