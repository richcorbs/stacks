import type { RuntimeResourceOutcome } from './api';

/** Dispose frontend runtime state only when backend teardown confirmed the process stopped. */
export function disposeAcceptedRuntimeOutcomes(
  outcomes: RuntimeResourceOutcome[],
  disposePiController: (id: string) => void,
  disposeTerminal: (id: string) => void,
) {
  for (const outcome of outcomes) {
    if (!outcome.success) continue;
    if (outcome.resource_type === 'pi_process') disposePiController(outcome.id);
    if (outcome.resource_type === 'pty') disposeTerminal(outcome.id);
  }
}
