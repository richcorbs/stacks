import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  NATIVE_TERMINAL_EVENT,
  nativeRequestForGlobalCommand,
  nativeTerminalStatus,
  sendNativeTerminal,
  type NativeTerminalEvent,
  type NativeTerminalRequest,
  type NativeTerminalStatus,
} from '../nativeGlobalTerminal';
import type { GlobalTerminalCommand } from '../globalTerminalState';

type NativeGlobalTerminalOptions = {
  /** The helper forwards Cmd+Q so Stacks keeps its confirm-quit flow. */
  onRequestQuit: () => void;
  onNotify: (message: string) => void;
};

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Card #319 spike. Reads the dev flag from the backend once, forwards terminal
 * commands to the native helper, and mirrors its visibility/title events.
 * With the flag off, `enabled` stays false and nothing is ever spawned.
 */
export function useNativeGlobalTerminal({ onRequestQuit, onNotify }: NativeGlobalTerminalOptions) {
  const [status, setStatus] = useState<NativeTerminalStatus | null>(null);
  const statusRef = useRef<NativeTerminalStatus | null>(null);
  const callbacks = useRef({ onRequestQuit, onNotify });
  callbacks.current = { onRequestQuit, onNotify };

  const apply = useCallback((next: NativeTerminalStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const refresh = useCallback(async () => {
    const next = await nativeTerminalStatus().catch(() => null);
    if (next) apply(next);
    return next;
  }, [apply]);

  useEffect(() => {
    let cancelled = false;
    void nativeTerminalStatus()
      .then((initial) => { if (!cancelled) apply(initial); })
      .catch((error) => console.error('Could not read native terminal status', error));
    const listener = getCurrentWindow().listen<NativeTerminalEvent>(NATIVE_TERMINAL_EVENT, ({ payload }) => {
      const current = statusRef.current;
      if (payload.event === 'visibility' && current) {
        apply({ ...current, visible: payload.visible });
      } else if (payload.event === 'exit' && current) {
        apply({ ...current, running: false, ready: false, visible: false });
        callbacks.current.onNotify('Native terminal closed; ⌘T relaunches it');
      } else if (payload.event === 'quit-requested') {
        callbacks.current.onRequestQuit();
      } else if (payload.event === 'bell') {
        callbacks.current.onNotify(payload.title ? `Bell · ${payload.title}` : 'Bell');
      } else if (payload.event === 'error') {
        callbacks.current.onNotify(`Native terminal: ${payload.message}`);
      }
    });
    return () => {
      cancelled = true;
      listener.then((unlisten) => unlisten()).catch(console.error);
    };
  }, [apply]);

  const send = useCallback(async (request: NativeTerminalRequest) => {
    try {
      // The backend launches the helper lazily on the first command, then
      // forwards it. No extra status round trip per key press.
      await sendNativeTerminal(request);
      const current = statusRef.current;
      if (current && !current.running) apply({ ...current, running: true, ready: true });
    } catch (error) {
      callbacks.current.onNotify(`Native terminal: ${errorMessage(error)}`);
      await refresh();
    }
  }, [apply, refresh]);

  const sendGlobalCommand = useCallback((command: GlobalTerminalCommand) => {
    void send(nativeRequestForGlobalCommand(command));
  }, [send]);

  return {
    enabled: status?.enabled ?? false,
    visible: status?.visible ?? false,
    running: status?.running ?? false,
    ready: status?.ready ?? false,
    status,
    send,
    sendGlobalCommand,
    refresh,
  };
}
