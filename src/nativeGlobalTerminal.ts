import { invoke } from '@tauri-apps/api/core';
import type { GlobalTerminalCommand } from './globalTerminalState';

/**
 * Card #319 spike: adjacent-window native global terminal.
 *
 * Opt-in through `STACKS_NATIVE_GLOBAL_TERMINAL=1` when launching Stacks. When
 * the flag is off, every function here is inert and the xterm.js global
 * terminal keeps owning Cmd+T. See `spikes/gpui-terminal/HOST_INTEGRATION.md`.
 */
export type NativeTerminalStatus = {
  enabled: boolean;
  running: boolean;
  ready: boolean;
  visible: boolean;
  helper_path: string | null;
  socket_path: string | null;
  last_error: string | null;
};

export type NativeTerminalEvent =
  | { event: 'ready'; pid?: number; version?: string }
  | { event: 'visibility'; visible: boolean }
  | { event: 'title'; title: string }
  | { event: 'bell'; title?: string }
  | { event: 'quit-requested' }
  | { event: 'error'; message: string }
  | { event: 'exit' };

export type NativeTerminalRequest = { command: string; index?: number };

export const NATIVE_TERMINAL_EVENT = 'native-terminal-event';

export const nativeTerminalStatus = () => invoke<NativeTerminalStatus>('native_terminal_status');
export const nativeTerminalLaunch = () => invoke<NativeTerminalStatus>('native_terminal_launch');
export const sendNativeTerminal = (request: NativeTerminalRequest) =>
  invoke<void>('native_terminal_command', { command: request.command, index: request.index ?? null });

/** Translate the shared global-terminal command vocabulary to host commands. */
export function nativeRequestForGlobalCommand(command: GlobalTerminalCommand): NativeTerminalRequest {
  switch (command.type) {
    case 'new-tab': return { command: 'new-tab' };
    case 'select-tab': return { command: 'select-tab', index: command.number };
    case 'navigate-tab': return { command: command.direction === -1 ? 'previous-tab' : 'next-tab' };
    case 'navigate-pane': return { command: command.direction === -1 ? 'previous-pane' : 'next-pane' };
    case 'split': return { command: command.direction === 'column' ? 'split-down' : 'split-right' };
    case 'toggle-maximize': return { command: 'maximize' };
    case 'close': return { command: 'close' };
    case 'clear': return { command: 'clear' };
    case 'search': return { command: 'search' };
  }
}

/** Shortcut-handler action names share the host command names where possible. */
export function nativeRequestForTerminalAction(action: 'split-right' | 'split-down' | 'close' | 'clear' | 'search' | 'toggle-maximize' | 'previous-pane' | 'next-pane'): NativeTerminalRequest {
  return { command: action === 'toggle-maximize' ? 'maximize' : action };
}
