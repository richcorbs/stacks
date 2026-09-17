import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import {
  initialManagedServiceState,
  managedServiceIdentity,
  stopManagedService,
  terminalSessionMatchesManagedService,
  waitForManagedServiceStop,
  type ManagedServiceConfig,
  type ManagedServiceMode,
  type ManagedServiceState,
} from '../managedServices';
import { getTerminalSession } from '../terminalSessionManager';

type ServiceStates = Record<ManagedServiceMode, ManagedServiceState>;
type ServiceConfigs = Record<ManagedServiceMode, ManagedServiceConfig>;

export function useManagedServices(configs: ServiceConfigs, onTerminalStopped?: (terminalId: string) => void) {
  const serverIdentity = managedServiceIdentity(configs.server);
  const consoleIdentity = managedServiceIdentity(configs.console);
  const stableConfigs = useMemo<ServiceConfigs>(() => configs, [serverIdentity, consoleIdentity]);
  const [states, setStates] = useState<ServiceStates>(() => ({
    server: initialManagedServiceState(configs.server),
    console: initialManagedServiceState(configs.console),
  }));

  // A changed identity is disabled synchronously during render. This prevents
  // TerminalView from reusing an old xterm session and spawning the new command.
  const currentStates: ServiceStates = {
    server: states.server.identity === serverIdentity ? states.server : { enabled: false, running: false, identity: serverIdentity },
    console: states.console.identity === consoleIdentity ? states.console : { enabled: false, running: false, identity: consoleIdentity },
  };

  useLayoutEffect(() => {
    (['server', 'console'] as const).forEach((mode) => {
      const config = stableConfigs[mode];
      const session = getTerminalSession(config.terminalId);
      if (session && !terminalSessionMatchesManagedService(session, config)) {
        void stopManagedService(config).catch(console.error);
      }
    });
    setStates((current) => {
      let changed = false;
      const next = { ...current };
      (['server', 'console'] as const).forEach((mode) => {
        const identity = managedServiceIdentity(stableConfigs[mode]);
        if (current[mode].identity !== identity) {
          next[mode] = { enabled: false, running: false, identity };
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [stableConfigs]);

  useLayoutEffect(() => {
    const handleRunningChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId?: string; running?: boolean }>).detail;
      if (detail?.terminalId && !detail.running) onTerminalStopped?.(detail.terminalId);
      const mode = detail?.terminalId === stableConfigs.server.terminalId
        ? 'server'
        : detail?.terminalId === stableConfigs.console.terminalId ? 'console' : null;
      if (!mode) return;
      const config = stableConfigs[mode];
      const running = Boolean(detail.running && terminalSessionMatchesManagedService(getTerminalSession(config.terminalId), config));
      setStates((current) => ({
        ...current,
        [mode]: { ...current[mode], enabled: running ? current[mode].enabled : false, running },
      }));
    };
    window.addEventListener('terminal-running-changed', handleRunningChanged);
    return () => window.removeEventListener('terminal-running-changed', handleRunningChanged);
  }, [onTerminalStopped, stableConfigs]);

  const toggle = useCallback(async (mode: ManagedServiceMode) => {
    const config = stableConfigs[mode];
    const identity = managedServiceIdentity(config);
    const state = states[mode].identity === identity ? states[mode] : { enabled: false };
    if (!state.enabled) {
      if (!config.command.trim() || !config.cwd) return;
      await waitForManagedServiceStop(config.terminalId);
      setStates((current) => ({
        ...current,
        [mode]: { enabled: true, running: false, identity },
      }));
      return;
    }
    setStates((current) => ({
      ...current,
      [mode]: { enabled: false, running: false, identity },
    }));
    await stopManagedService(config).catch(console.error);
  }, [stableConfigs, states]);

  return {
    serverEnabled: currentStates.server.enabled,
    consoleEnabled: currentStates.console.enabled,
    serverRunning: currentStates.server.running,
    consoleRunning: currentStates.console.running,
    toggle,
  };
}
