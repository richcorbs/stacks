import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';

const encoder = new TextEncoder();
const imageExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.svg', '.avif',
]);
const piImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function hasExtension(path: string, extensions: Set<string>) {
  const lower = path.toLowerCase();
  return [...extensions].some((extension) => lower.endsWith(extension));
}

function shellEscapePath(path: string) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

export function useImageDropToTerminal(activeTerminalId: string | null, activePaneKind: 'terminal' | 'pi') {
  const activePaneRef = useRef({ id: activeTerminalId, kind: activePaneKind });
  activePaneRef.current = { id: activeTerminalId, kind: activePaneKind };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const preventBrowserDrop = (event: DragEvent) => {
      event.preventDefault();
    };

    window.addEventListener('dragover', preventBrowserDrop);
    window.addEventListener('drop', preventBrowserDrop);

    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop') return;
      const pane = activePaneRef.current;
      if (!pane.id) return;

      const imagePaths = event.payload.paths.filter((path) => hasExtension(path, pane.kind === 'pi' ? piImageExtensions : imageExtensions));
      if (imagePaths.length === 0) return;
      if (pane.kind === 'pi') {
        window.dispatchEvent(new CustomEvent('pi-image-drop', { detail: { paneId: pane.id, paths: imagePaths } }));
        return;
      }

      const text = imagePaths.map(shellEscapePath).join(' ');
      invoke('write_pty', { terminalId: pane.id, data: Array.from(encoder.encode(text)) }).catch(console.error);
    }).then((fn) => { unlisten = fn; }).catch(console.error);

    return () => {
      unlisten?.();
      window.removeEventListener('dragover', preventBrowserDrop);
      window.removeEventListener('drop', preventBrowserDrop);
    };
  }, []);
}
