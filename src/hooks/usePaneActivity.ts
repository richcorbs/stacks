import { useEffect, useRef, useState } from 'react';

export function usePaneActivity(activeTerminalId: string | null) {
  const [runningPaneIds, setRunningPaneIds] = useState<string[]>([]);
  const [activityTerminalIds, setActivityTerminalIds] = useState<string[]>([]);
  const activeTerminalIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeTerminalIdRef.current = activeTerminalId;
    if (activeTerminalId) {
      setActivityTerminalIds((ids) => ids.filter((id) => id !== activeTerminalId));
    }
  }, [activeTerminalId]);

  useEffect(() => {
    const onRunningChanged = (event: Event) => {
      const { paneId, running } = (event as CustomEvent<{ paneId: string; running: boolean }>).detail;
      setRunningPaneIds((ids) => {
        const has = ids.includes(paneId);
        if (running && !has) return [...ids, paneId];
        if (!running && has) return ids.filter((id) => id !== paneId);
        return ids;
      });
    };
    const onPaneOutput = (event: Event) => {
      const { terminalId } = (event as CustomEvent<{ terminalId: string; paneId: string }>).detail;
      if (terminalId === activeTerminalIdRef.current) return;
      setActivityTerminalIds((ids) => ids.includes(terminalId) ? ids : [...ids, terminalId]);
    };
    window.addEventListener('pane-running-changed', onRunningChanged);
    window.addEventListener('pane-output', onPaneOutput);
    return () => {
      window.removeEventListener('pane-running-changed', onRunningChanged);
      window.removeEventListener('pane-output', onPaneOutput);
    };
  }, []);

  return { runningPaneIds, setRunningPaneIds, activityTerminalIds, setActivityTerminalIds };
}
