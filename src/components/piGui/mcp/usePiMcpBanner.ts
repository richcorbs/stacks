import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Project } from '../../../types';
import type { PiSessionModel } from '../../../pi/usePiSession';

// Runtime-only: pane IDs survive Pi restarts and view remounts, but not an app restart.
const dismissedMcpTerminalIds = new Set<string>();

export function useMcpBannerDismissal(terminalId: string) {
  const [state, setState] = useState(() => ({ terminalId, dismissed: dismissedMcpTerminalIds.has(terminalId) }));
  useEffect(() => {
    setState({ terminalId, dismissed: dismissedMcpTerminalIds.has(terminalId) });
  }, [terminalId]);
  const dismissed = state.terminalId === terminalId ? state.dismissed : dismissedMcpTerminalIds.has(terminalId);
  const dismiss = () => {
    dismissedMcpTerminalIds.add(terminalId);
    setState({ terminalId, dismissed: true });
  };
  return [dismissed, dismiss] as const;
}

export function usePiMcpBanner({ terminalId, cwd, project, pi, setComposerError }: {
  terminalId: string;
  cwd: string;
  project: Project;
  pi: PiSessionModel;
  setComposerError: (message: string) => void;
}) {
  const [bannerDismissed, dismissBanner] = useMcpBannerDismissal(terminalId);
  const [commandVisible, setCommandVisible] = useState(false);
  const [active, setActive] = useState<boolean | null>(null);
  const [sessionNames, setSessionNames] = useState<string | null>(null);
  const [local, setLocal] = useState<{ local_config_present: boolean; trusted: boolean } | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmTrust, setConfirmTrust] = useState(false);
  const [trustChanged, setTrustChanged] = useState(false);

  useEffect(() => {
    if (pi.starting) return;
    let cancelled = false;
    setTrustChanged(false);
    invoke<boolean | null>('pi_session_mcp_enabled', { paneId: terminalId })
      .then((enabled) => { if (!cancelled) setActive(enabled); })
      .catch(() => { if (!cancelled) setActive(null); });
    invoke<string | null>('pi_session_mcp_env_names', { paneId: terminalId })
      .then((names) => { if (!cancelled) setSessionNames(names); })
      .catch(() => { if (!cancelled) setSessionNames(null); });
    return () => { cancelled = true; };
  }, [terminalId, pi.starting, pi.stopped, project.enable_mcp, project.mcp_env_names]);

  useEffect(() => {
    setTrustChanged(false);
    if (!project.enable_mcp) { setLocal(null); return; }
    let cancelled = false;
    invoke<{ local_config_present: boolean; trusted: boolean }>('pi_mcp_local_status', { cwd, projectPath: project.path })
      .then((status) => { if (!cancelled) setLocal(status); })
      .catch(() => { if (!cancelled) setLocal(null); });
    return () => { cancelled = true; };
  }, [cwd, project.path, project.enable_mcp]);

  function requestRestart() {
    if (pi.isStreaming || pi.queuedFollowUps.length || pi.queuedSteering.length || pi.uiRequest) setConfirmRestart(true);
    else void pi.restart().catch(() => {});
  }

  function trustDirectory() {
    setConfirmTrust(false);
    void invoke('set_pi_project_trusted', { cwd, projectPath: null, trusted: true })
      .then(() => {
        setLocal((current) => current && { ...current, trusted: true });
        setTrustChanged(true);
      })
      .catch((error) => setComposerError(String(error)));
  }

  return {
    bannerDismissed,
    dismissBanner,
    commandVisible,
    setCommandVisible,
    active,
    sessionNames,
    local,
    confirmRestart,
    setConfirmRestart,
    confirmTrust,
    setConfirmTrust,
    trustChanged,
    requestRestart,
    trustDirectory,
  };
}

export type PiMcpBannerModel = ReturnType<typeof usePiMcpBanner>;
