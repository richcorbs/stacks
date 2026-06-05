import { useEffect, useRef, useState } from 'react';

export function usePaneActivity(activeTerminalId: string | null) {
  const [runningPaneIds, setRunningPaneIds] = useState<string[]>([]);
  const [activityTerminalIds, setActivityTerminalIds] = useState<string[]>([]);
  const [activityTerminalLastOutputAtById, setActivityTerminalLastOutputAtById] = useState<Record<string, number>>({});
  const [activityNow, setActivityNow] = useState(Date.now());
  const activeTerminalIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeTerminalIdRef.current = activeTerminalId;
    if (activeTerminalId) {
      setActivityTerminalIds((ids) => ids.filter((id) => id !== activeTerminalId));
      setActivityTerminalLastOutputAtById(({ [activeTerminalId]: _acknowledged, ...rest }) => rest);
    }
  }, [activeTerminalId]);

  useEffect(() => {
    if (activityTerminalIds.length === 0) return;
    const interval = window.setInterval(() => setActivityNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [activityTerminalIds.length]);

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
      const now = Date.now();
      setActivityNow(now);
      setActivityTerminalLastOutputAtById((byId) => ({ ...byId, [terminalId]: now }));
    };
    window.addEventListener('pane-running-changed', onRunningChanged);
    window.addEventListener('pane-output', onPaneOutput);
    return () => {
      window.removeEventListener('pane-running-changed', onRunningChanged);
      window.removeEventListener('pane-output', onPaneOutput);
    };
  }, []);

  return { runningPaneIds, setRunningPaneIds, activityTerminalIds, setActivityTerminalIds, activityTerminalLastOutputAtById, activityNow };
}
