import { useCallback, useState } from 'react';

/** Refresh on every accepted Diff selection, including reselecting the active tab.
 * Selection adapters retain their own availability/unsaved-edit guards. */
export function useWorkDiffRefresh() {
  const [diffRefreshNonce, setDiffRefreshNonce] = useState(0);
  const refreshDiff = useCallback(() => setDiffRefreshNonce((nonce) => nonce + 1), []);
  const onViewSelected = useCallback((view: string) => { if (view === 'diff') refreshDiff(); }, [refreshDiff]);
  return { diffRefreshNonce, refreshDiff, onViewSelected };
}
