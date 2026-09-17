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
  enabled: boolean;
  running: boolean;
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
    enabled: Boolean(matches && (session?.starting || session?.running)),
    running: Boolean(matches && session?.running),
    identity: managedServiceIdentity(config),
  };
}

export function serviceStoppedMessage(mode: ManagedServiceMode) {
  return `The ${mode} is stopped. Use the play button in the tab to start it.`;
}

/**
 * Disposes the cached xterm session immediately, then kills only the PTY
 * generation that belonged to it. Stops for an id are serialized so callers
 * can await all prior cleanup before mounting a replacement session.
 */
export function stopManagedService(config: ManagedServiceConfig) {
  const session = getTerminalSession(config.terminalId);
  const expectedGeneration = session?.ptyGeneration;
  disposeTerminalSession(config.terminalId);

  const previous = pendingStops.get(config.terminalId) ?? Promise.resolve();
  const stopping = previous
    .catch(() => undefined)
    .then(() => invoke('kill_pty', {
      terminalId: config.terminalId,
      expectedCwd: session?.startupCwd ?? config.cwd,
      expectedGeneration,
    }))
    .then(() => undefined);
  pendingStops.set(config.terminalId, stopping);
  void stopping.finally(() => {
    if (pendingStops.get(config.terminalId) === stopping) pendingStops.delete(config.terminalId);
  }).catch(() => undefined);
  return stopping;
}

export async function waitForManagedServiceStop(terminalId: string) {
  await pendingStops.get(terminalId)?.catch(() => undefined);
}
