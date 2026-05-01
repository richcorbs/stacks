import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Store } from '../types';

export function usePaneCwd(activePaneId: string | null, rememberPaneCwd: (paneId: string, cwd: string) => void, setStore: Dispatch<SetStateAction<Store>>) {
  const rememberPaneCwdRef = useRef(rememberPaneCwd);
  rememberPaneCwdRef.current = rememberPaneCwd;

  useEffect(() => {
    if (!activePaneId) return;

    let cancelled = false;
    const refreshPaneCwd = () => {
      invoke<string | null>('pty_cwd', { paneId: activePaneId })
        .then((cwd) => {
          if (cancelled || !cwd) return;
          rememberPaneCwdRef.current(activePaneId, cwd);
          const terminalId = activePaneId.split(':')[0];
          setStore((s) => {
            let changed = false;
            const projects = s.projects.map((p) => ({
              ...p,
              terminals: p.terminals.map((t) => {
                if (t.id !== terminalId || t.cwd === cwd) return t;
                changed = true;
                return { ...t, cwd };
              }),
            }));
            return changed ? { projects } : s;
          });
        })
        .catch(() => {});
    };

    refreshPaneCwd();
    const interval = window.setInterval(refreshPaneCwd, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activePaneId, setStore]);
}
