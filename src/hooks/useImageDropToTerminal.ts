import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';

const encoder = new TextEncoder();
const imageExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.svg', '.avif',
]);

function isImagePath(path: string) {
  const lower = path.toLowerCase();
  return [...imageExtensions].some((extension) => lower.endsWith(extension));
}

function shellEscapePath(path: string) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

export function useImageDropToTerminal(activeTerminalId: string | null) {
  const activeTerminalIdRef = useRef(activeTerminalId);
  activeTerminalIdRef.current = activeTerminalId;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const preventBrowserDrop = (event: DragEvent) => {
      event.preventDefault();
    };

    window.addEventListener('dragover', preventBrowserDrop);
    window.addEventListener('drop', preventBrowserDrop);

    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop') return;
      const terminalId = activeTerminalIdRef.current;
      if (!terminalId) return;

      const imagePaths = event.payload.paths.filter(isImagePath);
      if (imagePaths.length === 0) return;

      const text = imagePaths.map(shellEscapePath).join(' ');
      invoke('write_pty', { terminalId, data: Array.from(encoder.encode(text)) }).catch(console.error);
    }).then((fn) => { unlisten = fn; }).catch(console.error);

    return () => {
      unlisten?.();
      window.removeEventListener('dragover', preventBrowserDrop);
      window.removeEventListener('drop', preventBrowserDrop);
    };
  }, []);
}
