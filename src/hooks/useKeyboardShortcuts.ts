import { useEffect, useRef } from 'react';
import { handleMetaShortcutKeyDown } from '../keyboardShortcutRouter';
import type { ShortcutHandlers } from '../shortcutTypes';

export function useKeyboardShortcuts(handlers: ShortcutHandlers, isInteractionBlocked: () => boolean = () => false) {
  const handlersRef = useRef(handlers);
  const blockedRef = useRef(isInteractionBlocked);
  handlersRef.current = handlers;
  blockedRef.current = isInteractionBlocked;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (blockedRef.current()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      handleMetaShortcutKeyDown(event, handlersRef.current);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Meta') handlersRef.current.setMetaKeyDown(false);
    };
    const onBlur = () => handlersRef.current.setMetaKeyDown(false);
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
