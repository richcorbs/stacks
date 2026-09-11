import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

export function useTerminalCwd(activeTerminalId: string | null, rememberTerminalCwd: (terminalId: string, cwd: string) => void) {
  const rememberTerminalCwdRef = useRef(rememberTerminalCwd);
  rememberTerminalCwdRef.current = rememberTerminalCwd;

  useEffect(() => {
    if (!activeTerminalId) return;

    let cancelled = false;
    const refreshTerminalCwd = () => {
      invoke<string | null>('pty_cwd', { terminalId: activeTerminalId })
        .then((cwd) => {
          if (cancelled || !cwd) return;
          // Track the shell's live directory for Git context without overwriting
          // the workspace's configured startup directory.
          rememberTerminalCwdRef.current(activeTerminalId, cwd);
        })
        .catch(() => {});
    };

    refreshTerminalCwd();
    const interval = window.setInterval(refreshTerminalCwd, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeTerminalId]);
}
