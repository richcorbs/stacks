import { describe, expect, it, vi } from 'vitest';
import { executeCardWorkflowAction, type CardWorkflowExecutorDependencies } from './cardWorkflowExecutor';
import type { CardWorkflowAction, CardWorkflowActionKind } from './workflowActions';

function setup() {
  const calls: string[] = [];
  const dependency = (name: string, value?: unknown) => vi.fn(async () => { calls.push(name); return value; });
  const dependencies = {
    confirm: vi.fn(() => true), isRunning: vi.fn(() => false),
    runExclusive: vi.fn(async (_kind, operation) => { await operation(); return true; }),
    setError: vi.fn(), setView: vi.fn(), refreshRepository: vi.fn(), toast: vi.fn(),
    openRefinement: dependency('openRefinement'), finishRefinement: dependency('finishRefinement'), stopRefinement: dependency('stopRefinement'),
    returnToRefinement: dependency('returnToRefinement'), startWork: dependency('startWork', true), requestChanges: dependency('requestChanges'),
    approveAndCommit: dependency('approveAndCommit', { message: 'committed' }), mergeTarget: dependency('mergeTarget', { message: 'resolved' }),
    mergeLocal: dependency('mergeLocal', { message: 'merged' }), push: dependency('push', { message: 'pushed' }), deploy: dependency('deploy'),
    cancelDeployment: dependency('cancelDeployment'), confirmDeployed: dependency('confirmDeployed'), createPullRequest: dependency('createPullRequest'),
    openPullRequest: dependency('openPullRequest'), mergePullRequest: dependency('mergePullRequest'), cleanup: dependency('cleanup'),
    cleanupCreation: dependency('cleanupCreation'), retryRuntimeCleanup: dependency('retryRuntimeCleanup'), close: dependency('close'), delete: dependency('delete'),
  } as unknown as CardWorkflowExecutorDependencies;
  return { dependencies, calls };
}

const expectedCapability: Partial<Record<CardWorkflowActionKind, string>> = {
  open_refinement: 'openRefinement', finish_refinement: 'finishRefinement', stop_refinement: 'stopRefinement', return_to_refinement: 'returnToRefinement',
  start_work: 'startWork', request_changes: 'requestChanges', ship: 'approveAndCommit', merge_target: 'mergeTarget', merge_local: 'mergeLocal',
  push: 'push', retry_push: 'push', deploy: 'deploy', retry_deploy: 'deploy', run_deployment_again: 'deploy', confirm_deployed: 'confirmDeployed',
  create_pr: 'createPullRequest', create_pr_with_fe: 'createPullRequest', open_pr: 'openPullRequest', merge_pr: 'mergePullRequest', cleanup: 'cleanup',
  cleanup_creation: 'cleanupCreation', retry_runtime_cleanup: 'retryRuntimeCleanup', close: 'close', delete: 'delete', cancel_deployment: 'cancelDeployment',
};

function action(kind: CardWorkflowActionKind, extra: Partial<CardWorkflowAction> = {}): CardWorkflowAction {
  return { kind, label: kind, ...extra };
}

describe('executeCardWorkflowAction', () => {
  it.each(Object.entries(expectedCapability) as [CardWorkflowActionKind, string][])('routes %s to its injected capability', async (kind, expected) => {
    const { dependencies, calls } = setup();
    await executeCardWorkflowAction(action(kind), { status: 'approved' }, dependencies);
    expect(calls).toContain(expected);
  });

  it('preserves confirmation cancellation, exclusion, and disabled actions', async () => {
    const first = setup(); first.dependencies.confirm = vi.fn(() => false);
    expect(await executeCardWorkflowAction(action('delete', { confirmation: { title: 'Delete?', detail: 'Forever' } }), { status: 'ready' }, first.dependencies)).toBe(false);
    expect(first.dependencies.runExclusive).not.toHaveBeenCalled();
    const busy = setup(); busy.dependencies.isRunning = () => true;
    await executeCardWorkflowAction(action('close'), { status: 'ready' }, busy.dependencies);
    expect(busy.dependencies.runExclusive).not.toHaveBeenCalled();
    const disabled = setup();
    await executeCardWorkflowAction(action('close', { disabledReason: 'Nope' }), { status: 'ready' }, disabled.dependencies);
    expect(disabled.dependencies.isRunning).not.toHaveBeenCalled();
  });

  it('reports errors and handles deployment cancellation outside the exclusive operation', async () => {
    const failed = setup(); failed.dependencies.mergeLocal = vi.fn(async () => { throw new Error('merge failed'); });
    expect(await executeCardWorkflowAction(action('merge_local'), { status: 'approved' }, failed.dependencies)).toBe(false);
    expect(failed.dependencies.setError).toHaveBeenLastCalledWith('merge failed');
    const cancellation = setup();
    await executeCardWorkflowAction(action('cancel_deployment'), { status: 'approved' }, cancellation.dependencies);
    expect(cancellation.dependencies.cancelDeployment).toHaveBeenCalledOnce();
    expect(cancellation.dependencies.runExclusive).not.toHaveBeenCalled();
  });

  it('only requests changes from approved and refreshes repository actions', async () => {
    const notApproved = setup();
    await executeCardWorkflowAction(action('request_changes'), { status: 'needs_human' }, notApproved.dependencies);
    expect(notApproved.dependencies.requestChanges).not.toHaveBeenCalled();
    expect(notApproved.dependencies.setView).toHaveBeenCalledWith('chat');
    const refresh = setup();
    await executeCardWorkflowAction(action('ship'), { status: 'needs_human' }, refresh.dependencies);
    expect(refresh.dependencies.toast).toHaveBeenCalledWith('committed');
    expect(refresh.dependencies.refreshRepository).toHaveBeenCalledOnce();
  });
});
