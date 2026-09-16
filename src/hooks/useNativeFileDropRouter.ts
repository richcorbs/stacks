import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { physicalToCssPoint, piPaneAtPoint, terminalPaneAtPoint } from '../fileDropRouting';
import { deliverPiFileDrop } from '../pi/fileDropBroker';

const encoder = new TextEncoder();
const imageExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.svg', '.avif',
]);

function hasExtension(path: string, extensions: Set<string>) {
  const lower = path.toLowerCase();
  return [...extensions].some((extension) => lower.endsWith(extension));
}

function shellEscapePath(path: string) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Owns the one native Tauri drag/drop listener and routes by the pane under the pointer. */
export function useNativeFileDropRouter() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let highlighted: HTMLElement | null = null;
    const preventBrowserDrop = (event: DragEvent) => event.preventDefault();
    const setHighlighted = (pane: HTMLElement | null) => {
      if (highlighted === pane) return;
      highlighted?.classList.remove('piFileDropTarget');
      highlighted = pane;
      highlighted?.classList.add('piFileDropTarget');
    };
    const toast = (message: string) => window.dispatchEvent(new CustomEvent('app-toast', { detail: { message } }));

    window.addEventListener('dragover', preventBrowserDrop);
    window.addEventListener('drop', preventBrowserDrop);

    getCurrentWindow().scaleFactor().then((scaleFactor) => getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === 'leave') {
        setHighlighted(null);
        return;
      }
      const point = physicalToCssPoint(payload.position, scaleFactor);
      const piPane = piPaneAtPoint(document, point);
      if (payload.type === 'enter' || payload.type === 'over') {
        setHighlighted(piPane);
        return;
      }
      setHighlighted(null);
      if (payload.type !== 'drop') return;
      if (piPane) {
        const paneId = piPane.dataset.piPaneId;
        if (!paneId || payload.paths.length === 0 || !deliverPiFileDrop(paneId, payload.paths)) {
          toast('Could not insert dropped files into this Agent pane');
        }
        return;
      }

      // Preserve shell behavior: supported image paths are inserted into the terminal under the pointer.
      const terminalId = terminalPaneAtPoint(document, point)?.dataset.terminalPaneId;
      if (!terminalId) {
        toast('Drop files onto an Agent pane or terminal');
        return;
      }
      const imagePaths = payload.paths.filter((path) => hasExtension(path, imageExtensions));
      if (imagePaths.length === 0) {
        toast('Only image files can be dropped into a shell terminal');
        return;
      }
      const text = imagePaths.map(shellEscapePath).join(' ');
      invoke('write_pty', { terminalId, data: Array.from(encoder.encode(text)) })
        .catch((error) => toast(`Could not insert dropped files: ${String(error)}`));
    })).then((dispose) => {
      if (cancelled) dispose(); else unlisten = dispose;
    }).catch((error) => toast(`File drop is unavailable: ${String(error)}`));

    return () => {
      cancelled = true;
      unlisten?.();
      setHighlighted(null);
      window.removeEventListener('dragover', preventBrowserDrop);
      window.removeEventListener('drop', preventBrowserDrop);
    };
  }, []);
}
