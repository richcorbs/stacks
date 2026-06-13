import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { fitSessionPreservingBottom, getTerminalSession, isSessionAtBottom, jumpSessionToBottom } from '../terminalSessionManager';
import { safeTermSize } from '../terminalSizing';

export function useTerminalOptions({
  terminalId,
  terminalFontSize,
  terminalFontFamily,
  terminalScrollback,
}: {
  terminalId: string;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
}) {
  useEffect(() => {
    const session = getTerminalSession(terminalId);
    if (!session) return;
    const fontSizeChanged = session.term.options.fontSize !== terminalFontSize;
    const fontFamilyChanged = session.term.options.fontFamily !== terminalFontFamily;
    const scrollbackChanged = session.term.options.scrollback !== terminalScrollback;
    if (!fontSizeChanged && !fontFamilyChanged && !scrollbackChanged) return;
    const wasAtBottom = isSessionAtBottom(session);
    session.term.options.fontSize = terminalFontSize;
    session.term.options.fontFamily = terminalFontFamily;
    session.term.options.scrollback = terminalScrollback;
    requestAnimationFrame(() => {
      fitSessionPreservingBottom(session);
      const size = safeTermSize(session.term);
      if (session.spawned && (!session.lastPtySize || session.lastPtySize.cols !== size.cols || session.lastPtySize.rows !== size.rows)) {
        session.lastPtySize = size;
        invoke('resize_pty', { terminalId, cols: size.cols, rows: size.rows }).catch(() => {});
      }
      if (wasAtBottom) jumpSessionToBottom(session);
    });
  }, [terminalId, terminalFontSize, terminalFontFamily, terminalScrollback]);
}
