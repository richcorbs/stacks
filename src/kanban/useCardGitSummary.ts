import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GitChangeSummary } from '../types';
import { REFRESH_CARD_REPOSITORY_STATUS_EVENT } from './useCardRepositoryStatus';

type SummaryState = {
  environmentKey: string | null;
  summary: GitChangeSummary | null;
};

export function useCardGitSummary(path: string | null, targetBranch: string | null, intervalMs = 30_000) {
  const environmentKey = path && targetBranch ? `${path}\0${targetBranch}` : null;
  const [state, setState] = useState<SummaryState>({ environmentKey: null, summary: null });

  useEffect(() => {
    if (!environmentKey || !path || !targetBranch) {
      setState({ environmentKey: null, summary: null });
      return;
    }

    let cancelled = false;
    let generation = 0;
    const refresh = async () => {
      const requestGeneration = ++generation;
      const summary = await invoke<GitChangeSummary>('git_change_summary', { path, targetBranch })
        .catch(() => null);
      if (!cancelled && requestGeneration === generation) {
        setState({ environmentKey, summary });
      }
    };
    const requestRefresh = () => { refresh().catch(console.error); };

    requestRefresh();
    window.addEventListener(REFRESH_CARD_REPOSITORY_STATUS_EVENT, requestRefresh);
    const timer = window.setInterval(requestRefresh, intervalMs);
    return () => {
      cancelled = true;
      generation += 1;
      window.removeEventListener(REFRESH_CARD_REPOSITORY_STATUS_EVENT, requestRefresh);
      window.clearInterval(timer);
    };
  }, [environmentKey, intervalMs, path, targetBranch]);

  return state.environmentKey === environmentKey ? state.summary : null;
}
