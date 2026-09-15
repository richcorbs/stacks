import { describe, expect, it, vi } from 'vitest';
import { disposeAcceptedRuntimeOutcomes } from './runtimeCleanup';
import type { RuntimeResourceOutcome } from './api';

describe('accepted card runtime cleanup', () => {
  it('disposes only backend-confirmed stopped processes using returned IDs', () => {
    const disposePi = vi.fn();
    const disposeTerminal = vi.fn();
    const outcomes: RuntimeResourceOutcome[] = [
      { resource_type: 'pi_process', id: 'backend:pi', success: true, error: null },
      { resource_type: 'pi_session', id: 'backend:pi', success: false, error: 'files retained' },
      { resource_type: 'pty', id: 'backend:terminal:ok', success: true, error: null },
      { resource_type: 'pty', id: 'backend:terminal:failed', success: false, error: 'still running' },
    ];

    disposeAcceptedRuntimeOutcomes(outcomes, disposePi, disposeTerminal);

    expect(disposePi).toHaveBeenCalledOnce();
    expect(disposePi).toHaveBeenCalledWith('backend:pi');
    expect(disposeTerminal).toHaveBeenCalledOnce();
    expect(disposeTerminal).toHaveBeenCalledWith('backend:terminal:ok');
  });

  it('does nothing when no accepted result is available', () => {
    const disposePi = vi.fn();
    const disposeTerminal = vi.fn();
    disposeAcceptedRuntimeOutcomes([], disposePi, disposeTerminal);
    expect(disposePi).not.toHaveBeenCalled();
    expect(disposeTerminal).not.toHaveBeenCalled();
  });
});
