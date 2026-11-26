import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { applicationEvents } from '../applicationEvents';
import type { TerminalSession } from '../types';
import { disposeTerminalSession, getTerminalSession, registerOneTimeStartupCommand } from '../terminalSessionManager';
import type { WorkspaceShellController, WorkspaceShellServicePane } from '../workspaceShellController';
import type { TerminalServiceControls } from '../components/TerminalControls';

export type ServicePaneMode = 'server' | 'console';
export type ServicePaneConfig = WorkspaceShellServicePane;
export type ServicePaneConfigs = Record<ServicePaneMode, ServicePaneConfig>;

type ServicePaneState = {
  error: string | null;
  identity: string;
  mounted: boolean;
  running: boolean;
  starting: boolean;
};

const pendingKills = new Map<string, Promise<void>>();

export function servicePaneIdentity(config: ServicePaneConfig) {
  return JSON.stringify([config.terminalId, config.command.trim(), config.cwd]);
}

export function servicePaneSessionMatches(session: TerminalSession | undefined, config: ServicePaneConfig) {
  const command = config.command.trim();
  return Boolean(session && command && config.cwd
    && session.startupCommand === command
    && session.startupCwd === config.cwd);
}

function inactiveState(identity: string): ServicePaneState {
  return { error: null, identity, mounted: false, running: false, starting: false };
}

/** Stop only the tracked PTY generation, keeping its xterm output mounted. */
export function stopServicePaneProcess(config: ServicePaneConfig) {
  return queueServicePaneKill(config, false);
}

/** Remove the cached xterm before replacing the process or closing the workspace. */
export function disposeServicePane(config: ServicePaneConfig) {
  return queueServicePaneKill(config, true);
}

function queueServicePaneKill(config: ServicePaneConfig, dispose: boolean) {
  const session = getTerminalSession(config.terminalId);
  const expectedGeneration = session?.ptyGeneration;
  if (dispose) disposeTerminalSession(config.terminalId);
  else if (session) {
    session.managedStopRequested = true;
    session.activityNotificationEligible = false;
  }

  const previous = pendingKills.get(config.terminalId) ?? Promise.resolve();
  const stopping = previous
    .catch(() => undefined)
    .then(() => invoke('kill_pty', {
      terminalId: config.terminalId,
      expectedCwd: session?.startupCwd ?? config.cwd,
      expectedGeneration,
    }))
    .then(() => undefined)
    .catch((error) => {
      if (!dispose && session) session.managedStopRequested = false;
      throw error;
    });
  pendingKills.set(config.terminalId, stopping);
  void stopping.finally(() => {
    if (pendingKills.get(config.terminalId) === stopping) pendingKills.delete(config.terminalId);
  }).catch(() => undefined);
  return stopping;
}

export function useServicePanes({ controller, configs }: {
  controller: WorkspaceShellController;
  configs: ServicePaneConfigs;
}) {
  const serverIdentity = servicePaneIdentity(configs.server);
  const consoleIdentity = servicePaneIdentity(configs.console);
  const stableConfigs = useMemo<ServicePaneConfigs>(() => configs, [serverIdentity, consoleIdentity]);
  const configsRef = useRef(stableConfigs);
  configsRef.current = stableConfigs;
  const [states, setStates] = useState<Record<ServicePaneMode, ServicePaneState>>(() => ({
    server: inactiveState(serverIdentity),
    console: inactiveState(consoleIdentity),
  }));
  const pendingActionsRef = useRef(new Set<ServicePaneMode>());

  // A changed command/cwd invalidates the old pane identity. Never let the next
  // Start reuse the previous xterm session for a different command.
  useLayoutEffect(() => {
    setStates((current) => {
      let changed = false;
      const next = { ...current };
      (['server', 'console'] as const).forEach((mode) => {
        const identity = servicePaneIdentity(stableConfigs[mode]);
        if (current[mode].identity !== identity) {
          const session = getTerminalSession(stableConfigs[mode].terminalId);
          disposeTerminalSession(stableConfigs[mode].terminalId);
          if (session) {
            void invoke('kill_pty', {
              terminalId: stableConfigs[mode].terminalId,
              expectedCwd: session.startupCwd,
              expectedGeneration: session.ptyGeneration,
            }).catch(console.error);
          }
          next[mode] = inactiveState(identity);
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [stableConfigs]);

  useEffect(() => {
    const handleRunningChanged = (detail: { terminalId: string; generation?: string; running: boolean }) => {
      const mode: ServicePaneMode | null = detail?.terminalId === stableConfigs.server.terminalId
        ? 'server'
        : detail?.terminalId === stableConfigs.console.terminalId ? 'console' : null;
      if (!mode) return;
      const config = stableConfigs[mode];
      const session = getTerminalSession(config.terminalId);
      // An explicit dispose (close pane, changed command) has no generation and
      // no cached session; it is still a real stop signal for the green dot.
      if (!session && !detail.generation) {
        setStates((current) => ({
          ...current,
          [mode]: { ...current[mode], mounted: false, running: false, starting: false },
        }));
        return;
      }
      if (!servicePaneSessionMatches(session, config)) return;
      if (detail.generation && detail.generation !== session?.ptyGeneration) return;

      const running = Boolean(detail.running);
      setStates((current) => ({
        ...current,
        [mode]: {
          ...current[mode],
          mounted: true,
          starting: false,
          running,
          error: !running && current[mode].starting && !session?.managedStopRequested
            ? `Could not start ${mode}; see terminal output.`
            : current[mode].error,
        },
      }));
    };
    return applicationEvents.subscribe('terminal-running-changed', handleRunningChanged);
  }, [stableConfigs]);

  const setModeState = useCallback((mode: ServicePaneMode, identity: string, patch: Partial<ServicePaneState>) => {
    setStates((current) => current[mode].identity !== identity
      ? current
      : { ...current, [mode]: { ...current[mode], ...patch } });
  }, []);

  const start = useCallback(async (mode: ServicePaneMode, force = false) => {
    const config = stableConfigs[mode];
    const identity = servicePaneIdentity(config);
    const state = states[mode].identity === identity ? states[mode] : inactiveState(identity);
    if (!config.command.trim() || !config.cwd) return;
    if (!force && (state.starting || state.running)) {
      controller.setServicePane(config);
      if (!controller.focus(config.terminalId)) controller.startServicePane(config);
      return;
    }
    if (pendingActionsRef.current.has(mode)) return;

    pendingActionsRef.current.add(mode);
    setStates((current) => current[mode].identity !== identity ? current : ({
      ...current,
      [mode]: { ...current[mode], error: null, mounted: false, running: false, starting: false },
    }));
    try {
      // A stopped xterm stays available for reading its output; an explicit
      // Start replaces it so every run begins with a clean buffer.
      await disposeServicePane(config);
      if (servicePaneIdentity(configsRef.current[mode]) !== identity) return;
      registerOneTimeStartupCommand(config.terminalId, config.command.trim());
      controller.startServicePane(config);
      setModeState(mode, identity, { error: null, mounted: true, running: false, starting: true });
    } catch (error) {
      setModeState(mode, identity, { error: error instanceof Error ? error.message : String(error), mounted: false, starting: false });
      throw error;
    } finally {
      pendingActionsRef.current.delete(mode);
    }
  }, [controller, setModeState, stableConfigs, states]);

  const stop = useCallback(async (mode: ServicePaneMode) => {
    const config = stableConfigs[mode];
    const identity = servicePaneIdentity(config);
    const state = states[mode].identity === identity ? states[mode] : inactiveState(identity);
    if (!state.starting && !state.running) return;
    if (pendingActionsRef.current.has(mode)) return;

    pendingActionsRef.current.add(mode);
    try {
      await stopServicePaneProcess(config);
    } catch (error) {
      setModeState(mode, identity, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      pendingActionsRef.current.delete(mode);
    }
  }, [setModeState, stableConfigs, states]);

  const restart = useCallback(async (mode: ServicePaneMode) => {
    try {
      await start(mode, true);
    } catch (error) {
      console.error(error);
    }
  }, [start]);

  const toggle = useCallback(async (mode: ServicePaneMode) => {
    const identity = servicePaneIdentity(stableConfigs[mode]);
    const state = states[mode].identity === identity ? states[mode] : inactiveState(identity);
    try {
      if (state.starting || state.running) await stop(mode);
      else await start(mode);
    } catch (error) {
      console.error(error);
    }
  }, [stableConfigs, start, states, stop]);

  useEffect(() => applicationEvents.subscribe('terminal-service-command', (command: { mode: ServicePaneMode; action: 'start' | 'stop' | 'restart'; ownerId?: string }) => {
    if (command.ownerId && command.ownerId !== controller.ownerId) return;
    if (command.action === 'stop') void toggle(command.mode);
    else if (command.action === 'restart') void restart(command.mode);
    else void start(command.mode);
  }), [controller, restart, start, toggle]);

  // Closing the workspace stops both process groups. Cached services must not
  // outlive the view that owns their panes.
  useEffect(() => () => {
    (['server', 'console'] as const).forEach((mode) => {
      const config = configsRef.current[mode];
      if (getTerminalSession(config.terminalId)) void disposeServicePane(config).catch(console.error);
    });
  }, []);

  const currentStates = {
    server: states.server.identity === serverIdentity ? states.server : inactiveState(serverIdentity),
    console: states.console.identity === consoleIdentity ? states.console : inactiveState(consoleIdentity),
  };
  const serverActive = currentStates.server.starting || currentStates.server.running;
  const consoleActive = currentStates.console.starting || currentStates.console.running;

  const serverConfigured = Boolean(stableConfigs.server.command.trim() && stableConfigs.server.cwd);
  const consoleConfigured = Boolean(stableConfigs.console.command.trim() && stableConfigs.console.cwd);
  const controls = useMemo<TerminalServiceControls>(() => ({
    serverConfigured,
    consoleConfigured,
    serverRunning: serverActive,
    consoleRunning: consoleActive,
    serverError: currentStates.server.error,
    consoleError: currentStates.console.error,
    onStartServer: () => { void toggle('server'); },
    onStartConsole: () => { void toggle('console'); },
  }), [consoleActive, consoleConfigured, currentStates.console.error, currentStates.server.error, serverActive, serverConfigured, toggle]);
  const context = useMemo(() => ({
    server: { configured: serverConfigured, active: serverActive },
    console: { configured: consoleConfigured, active: consoleActive },
  }), [consoleActive, consoleConfigured, serverActive, serverConfigured]);

  return {
    controls,
    running: serverActive || consoleActive,
    serverActive,
    consoleActive,
    serverRunning: currentStates.server.running,
    consoleRunning: currentStates.console.running,
    serverMounted: currentStates.server.mounted,
    consoleMounted: currentStates.console.mounted,
    serverError: currentStates.server.error,
    consoleError: currentStates.console.error,
    start,
    stop,
    restart,
    toggle,
    context,
  };
}

export type ServicePanes = ReturnType<typeof useServicePanes>;
