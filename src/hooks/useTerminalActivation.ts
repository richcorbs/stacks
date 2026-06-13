import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { fitSessionPreservingBottom, focusTerminalSession, getTerminalSession, isSessionAtBottom } from '../terminalSessionManager';
import { safeTermSize } from '../terminalSizing';

export function useTerminalActivation({
  terminalId,
  active,
  visible,
  maximized,
  termRef,
  fitRef,
  restartTerminalSessionIfDead,
}: {
  terminalId: string;
  active: boolean;
  visible: boolean;
  maximized: boolean;
  termRef: React.MutableRefObject<Terminal | null>;
  fitRef: React.MutableRefObject<FitAddon | null>;
  restartTerminalSessionIfDead: () => boolean;
}) {
  const wasVisibleRef = useRef(visible);
  const wasActiveRef = useRef(active);
  const wasAtBottomWhenDeactivatedRef = useRef(true);

  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    const wasActive = wasActiveRef.current;
    wasVisibleRef.current = visible;
    wasActiveRef.current = active;

    const term = termRef.current;
    const fit = fitRef.current;
    if (active && restartTerminalSessionIfDead()) return;
    if (!term || !fit) return;

    if (wasActive && !active) {
      const session = getTerminalSession(terminalId);
      wasAtBottomWhenDeactivatedRef.current = session ? isSessionAtBottom(session) : true;
    }

    term.options.cursorBlink = active;
    if (!active) return;

    const shouldScrollToBottom = !wasVisible || maximized || (!wasActive && wasAtBottomWhenDeactivatedRef.current);
    requestAnimationFrame(() => {
      const session = getTerminalSession(terminalId);
      if (!session) return;
      fitSessionPreservingBottom(session);
      const size = safeTermSize(term);
      invoke('resize_pty', { terminalId, cols: size.cols, rows: size.rows }).catch(() => {});
      focusTerminalSession(terminalId, maximized ? 'active-maximized' : 'active', { scrollToBottom: shouldScrollToBottom });
    });
  }, [active, visible, maximized, terminalId, termRef, fitRef, restartTerminalSessionIfDead]);
}
