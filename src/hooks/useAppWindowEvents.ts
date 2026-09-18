import { useEffect } from 'react';
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

export function useAppCloseRequest(requestQuit: () => void) {
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    appWindow.onCloseRequested((event) => {
      event.preventDefault();
      requestQuit();
    }).then((fn) => { unlisten = fn; }).catch(console.error);
    return () => unlisten?.();
  }, [requestQuit]);
}
