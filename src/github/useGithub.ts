import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { GithubRequestGate, githubPollMilliseconds } from './requestGate';
import type {
  GithubActionRun,
  GithubActionRunsResponse,
  GithubMergeStrategy,
  GithubPullRequest,
  GithubPullRequestsResponse,
} from './types';

export function useGithub(path: string | null, pollSeconds: number, enabled: boolean, mergeStrategy: GithubMergeStrategy) {
  const [pullRequests, setPullRequests] = useState<GithubPullRequest[]>([]);
  const [pullRequestRepository, setPullRequestRepository] = useState<string | null>(null);
  const [actionRuns, setActionRuns] = useState<GithubActionRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [pullRequestError, setPullRequestError] = useState<string | null>(null);
  const [actionRunsError, setActionRunsError] = useState<string | null>(null);
  const [mergingNumber, setMergingNumber] = useState<number | null>(null);
  const requestGate = useRef(new GithubRequestGate());

  const refresh = useCallback(async () => {
    if (!path || !enabled) return;
    const generation = requestGate.current.begin(path);
    if (generation === null) return;
    setLoading(true);
    const [pullRequestResult, actionRunsResult] = await Promise.allSettled([
      invoke<GithubPullRequestsResponse>('github_pull_requests', { path }),
      invoke<GithubActionRunsResponse>('github_action_runs', { path }),
    ]);
    requestGate.current.finish(path);
    if (!requestGate.current.isCurrent(generation)) return;
    if (pullRequestResult.status === 'fulfilled') {
      setPullRequests(pullRequestResult.value.pull_requests);
      setPullRequestRepository(pullRequestResult.value.repository);
      setPullRequestError(null);
    } else {
      setPullRequestError(errorMessage(pullRequestResult.reason));
    }
    if (actionRunsResult.status === 'fulfilled') {
      setActionRuns(actionRunsResult.value.action_runs);
      setActionRunsError(null);
    } else {
      setActionRunsError(errorMessage(actionRunsResult.reason));
    }
    setLoading(false);
  }, [enabled, path]);

  useEffect(() => {
    requestGate.current.invalidate();
    setPullRequests([]);
    setPullRequestRepository(null);
    setActionRuns([]);
    setPullRequestError(null);
    setActionRunsError(null);
    setLoading(false);
    if (!path || !enabled) return;
    refresh().catch(console.error);
    const timer = window.setInterval(() => refresh().catch(console.error), githubPollMilliseconds(pollSeconds));
    return () => {
      window.clearInterval(timer);
      requestGate.current.invalidate();
    };
  }, [enabled, path, pollSeconds, refresh]);

  const mergePullRequest = useCallback(async (repository: string, number: number) => {
    setMergingNumber(number);
    try {
      await invoke('github_merge_pull_request', { repository, number, strategy: mergeStrategy });
      await refresh();
      return true;
    } catch (requestError) {
      setPullRequestError(errorMessage(requestError));
      return false;
    } finally {
      setMergingNumber(null);
    }
  }, [mergeStrategy, refresh]);

  return {
    pullRequests,
    pullRequestRepository,
    actionRuns,
    loading,
    pullRequestError,
    actionRunsError,
    mergingNumber,
    refresh,
    mergePullRequest,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
