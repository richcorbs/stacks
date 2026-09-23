import { useMemo } from 'react';
import { useManagedServices } from '../hooks/useManagedServices';
import { cardTerminalId } from './cardWorkspace';

export function useCardServices(
  cardId: string,
  cardPath: string | null,
  serverCommand: string,
  consoleCommand: string,
  onTemporaryTerminalStopped?: (terminalId: string) => void,
) {
  const configs = useMemo(() => ({
    server: { terminalId: cardTerminalId(cardId, 'server'), command: serverCommand.trim(), cwd: cardPath },
    console: { terminalId: cardTerminalId(cardId, 'console'), command: consoleCommand.trim(), cwd: cardPath },
  }), [cardId, cardPath, consoleCommand, serverCommand]);
  return useManagedServices(configs, onTemporaryTerminalStopped);
}

export type CardServices = ReturnType<typeof useCardServices>;
