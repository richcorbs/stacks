import { useCallback, useRef, useState } from 'react';
import type { CardWorkflowActionKind } from './workflowActions';

/**
 * Owns the complete lifetime of one card workflow operation.
 *
 * The ref closes the same-event duplicate-click gap synchronously, while the
 * operation state is the single rendered source of truth for disabled actions
 * and progress UI.
 */
export function useWorkflowOperation() {
  const [operation, setOperation] = useState<CardWorkflowActionKind | null>(null);
  const runningRef = useRef(false);

  const isRunning = useCallback(() => runningRef.current, []);
  const run = useCallback(async (kind: CardWorkflowActionKind, action: () => Promise<unknown>) => {
    if (runningRef.current) return false;
    runningRef.current = true;
    setOperation(kind);
    try {
      await action();
      return true;
    } finally {
      setOperation(null);
      runningRef.current = false;
    }
  }, []);

  return {
    operation,
    working: operation !== null,
    isRunning,
    run,
  };
}
