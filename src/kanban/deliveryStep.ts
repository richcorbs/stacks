import type { Project } from '../types';
import type { KanbanCardSummary } from './types';
import { PrRefreshSchedule } from './prRefreshSchedule';

export type PrCheck = { identity?: string; checkedAt: number | null; failed: boolean; refreshing: boolean };
export type DeliveryContext = { projects?: Project[]; prChecks?: Record<string, PrCheck>; now?: number };
export type DeliveryStep = { label: string; actionRequired: boolean; prMergeReady?: boolean };
const step = (label: string, actionRequired: boolean): DeliveryStep => ({ label, actionRequired });

/** UI projection only. Backend capabilities and fresh preflight remain the authority for every transition. */
export function deliveryStep(card: KanbanCardSummary, context: DeliveryContext = {}): DeliveryStep {
  if (card.hierarchy_finalized && card.child_count > 0) {
    // Finalized means the child breakdown is fixed, not that its work is done.
    // The backend rolls the parent's status up from its linked children.
    if (card.status === 'done') return step(card.children.length === card.child_count && card.children.every((child) => child.status === 'done')
      ? 'Children complete' : 'Child status unverified · Check hierarchy', false);
    const childSteps: Partial<Record<typeof card.status, string>> = {
      needs_refinement: 'Children in backlog', refining: 'Children refining',
      needs_refinement_input: 'Children need refinement input', ready: 'Children ready for agent',
      agent_working: 'Children working', needs_human: 'Children need review',
      approved: 'Children in delivery',
    };
    return step(childSteps[card.status] ?? 'Child status unknown', false);
  }
  if (card.status === 'done') return step(card.completion_outcome === 'merged' ? 'Delivered' : 'Closed', false);
  if (card.child_count > 0 && card.status === 'approved') return step('Children in delivery', false);
  if (card.status === 'needs_refinement') return step('Awaiting refinement', false);
  if (card.status === 'refining') return step('Refining', false);
  if (card.status === 'needs_refinement_input') return step('Refinement input needed', true);
  if (card.status === 'ready') return step('Start work', true);
  if (card.status === 'agent_working') return step('Agent working', false);
  if (card.status === 'needs_human') return step('Review & commit', true);
  if (card.status !== 'approved') return step('Status unknown', false);

  const project = context.projects?.find((item) => item.id === card.project_id);
  if (!project) return step('Project unavailable · Check setup', true);
  const stage = card.delivery_operation_stage;
  if (project.delivery_workflow === 'scripted_delivery') {
    switch (stage) {
      case 'merged': return step('Merged locally · Push', true);
      case 'pushing': return step('Pushing', false);
      case 'push_failed': return step('Push failed · Retry push', true);
      case 'pushed': return step('Pushed · Deploy', true);
      case 'deploying': return step('Deploying', false);
      case 'deployment_failed': return step('Deployment failed · Retry', true);
      case 'uncertain': return step('Deployment uncertain · Resolve', true);
      case 'deployed': return step('Deployed · Reconciling', false);
      case 'cancelled': return step('Delivery cancelled · Resolve', true);
    }
    if (!stage && card.delivery_error) return step(`Delivery blocked · ${card.delivery_error}`, true);
    if (!stage) return card.environment?.lifecycle_state === 'ready'
      ? step('Merge locally · Check & confirm', true) : step('Environment unavailable · Check setup', true);
  }
  if (stage === 'merging_pr' || stage === 'creating_pr' || stage === 'deleting_remote_branch') return step('Delivery in progress', false);
  if (stage === 'branch_pushed') return step('Branch pushed · Create PR', true);
  if (card.delivery_error) return step(`Delivery blocked · ${card.delivery_error}`, true);
  if (project.delivery_workflow === 'local_merge') {
    if (stage === 'merged') return step('Merged locally · Push failed', true);
    if (!card.environment || card.environment.lifecycle_state !== 'ready') return step('Environment unavailable · Check setup', true);
    return step('Merge locally · Check & confirm', true);
  }
  if (project.delivery_workflow !== 'github_pull_request') return step('Delivery setup unavailable', true);

  const pr = card.pull_request;
  if (!pr) return card.environment?.lifecycle_state === 'ready' ? step('Committed · Create PR', true) : step('Environment unavailable · Check setup', true);
  if (pr.state === 'merged') return step('PR merged · Reconciling', false);
  if (pr.state === 'closed') return step('PR closed · Resolve', true);
  const check = context.prChecks?.[card.id];
  // Project the card's last-known PR snapshot, including after reopening. Session
  // freshness/errors belong to the PR badge, not workflow grouping or readiness.
  // An explicitly obsolete observation must still never lend readiness to a new
  // card/environment/PR identity. The coordinator also rejects obsolete responses.
  if (check?.identity != null && check.identity !== new PrRefreshSchedule().identity(card, project)) {
    return step('PR status updating · Refresh', false);
  }
  if (pr.has_conflicts) return step('PR blocked · Resolve conflicts', true);
  if (pr.draft) return step('PR draft · Mark ready', true);
  if (pr.ci_status === 'pending' && pr.blockers.every((blocker) => blocker === 'CI is pending' || blocker === 'GitHub merge readiness is unknown or blocked')) return step('PR open · CI running', false);
  if (pr.ci_status === 'unknown') return step('PR checks unknown · Inspect', true);
  if (pr.blockers.length) return step(`PR blocked · ${pr.blockers[0]}`, true);
  return { ...step('PR merge available · Merge PR', true), prMergeReady: true };
}
