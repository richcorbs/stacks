import { useEffect, useEffectEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { hasActiveConfirmation } from '../components/ConfirmationBoundary';
import { runShortcutAction } from '../shortcutActions';
import type { ShortcutAction, ShortcutHandlers } from '../shortcutTypes';

/**
 * Owns the native `menu-shortcut` subscription for native menu accelerators.
 *
 * The subscription is installed once. Handler and interaction-blocker identity
 * changes are read through an Effect Event, so a render that never commits can
 * never expose its handlers to a menu action and handler changes do not tear
 * down and recreate the native listener.
 */
export function useMenuShortcutListener(handlers: ShortcutHandlers, isInteractionBlocked: () => boolean) {
  const onMenuShortcut = useEffectEvent((action: ShortcutAction) => {
    if (isInteractionBlocked() || hasActiveConfirmation()) return;
    runShortcutAction(action, handlers);
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let pending: Promise<() => void> | undefined;
    try {
      pending = getCurrentWindow().listen<string>('menu-shortcut', (event) => {
        // A native event can race the asynchronous unlisten during teardown.
        if (disposed) return;
        onMenuShortcut(event.payload as ShortcutAction);
      });
    } catch (error) {
      console.error(error);
      return;
    }
    pending.then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch(console.error);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
