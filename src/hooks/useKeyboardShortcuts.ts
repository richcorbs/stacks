import { useEffect, useEffectEvent } from 'react';
import { hasActiveConfirmation } from '../components/ConfirmationBoundary';
import { handleMetaShortcutKeyDown } from '../keyboardShortcutRouter';
import type { ShortcutHandlers } from '../shortcutTypes';

export function useKeyboardShortcuts(handlers: ShortcutHandlers, isInteractionBlocked: () => boolean = () => false) {
  // These callbacks belong to the subscription, but read the latest committed
  // handlers/blocker without making their identities listener dependencies.
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (isInteractionBlocked()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!hasActiveConfirmation()) handleMetaShortcutKeyDown(event, handlers);
  });
  const onKeyUp = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === 'Meta') handlers.setMetaKeyDown(false);
  });
  const onBlur = useEffectEvent(() => handlers.setMetaKeyDown(false));

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
}
