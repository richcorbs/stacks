import { describe, expect, it } from 'vitest';
import { AGENT_FAILURE_LABELS, AGENT_FAILURE_RECOVERY, activeAgentFailure, activeAgentRetry, actionableFailureLine, failureStatusText, isTransientAgentFailure, retryCountdownSeconds, retryDelaySeconds } from './agentFailure';
import type { AgentFailureClass, CardAgentFailure, CardAgentRetry, KanbanCardDetail } from './types';

const classes: AgentFailureClass[] = ['provider_overloaded', 'provider_auth', 'provider_unavailable', 'model_unavailable', 'protocol_failed', 'process_exited', 'launch_failed', 'setup_failed', 'agent_question', 'agent_stalled', 'unknown'];
const failure = (overrides: Partial<CardAgentFailure> = {}): CardAgentFailure => ({
  class: 'provider_overloaded', detail: '429 overloaded\n\nraw provider tail', event_type: 'agent_settled', created_at: 10, event_id: 10, ...overrides,
});
const retry = (overrides: Partial<CardAgentRetry> = {}): CardAgentRetry => ({
  state: 'scheduled', attempt: 1, max_attempts: 3, next_retry_at: Math.floor(Date.now() / 1000) + 12, created_at: 9, event_id: 9, ...overrides,
});
const card = (overrides: Partial<KanbanCardDetail> = {}) => ({ status: 'needs_human', agent_failure: failure(), agent_retry: null, creation_operation: null, ...overrides }) as KanbanCardDetail;

describe('agent failure taxonomy', () => {
  it('has one label and one recovery for every class', () => {
    for (const value of classes) {
      expect(AGENT_FAILURE_LABELS[value]).toBeTruthy();
      expect(AGENT_FAILURE_RECOVERY[value]).toBeTruthy();
    }
    expect(isTransientAgentFailure(failure())).toBe(true);
    expect(isTransientAgentFailure(failure({ class: 'provider_auth' }))).toBe(false);
  });

  it('shows the reason only while the card is waiting or setup is incomplete', () => {
    expect(activeAgentFailure(card())?.class).toBe('provider_overloaded');
    expect(activeAgentFailure(card({ status: 'done' }))).toBeNull();
    expect(activeAgentFailure(card({ status: 'ready', agent_failure: failure({ class: 'setup_failed' }), creation_operation: { phase: 'recovery_required' } as KanbanCardDetail['creation_operation'] }))?.class).toBe('setup_failed');
    expect(failureStatusText(card(), 'Needs you')).toBe('Needs you — provider overloaded');
    expect(failureStatusText(card({ status: 'ready', agent_failure: failure({ class: 'setup_failed', detail: 'Bundler::GemNotFound: missing gem\n\ntail' }) }), 'Ready for agent')).toBe('Setup failed — Bundler::GemNotFound: missing gem');
  });

  it('keeps the actionable line first and retry delays bounded', () => {
    expect(actionableFailureLine('\n  Bundler::GemNotFound: missing gem\nfull tail')).toBe('Bundler::GemNotFound: missing gem');
    expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([30, 15, 45, 45]);
    expect(retryCountdownSeconds(retry(), Date.now())).toBeGreaterThan(0);
    expect(activeAgentRetry(card({ agent_retry: retry() }))?.state).toBe('scheduled');
  });
});
