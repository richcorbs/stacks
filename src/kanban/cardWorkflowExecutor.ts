import type { CardWorkflowAction } from './workflowActions';
import type { KanbanCard } from './types';

export type CardWorkflowExecutorDependencies = {
  confirm: (title: string, detail: string) => boolean;
  isRunning: () => boolean;
  runExclusive: (kind: CardWorkflowAction['kind'], operation: () => Promise<void>) => Promise<boolean>;
  setError: (error: string | null) => void;
  setView: (view: 'chat') => void;
  refreshRepository: () => void;
  toast: (message: string) => void;
  openRefinement: () => Promise<boolean>;
  finishRefinement: () => Promise<void>;
  stopRefinement: () => Promise<unknown>;
  returnToRefinement: () => Promise<unknown>;
  startWork: () => Promise<boolean>;
  requestChanges: () => Promise<unknown>;
  approveAndCommit: () => Promise<{ message: string }>;
  mergeTarget: () => Promise<{ message: string }>;
  mergeLocal: () => Promise<{ message: string }>;
  push: () => Promise<{ message: string }>;
  deploy: (again: boolean) => Promise<void>;
  cancelDeployment: () => Promise<void>;
  confirmDeployed: () => Promise<void>;
  createPullRequest: (withFrontendEngineer: boolean) => Promise<void>;
  openPullRequest: () => Promise<void>;
  mergePullRequest: () => Promise<void>;
  cleanup: () => Promise<void>;
  cleanupCreation: () => Promise<void>;
  retryRuntimeCleanup: () => Promise<void>;
  close: () => Promise<void>;
  delete: () => Promise<void>;
};

const refreshActions = new Set<CardWorkflowAction['kind']>(['start_work', 'ship', 'merge_target', 'merge_local', 'create_pr', 'create_pr_with_fe', 'cleanup', 'cleanup_creation', 'retry_runtime_cleanup', 'close']);

/** Executes workflow sequencing without knowing React, Tauri, Pi, or persistence APIs. */
export async function executeCardWorkflowAction(action: CardWorkflowAction, card: Pick<KanbanCard, 'status'>, dependencies: CardWorkflowExecutorDependencies) {
  if (action.disabledReason) return false;
  const d = dependencies;
  if (action.kind === 'cancel_deployment') {
    d.setError(null);
    try { await d.cancelDeployment(); } catch (error) { d.setError(message(error)); }
    return true;
  }
  if (d.isRunning()) return false;
  if (action.confirmation && !d.confirm(action.confirmation.title, action.confirmation.detail)) return false;
  d.setError(null);
  try {
    const started = await d.runExclusive(action.kind, async () => {
      switch (action.kind) {
        case 'open_refinement': if (await d.openRefinement()) d.setView('chat'); break;
        case 'finish_refinement': await d.finishRefinement(); break;
        case 'stop_refinement': await d.stopRefinement(); break;
        case 'return_to_refinement': await d.returnToRefinement(); d.setView('chat'); break;
        case 'start_work': if (await d.startWork()) d.setView('chat'); break;
        case 'request_changes': if (card.status === 'approved') await d.requestChanges(); d.setView('chat'); break;
        case 'ship': d.toast((await d.approveAndCommit()).message); break;
        case 'merge_target': d.toast((await d.mergeTarget()).message); break;
        case 'merge_local': d.toast((await d.mergeLocal()).message); break;
        case 'push': case 'retry_push': d.toast((await d.push()).message); break;
        case 'deploy': case 'retry_deploy': await d.deploy(false); break;
        case 'run_deployment_again': await d.deploy(true); break;
        case 'cancel_deployment': break;
        case 'confirm_deployed': await d.confirmDeployed(); break;
        case 'create_pr': d.setView('chat'); await d.createPullRequest(false); break;
        case 'create_pr_with_fe': d.setView('chat'); await d.createPullRequest(true); break;
        case 'open_pr': await d.openPullRequest(); break;
        case 'merge_pr': await d.mergePullRequest(); break;
        case 'cleanup': await d.cleanup(); break;
        case 'cleanup_creation': await d.cleanupCreation(); break;
        case 'retry_runtime_cleanup': await d.retryRuntimeCleanup(); break;
        case 'close': await d.close(); break;
        case 'delete': await d.delete(); break;
      }
    });
    if (started && refreshActions.has(action.kind)) d.refreshRepository();
    return started;
  } catch (error) {
    d.setError(message(error));
    return false;
  }
}

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
