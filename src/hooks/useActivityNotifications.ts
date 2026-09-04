import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  attentionNotification,
  ensureNotificationPermission,
  type AttentionEvent,
} from '../activityNotifications';
import type { Store } from '../types';

export function useActivityNotifications({
  enabled,
  store,
  activeWorkspaceId,
}: {
  enabled: boolean;
  store: Store;
  activeWorkspaceId: string | null;
}) {
  useEffect(() => {
    if (!enabled) return;
    ensureNotificationPermission()
      .then((granted) => {
        if (!granted) console.warn('Activity notifications are enabled but macOS permission was not granted');
      })
      .catch((error) => console.warn('Could not request notification permission', error));
  }, [enabled]);

  useEffect(() => {
    const handleAttention = (rawEvent: Event) => {
      const event = (rawEvent as CustomEvent<AttentionEvent>).detail;
      if (!event || !enabled) return;
      const notification = attentionNotification(event, store);
      invoke<boolean>('notify_attention', {
        workspaceActive: activeWorkspaceId === event.workspaceId,
        force: false,
        title: notification.title,
        body: notification.body,
      }).catch((error) => {
        console.warn('Could not send activity notification', error);
        window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: `Could not notify: ${String(error)}` } }));
      });
    };

    window.addEventListener('app-attention', handleAttention);
    return () => window.removeEventListener('app-attention', handleAttention);
  }, [activeWorkspaceId, enabled, store]);
}
