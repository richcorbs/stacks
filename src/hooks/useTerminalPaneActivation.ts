import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { fitSessionPreservingBottom, focusPaneSession, getPaneSession, isSessionAtBottom } from '../terminalSessionManager';
import { safeTermSize } from '../terminalSizing';

export function useTerminalPaneActivation({
  paneId,
  active,
  visible,
  maximized,
  termRef,
  fitRef,
  restartPaneSessionIfDead,
}: {
  paneId: string;
  active: boolean;
  visible: boolean;
  maximized: boolean;
  termRef: React.MutableRefObject<Terminal | null>;
  fitRef: React.MutableRefObject<FitAddon | null>;
  restartPaneSessionIfDead: () => boolean;
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
    if (active && restartPaneSessionIfDead()) return;
    if (!term || !fit) return;

    if (wasActive && !active) {
      const session = getPaneSession(paneId);
      wasAtBottomWhenDeactivatedRef.current = session ? isSessionAtBottom(session) : true;
    }

    term.options.cursorBlink = active;
    if (!active) return;

    const shouldScrollToBottom = !wasVisible || maximized || (!wasActive && wasAtBottomWhenDeactivatedRef.current);
    requestAnimationFrame(() => {
      const session = getPaneSession(paneId);
      if (!session) return;
      fitSessionPreservingBottom(session);
      const size = safeTermSize(term);
      invoke('resize_pty', { paneId, cols: size.cols, rows: size.rows }).catch(() => {});
      focusPaneSession(paneId, maximized ? 'active-maximized' : 'active', { scrollToBottom: shouldScrollToBottom });
    });
  }, [active, visible, maximized, paneId, termRef, fitRef, restartPaneSessionIfDead]);
}
