import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import type { KanbanCardSummary } from './types';
import { deliveryStep } from './deliveryStep';
import { PrRefreshSchedule } from './prRefreshSchedule';
import { groupCards, BOARD_GROUPS, WORK_GROUPS } from './workflowGroups';
import { adjacentBoardCard, adjacentListCard } from './boardNavigation';

const project = { id: 'p', path: '/repo', delivery_workflow: 'github_pull_request' } as Project;
const card = { id: 'c', external_id: '7', title: 'Task', status: 'approved', project_id: 'p', child_count: 0,
  environment: { lifecycle_state: 'ready' }, pull_request: { state: 'open', draft: false, ci_status: 'pending',
    blockers: ['CI is pending'], has_conflicts: false } } as KanbanCardSummary;
const context = (c: KanbanCardSummary = card, p = project) => ({ projects: [p], now: 5000,
  prChecks: { [c.id]: { checkedAt: 4000, failed: false, refreshing: false, identity: new PrRefreshSchedule().identity(c, p) } } });

describe('delivery-step projection', () => {
  it('keeps waiting CI in progress and last-known unblocked readiness actionable independently of freshness', () => {
    expect(deliveryStep(card, context())).toEqual({ label: 'PR open · CI running', actionRequired: false });
    const clear = { ...card, pull_request: { ...card.pull_request!, ci_status: 'success' as const, blockers: [] } };
    expect(deliveryStep(clear, context(clear))).toEqual({ label: 'PR merge available · Merge PR', actionRequired: true });
    const expected = { label: 'PR merge available · Merge PR', actionRequired: true };
    expect(deliveryStep(clear, { projects: [project] })).toEqual(expected);
    expect(deliveryStep(clear, { ...context(clear), now: 300_000 })).toEqual(expected);
    for (const flags of [{ refreshing: true }, { failed: true }, { refreshing: true, failed: true }, { checkedAt: null }]) {
      expect(deliveryStep(clear, { ...context(clear), prChecks: { c: { ...context(clear).prChecks.c, ...flags } } })).toEqual(expected);
    }
    expect(deliveryStep(clear, { ...context(clear), prChecks: { c: { ...context(clear).prChecks.c, identity: 'old head' } } }).actionRequired).toBe(false);
  });
  it('does not reuse an observation across PR, workflow or environment identity changes', () => {
    const clear = { ...card, pull_request: { ...card.pull_request!, number: 42, ci_status: 'success' as const, blockers: [] } };
    for (const replaced of [
      { ...clear, pull_request: { ...clear.pull_request, number: 43 } },
      { ...clear, workflow_revision: 2 },
      { ...clear, environment: { ...clear.environment!, revision: 2, branch: 'replacement' } },
    ]) {
      expect(deliveryStep(replaced, context(clear))).toEqual({ label: 'PR status updating · Refresh', actionRequired: false });
    }
    const pending = { ...clear, pull_request: { ...clear.pull_request, ci_status: 'pending' as const, blockers: ['CI is pending'] } };
    expect(deliveryStep(pending, context(pending))).toEqual({ label: 'PR open · CI running', actionRequired: false });
  });
  it('shows PR blockers, draft, changed head, absent optional CI, closed and merged distinctly', () => {
    for (const blocker of ['CI is failing', 'A current approval is required', 'Pull request has changes that have not been approved; commit updates before merging']) {
      const blocked = { ...card, pull_request: { ...card.pull_request!, ci_status: 'failure' as const, blockers: [blocker] } };
      expect(deliveryStep(blocked, context(blocked))).toMatchObject({ actionRequired: true, label: `PR blocked · ${blocker}` });
    }
    const conflicts = { ...card, pull_request: { ...card.pull_request!, ci_status: 'success' as const, has_conflicts: true, blockers: [] } };
    expect(deliveryStep(conflicts, { projects: [project] }).label).toBe('PR blocked · Resolve conflicts');
    const draft = { ...card, pull_request: { ...card.pull_request!, ci_status: 'success' as const, draft: true, blockers: ['Pull request is a draft'] } };
    expect(deliveryStep(draft, context(draft)).label).toBe('PR draft · Mark ready');
    const merged = { ...card, pull_request: { ...card.pull_request!, state: 'merged' as const } };
    expect(deliveryStep(merged, context(merged))).toEqual({ label: 'PR merged · Reconciling', actionRequired: false });
    const noCi = { ...card, pull_request: { ...card.pull_request!, ci_status: 'no_ci' as const, blockers: [] } };
    expect(deliveryStep(noCi, context(noCi)).label).toBe('PR merge available · Merge PR');
    const closed = { ...card, pull_request: { ...card.pull_request!, state: 'closed' as const } };
    expect(deliveryStep(closed, context(closed)).label).toBe('PR closed · Resolve');
  });
  it('distinguishes local merge, PR creation, scripted stages and unavailable setup', () => {
    expect(deliveryStep({ ...card, pull_request: null }, context({ ...card, pull_request: null })).label).toBe('Committed · Create PR');
    expect(deliveryStep(card, { projects: [] }).label).toBe('Project unavailable · Check setup');
    expect(deliveryStep(card, { projects: [{ ...project, delivery_workflow: 'local_merge' }] }).label).toBe('Merge locally · Check & confirm');
    const scripted = { ...project, delivery_workflow: 'scripted_delivery' } as Project;
    for (const [stage, label, actionRequired] of [
      ['merged', 'Merged locally · Push', true], ['pushing', 'Pushing', false], ['push_failed', 'Push failed · Retry push', true],
      ['pushed', 'Pushed · Deploy', true], ['deploying', 'Deploying', false], ['deployment_failed', 'Deployment failed · Retry', true],
      ['uncertain', 'Deployment uncertain · Resolve', true], ['deployed', 'Deployed · Reconciling', false],
    ] as const) expect(deliveryStep({ ...card, delivery_operation_stage: stage }, { projects: [scripted] })).toEqual({ label, actionRequired });
  });
  it('labels finalized parents by actual child progress, not breakdown finalization', () => {
    const backlog = { ...card, status: 'needs_refinement' as const, child_count: 2, hierarchy_finalized: true,
      children: [{ status: 'needs_refinement' }, { status: 'done' }] } as KanbanCardSummary;
    expect(deliveryStep(backlog, context(backlog))).toEqual({ label: 'Children in backlog', actionRequired: false });
    expect(groupCards([backlog], BOARD_GROUPS[0], context(backlog))).toEqual([backlog]);
    const approved = { ...backlog, status: 'approved' as const, children: [{ status: 'approved' }, { status: 'done' }] } as KanbanCardSummary;
    expect(deliveryStep(approved, context(approved))).toEqual({ label: 'Children in delivery', actionRequired: false });
    expect(deliveryStep({ ...approved, hierarchy_finalized: false }, context(approved))).toEqual({ label: 'Children in delivery', actionRequired: false });
    const complete = { ...backlog, status: 'done' as const, children: [{ status: 'done' }, { status: 'done' }] } as KanbanCardSummary;
    expect(deliveryStep(complete, context(complete))).toEqual({ label: 'Children complete', actionRequired: false });
    expect(groupCards([complete], BOARD_GROUPS[3], context(complete))).toEqual([complete]);
    expect(deliveryStep({ ...complete, children: [{ status: 'done' }] } as KanbanCardSummary, context(complete)).label).toBe('Child status unverified · Check hierarchy');
  });
  it('uses the same projection for board/list counts and navigation without duplicates', () => {
    const ready = { ...card, id: 'ready', status: 'ready' as const };
    const clear = { ...card, id: 'clear', pull_request: { ...card.pull_request!, ci_status: 'success' as const, blockers: [] } };
    const cards = [card, ready, clear];
    const checks = { ...context(card).prChecks, ...context(clear).prChecks };
    for (const ctx of [
      { projects: [project], now: 5000, prChecks: checks },
      { projects: [project], now: 300_000, prChecks: checks },
      { projects: [project] }, // Reopened board, before its first remote read.
      ...[{ refreshing: true }, { failed: true }, { failed: true, refreshing: true }].map((flags) => ({
        projects: [project], prChecks: { ...checks, clear: { ...checks.clear, ...flags } },
      })),
    ]) {
      for (const groups of [BOARD_GROUPS, WORK_GROUPS]) {
        const grouped = groups.map((group) => groupCards(cards, group, ctx));
        expect(grouped.flat().map((item) => item.id).sort()).toEqual(['c', 'clear', 'ready']);
        expect(grouped[groups.findIndex((group) => group.id === 'progress')].map((item) => item.id)).toEqual(['c']);
        expect(grouped[groups.findIndex((group) => group.id === 'attention')].map((item) => item.id)).toEqual(['ready', 'clear']);
      }
      expect(deliveryStep(clear, ctx).label).toBe('PR merge available · Merge PR');
      expect(adjacentListCard(cards, 'clear', 'j', ctx)?.id).toBe('c');
      expect(adjacentBoardCard(cards, 'c', 'l', ctx)?.id).toBe('ready');
    }
  });
});
