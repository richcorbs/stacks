import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GitInfo } from '../types';

export function useGitInfo(path: string | null, intervalMs = 10_000) {
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);

  useEffect(() => {
    if (!path) {
      setGitInfo(null);
      return;
    }

    let cancelled = false;
    const refreshGitInfo = () => {
      invoke<GitInfo | null>('git_info', { path })
        .then((info) => { if (!cancelled) setGitInfo(info); })
        .catch(() => { if (!cancelled) setGitInfo(null); });
    };

    refreshGitInfo();
    const interval = window.setInterval(refreshGitInfo, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [path, intervalMs]);

  return gitInfo;
}
