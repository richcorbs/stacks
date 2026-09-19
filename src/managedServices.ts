import { invoke } from '@tauri-apps/api/core';
import type { TerminalSession } from './types';
import { disposeTerminalSession, getTerminalSession } from './terminalSessionManager';

export type ManagedServiceMode = 'server' | 'console';
export type ManagedServiceConfig = {
  terminalId: string;
  command: string;
  cwd: string | null;
};
export type ManagedServiceState = {
  mounted: boolean;
  starting: boolean;
  running: boolean;
  restartNonce: number;
  identity: string;
};

const pendingStops = new Map<string, Promise<void>>();

export function managedServiceIdentity(config: ManagedServiceConfig) {
  return JSON.stringify([config.terminalId, config.command.trim(), config.cwd]);
}

export function terminalSessionMatchesManagedService(session: TerminalSession | undefined, config: ManagedServiceConfig) {
  return Boolean(session
    && config.command.trim()
    && config.cwd
    && session.startupConfiguredCommand === config.command.trim()
    && session.startupCwd === config.cwd);
}

export function initialManagedServiceState(config: ManagedServiceConfig): ManagedServiceState {
  const session = getTerminalSession(config.terminalId);
  const matches = terminalSessionMatchesManagedService(session, config);
  return {
    mounted: matches,
    starting: Boolean(matches && session?.starting),
    running: Boolean(matches && session?.running),
    restartNonce: 0,
    identity: managedServiceIdentity(config),
  };
}

export function serviceStoppedMessage(mode: ManagedServiceMode) {
  return `The ${mode} is stopped. Use the play button in the tab to start it.`;
}

/** Stops only the matching PTY generation. The cached xterm remains mounted so
 * its output is available after the generation-scoped exit event confirms the stop. */
export function stopManagedService(config: ManagedServiceConfig) {
  return queueManagedServiceKill(config, false);
}

/** Removes the old terminal before a configuration change or explicit restart. */
export function disposeManagedService(config: ManagedServiceConfig) {
  return queueManagedServiceKill(config, true);
}

function queueManagedServiceKill(config: ManagedServiceConfig, dispose: boolean) {
  const session = getTerminalSession(config.terminalId);
  const expectedGeneration = session?.ptyGeneration;
  if (dispose) disposeTerminalSession(config.terminalId);
  else if (session) {
    session.managedStopRequested = true;
    session.activityNotificationEligible = false;
  }

  const previous = pendingStops.get(config.terminalId) ?? Promise.resolve();
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
  pendingStops.set(config.terminalId, stopping);
  void stopping.finally(() => {
    if (pendingStops.get(config.terminalId) === stopping) pendingStops.delete(config.terminalId);
  }).catch(() => undefined);
  return stopping;
}
