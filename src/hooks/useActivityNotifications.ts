import { useEffect, useRef } from 'react';
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
  const permissionRef = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    if (!enabled) {
      permissionRef.current = null;
      return;
    }
    const permission = ensureNotificationPermission();
    permissionRef.current = permission;
    permission
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
      const sendNotification = async () => {
        const granted = await (permissionRef.current ?? ensureNotificationPermission());
        if (!granted) return;
        await invoke<boolean>('notify_attention', {
          workspaceActive: activeWorkspaceId === event.workspaceId,
          force: false,
          title: notification.title,
          body: notification.body,
        });
      };
      sendNotification().catch((error) => console.warn('Could not send activity notification', error));
    };

    window.addEventListener('app-attention', handleAttention);
    return () => window.removeEventListener('app-attention', handleAttention);
  }, [activeWorkspaceId, enabled, store]);
}
