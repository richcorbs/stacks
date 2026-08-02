type RawOutputListener = (terminalId: string, data: string) => void;

const listeners = new Set<RawOutputListener>();

export function publishTerminalRawOutput(terminalId: string, data: string) {
  listeners.forEach((listener) => listener(terminalId, data));
}

export function subscribeAnyTerminalRawOutput(listener: RawOutputListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
