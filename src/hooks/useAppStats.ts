import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AppStats } from '../types';

export function useAppStats(intervalMs = 5_000) {
  const [appStats, setAppStats] = useState<AppStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refreshStats = () => {
      invoke<AppStats>('app_stats')
        .then((stats) => { if (!cancelled) setAppStats(stats); })
        .catch(() => { if (!cancelled) setAppStats(null); });
    };
    refreshStats();
    const interval = window.setInterval(refreshStats, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [intervalMs]);

  return appStats;
}
