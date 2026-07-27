import { useEffect, useRef, type MutableRefObject } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import type { Terminal } from '@xterm/xterm';

function trimTrailingHorizontalWhitespace(text: string) {
  return text.replace(/[^\S\r\n]+$/gm, '');
}

export function useTerminalSelectionCopy(termRef: MutableRefObject<Terminal | null>, enabled = true) {
  const selectionMouseDownRef = useRef(false);

  useEffect(() => {
    const copySelectionToClipboard = () => {
      window.setTimeout(() => {
        const term = termRef.current;
        if (!term?.hasSelection()) return;
        const selection = trimTrailingHorizontalWhitespace(term.getSelection());
        if (!selection) return;
        writeText(selection)
          .then(() => {
            term.clearSelection();
            const rect = term.element?.closest('.terminal')?.getBoundingClientRect();
            window.dispatchEvent(new CustomEvent('app-toast', {
              detail: {
                message: 'Copied to clipboard',
                x: rect ? rect.left + rect.width / 2 : undefined,
                y: rect ? rect.top + rect.height / 2 : undefined,
              },
            }));
          })
          .catch(console.error);
      }, 0);
    };

    const onMouseUp = () => {
      if (!enabled || !selectionMouseDownRef.current) return;
      selectionMouseDownRef.current = false;
      copySelectionToClipboard();
    };

    window.addEventListener('mouseup', onMouseUp);
    return () => window.removeEventListener('mouseup', onMouseUp);
  }, [termRef, enabled]);

  return {
    beginSelectionCopy: () => {
      if (enabled) selectionMouseDownRef.current = true;
    },
  };
}
