import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ToastDetail } from '../types';
import { applicationEvents } from '../applicationEvents';

export function useAppToastEvents(showToast: (toast: string | ToastDetail, durationMs?: number) => void) {
  useEffect(() => {
    const unsubscribe = applicationEvents.subscribe('toast', (toast) => showToast(toast, toast.duration));
    const unlistenPromise = getCurrentWindow().listen<string>('app-toast', (event) => {
      applicationEvents.publish('toast', { message: event.payload });
    });
    return () => {
      unsubscribe();
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
