import { useEffect, useRef, useState } from 'react';
import { FRESH_ACTIVITY_MS } from '../workspace/statusDots';

export function useTerminalActivity(activeWorkspaceId: string | null) {
  const [runningTerminalIds, setRunningTerminalIds] = useState<string[]>([]);
  const [activityWorkspaceIds, setActivityWorkspaceIds] = useState<string[]>([]);
  const [activityTerminalLastOutputAtById, setActivityTerminalLastOutputAtById] = useState<Record<string, number>>({});
  const [activityNow, setActivityNow] = useState(Date.now());
  const activeWorkspaceIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeWorkspaceIdRef.current = activeWorkspaceId;
    if (activeWorkspaceId) {
      setActivityWorkspaceIds((ids) => ids.filter((id) => id !== activeWorkspaceId));
      setActivityTerminalLastOutputAtById(({ [activeWorkspaceId]: _acknowledged, ...rest }) => rest);
    }
  }, [activeWorkspaceId]);

  useEffect(() => {
    const now = Date.now();
    const nextTransitionAt = activityWorkspaceIds
      .map((workspaceId) => (activityTerminalLastOutputAtById[workspaceId] ?? 0) + FRESH_ACTIVITY_MS)
      .filter((transitionAt) => transitionAt > now)
      .sort((left, right) => left - right)[0];
    if (!nextTransitionAt) return;
    const timeout = window.setTimeout(() => setActivityNow(Date.now()), nextTransitionAt - now + 1);
    return () => window.clearTimeout(timeout);
  }, [activityWorkspaceIds, activityTerminalLastOutputAtById, activityNow]);

  useEffect(() => {
    const onRunningChanged = (event: Event) => {
      const { terminalId, running } = (event as CustomEvent<{ terminalId: string; running: boolean }>).detail;
      setRunningTerminalIds((ids) => {
        const has = ids.includes(terminalId);
        if (running && !has) return [...ids, terminalId];
        if (!running && has) return ids.filter((id) => id !== terminalId);
        return ids;
      });
    };
    const onTerminalOutput = (event: Event) => {
      const { workspaceId } = (event as CustomEvent<{ workspaceId: string; terminalId: string }>).detail;
      if (workspaceId === activeWorkspaceIdRef.current) return;
      setActivityWorkspaceIds((ids) => ids.includes(workspaceId) ? ids : [...ids, workspaceId]);
      const now = Date.now();
      setActivityNow(now);
      setActivityTerminalLastOutputAtById((byId) => ({ ...byId, [workspaceId]: now }));
    };
    window.addEventListener('terminal-running-changed', onRunningChanged);
    window.addEventListener('terminal-output', onTerminalOutput);
    return () => {
      window.removeEventListener('terminal-running-changed', onRunningChanged);
      window.removeEventListener('terminal-output', onTerminalOutput);
    };
  }, []);

  return { runningTerminalIds, setRunningTerminalIds, activityWorkspaceIds, setActivityWorkspaceIds, activityTerminalLastOutputAtById, activityNow };
}
