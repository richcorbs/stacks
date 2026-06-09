import { useEffect } from 'react';
import type React from 'react';
import type { ContextMenuState } from '../types';

export function useContextMenuDismissal(setContextMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>) {
  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
    };
  }, [setContextMenu]);
}
