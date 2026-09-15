import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { disposeTerminalSession, getTerminalSession } from '../terminalSessionManager';
import { cardTerminalId, type CardServiceMode } from './cardWorkspace';

export function useCardServices(cardId: string, cardPath: string | null, onTemporaryTerminalStopped: (terminalId: string) => void) {
  const [serverRunning, setServerRunning] = useState(() => Boolean(getTerminalSession(cardTerminalId(cardId, 'server'))?.running));
  const [consoleRunning, setConsoleRunning] = useState(() => Boolean(getTerminalSession(cardTerminalId(cardId, 'console'))?.running));
  const [serverEnabled, setServerEnabled] = useState(() => Boolean(getTerminalSession(cardTerminalId(cardId, 'server'))?.running));
  const [consoleEnabled, setConsoleEnabled] = useState(() => Boolean(getTerminalSession(cardTerminalId(cardId, 'console'))?.running));

  useEffect(() => {
    const serverId = cardTerminalId(cardId, 'server');
    const consoleId = cardTerminalId(cardId, 'console');
    const handleRunningChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId?: string; running?: boolean }>).detail;
      if (detail?.terminalId && !detail.running) onTemporaryTerminalStopped(detail.terminalId);
      if (detail?.terminalId === serverId) {
        setServerRunning(Boolean(detail.running));
        if (!detail.running) setServerEnabled(false);
      }
      if (detail?.terminalId === consoleId) {
        setConsoleRunning(Boolean(detail.running));
        if (!detail.running) setConsoleEnabled(false);
      }
    };
    window.addEventListener('terminal-running-changed', handleRunningChanged);
    return () => window.removeEventListener('terminal-running-changed', handleRunningChanged);
  }, [cardId]);

  function toggle(mode: CardServiceMode) {
    const enabled = mode === 'server' ? serverEnabled : consoleEnabled;
    const setEnabled = mode === 'server' ? setServerEnabled : setConsoleEnabled;
    if (!enabled) {
      setEnabled(true);
      return;
    }
    const terminalId = cardTerminalId(cardId, mode);
    disposeTerminalSession(terminalId);
    invoke('kill_pty', { terminalId, expectedCwd: cardPath }).catch(console.error);
    setEnabled(false);
  }

  return { serverRunning, consoleRunning, serverEnabled, consoleEnabled, toggle };
}
