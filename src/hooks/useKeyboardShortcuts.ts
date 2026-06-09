import { useEffect, useRef } from 'react';
import { handleMetaShortcutKeyDown } from '../keyboardShortcutRouter';
import type { ShortcutHandlers } from '../shortcutTypes';

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
