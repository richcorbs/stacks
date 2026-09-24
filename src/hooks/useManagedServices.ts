import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  disposeManagedService,
  initialManagedServiceState,
  managedServiceIdentity,
  stopManagedService,
  terminalSessionMatchesManagedService,
  type ManagedServiceConfig,
  type ManagedServiceMode,
  type ManagedServiceState,
} from '../managedServices';
import { getTerminalSession } from '../terminalSessionManager';
import { applicationEvents } from '../applicationEvents';

type ServiceStates = Record<ManagedServiceMode, ManagedServiceState>;
type ServiceConfigs = Record<ManagedServiceMode, ManagedServiceConfig>;

function inactiveState(identity: string, restartNonce = 0): ManagedServiceState {
  return { mounted: false, starting: false, running: false, restartNonce, identity };
}

export function useManagedServices(configs: ServiceConfigs, onTerminalStopped?: (terminalId: string) => void) {
  const serverIdentity = managedServiceIdentity(configs.server);
  const consoleIdentity = managedServiceIdentity(configs.console);
  const stableConfigs = useMemo<ServiceConfigs>(() => configs, [serverIdentity, consoleIdentity]);
  const [states, setStates] = useState<ServiceStates>(() => ({
    server: initialManagedServiceState(configs.server),
    console: initialManagedServiceState(configs.console),
  }));
  const pendingActionsRef = useRef(new Set<ManagedServiceMode>());

  // A changed identity is unmounted synchronously so TerminalView cannot reuse
  // its old xterm session for the replacement command.
  const currentStates: ServiceStates = {
    server: states.server.identity === serverIdentity ? states.server : inactiveState(serverIdentity, states.server.restartNonce),
    console: states.console.identity === consoleIdentity ? states.console : inactiveState(consoleIdentity, states.console.restartNonce),
  };

  useLayoutEffect(() => {
    (['server', 'console'] as const).forEach((mode) => {
      const config = stableConfigs[mode];
      const session = getTerminalSession(config.terminalId);
      if (session && !terminalSessionMatchesManagedService(session, config)) {
        void disposeManagedService(config).catch(console.error);
      }
    });
    setStates((current) => {
      let changed = false;
      const next = { ...current };
      (['server', 'console'] as const).forEach((mode) => {
        const identity = managedServiceIdentity(stableConfigs[mode]);
        if (current[mode].identity !== identity) {
          next[mode] = inactiveState(identity, current[mode].restartNonce);
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [stableConfigs]);

  useLayoutEffect(() => {
    const handleRunningChanged = (detail: { terminalId: string; generation?: string; running: boolean }) => {
      const mode = detail?.terminalId === stableConfigs.server.terminalId
        ? 'server'
        : detail?.terminalId === stableConfigs.console.terminalId ? 'console' : null;
      if (!mode) return;
      const config = stableConfigs[mode];
      const session = getTerminalSession(config.terminalId);
      if (!terminalSessionMatchesManagedService(session, config)) return;
      if (detail.generation && detail.generation !== session?.ptyGeneration) return;

      const running = Boolean(detail.running);
      setStates((current) => ({
        ...current,
        [mode]: {
          ...current[mode],
          mounted: true,
          starting: false,
          running,
        },
      }));
      if (!running) onTerminalStopped?.(config.terminalId);
    };
    return applicationEvents.subscribe('terminal-running-changed', handleRunningChanged);
  }, [onTerminalStopped, stableConfigs]);

  const start = useCallback(async (mode: ManagedServiceMode) => {
    if (pendingActionsRef.current.has(mode)) return;
    const config = stableConfigs[mode];
    const identity = managedServiceIdentity(config);
    const state = states[mode].identity === identity ? states[mode] : inactiveState(identity);
    if (state.starting || state.running || !config.command.trim() || !config.cwd) return;

    pendingActionsRef.current.add(mode);
    try {
      // A stopped xterm intentionally remains cached. Replace it only for an
      // explicit Play request so each run starts with fresh output.
      await disposeManagedService(config);
      setStates((current) => ({
        ...current,
        [mode]: {
          mounted: true,
          starting: true,
          running: false,
          restartNonce: current[mode].restartNonce + 1,
          identity,
        },
      }));
    } finally {
      pendingActionsRef.current.delete(mode);
    }
  }, [stableConfigs, states]);

  const stop = useCallback(async (mode: ManagedServiceMode) => {
    if (pendingActionsRef.current.has(mode)) return;
    const config = stableConfigs[mode];
    const identity = managedServiceIdentity(config);
    const state = states[mode].identity === identity ? states[mode] : inactiveState(identity);
    if (!state.starting && !state.running) return;

    pendingActionsRef.current.add(mode);
    try {
      await stopManagedService(config);
    } finally {
      pendingActionsRef.current.delete(mode);
    }
  }, [stableConfigs, states]);

  const toggle = useCallback(async (mode: ManagedServiceMode) => {
    const identity = managedServiceIdentity(stableConfigs[mode]);
    const state = states[mode].identity === identity ? states[mode] : inactiveState(identity);
    try {
      if (state.starting || state.running) await stop(mode);
      else await start(mode);
    } catch (error) {
      console.error(error);
    }
  }, [stableConfigs, start, states, stop]);

  const serverActive = currentStates.server.starting || currentStates.server.running;
  const consoleActive = currentStates.console.starting || currentStates.console.running;
  return {
    serverEnabled: currentStates.server.mounted,
    consoleEnabled: currentStates.console.mounted,
    serverStarting: currentStates.server.starting,
    consoleStarting: currentStates.console.starting,
    serverRunning: currentStates.server.running,
    consoleRunning: currentStates.console.running,
    serverActive,
    consoleActive,
    serverRestartNonce: currentStates.server.restartNonce,
    consoleRestartNonce: currentStates.console.restartNonce,
    start,
    stop,
    toggle,
  };
}
