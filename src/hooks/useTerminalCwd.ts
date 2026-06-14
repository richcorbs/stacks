import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Store } from '../types';

export function useTerminalCwd(activeTerminalId: string | null, rememberTerminalCwd: (terminalId: string, cwd: string) => void, setStore: Dispatch<SetStateAction<Store>>) {
  const rememberTerminalCwdRef = useRef(rememberTerminalCwd);
  rememberTerminalCwdRef.current = rememberTerminalCwd;

  useEffect(() => {
    if (!activeTerminalId) return;

    let cancelled = false;
    const refreshTerminalCwd = () => {
      invoke<string | null>('pty_cwd', { terminalId: activeTerminalId })
        .then((cwd) => {
          if (cancelled || !cwd) return;
          rememberTerminalCwdRef.current(activeTerminalId, cwd);
          const workspaceId = activeTerminalId.split(':')[0];
          setStore((s) => {
            let changed = false;
            const projects = s.projects.map((p) => ({
              ...p,
              workspaces: p.workspaces.map((workspace) => {
                if (workspace.id !== workspaceId || workspace.cwd === cwd) return workspace;
                changed = true;
                return { ...workspace, cwd };
              }),
            }));
            return changed ? { projects } : s;
          });
        })
        .catch(() => {});
    };

    refreshTerminalCwd();
    const interval = window.setInterval(refreshTerminalCwd, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeTerminalId, setStore]);
}
