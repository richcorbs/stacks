import type { TerminalEntry } from '../types';

export function diffReviewTargetPane(terminals: TerminalEntry[], activeTerminalId: string | null) {
  const activeTerminal = terminals.find((terminal) => terminal.id === activeTerminalId);
  if (activeTerminal?.kind === 'pi') return activeTerminal;
  return terminals.find((terminal) => !terminal.temporary && terminal.kind === 'pi') ?? null;
}
