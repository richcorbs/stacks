import type { AgentFailureClass, CardAgentFailure, CardAgentRetry, KanbanCardDetail } from './types';

export type AgentFailureRecovery = 'retry_transient' | 'choose_model' | 'retry_setup' | 'restart_pi' | 'continue_agent' | 'retry_start';

export const AGENT_FAILURE_LABELS: Record<AgentFailureClass, string> = {
  provider_overloaded: 'Provider overloaded',
  provider_auth: 'Provider authentication failed',
  provider_unavailable: 'Provider unavailable',
  model_unavailable: 'Model unavailable',
  protocol_failed: 'Pi protocol failed',
  process_exited: 'Pi process exited',
  launch_failed: 'Agent launch failed',
  setup_failed: 'Setup failed',
  agent_question: 'Agent asked a question',
  agent_stalled: 'Agent stopped',
  unknown: 'Agent stopped unexpectedly',
};

export const AGENT_FAILURE_RECOVERY: Record<AgentFailureClass, AgentFailureRecovery> = {
  provider_overloaded: 'retry_transient',
  provider_auth: 'choose_model',
  provider_unavailable: 'retry_transient',
  model_unavailable: 'choose_model',
  protocol_failed: 'restart_pi',
  process_exited: 'restart_pi',
  launch_failed: 'retry_start',
  setup_failed: 'retry_setup',
  agent_question: 'continue_agent',
  agent_stalled: 'continue_agent',
  unknown: 'restart_pi',
};

export const AGENT_RETRY_MAX_ATTEMPTS = 3;
export const AGENT_RETRY_DELAYS_SECONDS = [30, 15, 45] as const;

export function isTransientAgentFailure(failure: CardAgentFailure | null | undefined) {
  return failure?.class === 'provider_overloaded' || failure?.class === 'provider_unavailable';
}

export function agentFailureRecovery(failure: CardAgentFailure): AgentFailureRecovery {
  return AGENT_FAILURE_RECOVERY[failure.class] ?? 'restart_pi';
}

/** The actionable line is first by backend contract; keep the full detail untouched. */
export function actionableFailureLine(detail: string): string {
  return detail.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
}

export function activeAgentFailure(card: { status: KanbanCardDetail['status']; agent_failure?: CardAgentFailure | null; creation_operation?: { phase?: string } | null }): CardAgentFailure | null {
  const failure = card.agent_failure ?? null;
  if (!failure) return null;
  if (failure.class === 'setup_failed' || card.creation_operation?.phase === 'recovery_required') return failure;
  return card.status === 'needs_human' || card.status === 'needs_refinement_input' ? failure : null;
}

export function failureStatusText(card: { status: KanbanCardDetail['status']; agent_failure?: CardAgentFailure | null; creation_operation?: { phase?: string } | null }, base: string): string {
  const failure = activeAgentFailure(card);
  if (!failure) return base;
  if (failure.class === 'setup_failed' || card.creation_operation?.phase === 'recovery_required') {
    const line = actionableFailureLine(failure.detail);
    return line ? `Setup failed — ${line}` : 'Setup failed';
  }
  const label = AGENT_FAILURE_LABELS[failure.class].toLocaleLowerCase();
  return `${base} — ${label}`;
}

export function activeAgentRetry(card: { status: KanbanCardDetail['status']; agent_retry?: CardAgentRetry | null; agent_failure?: CardAgentFailure | null; creation_operation?: { phase?: string } | null }): CardAgentRetry | null {
  return activeAgentFailure(card) ? card.agent_retry ?? null : null;
}

export function retryDelaySeconds(attempt: number): number {
  return AGENT_RETRY_DELAYS_SECONDS[Math.max(0, Math.min(attempt - 1, AGENT_RETRY_DELAYS_SECONDS.length - 1))];
}

export function retryCountdownSeconds(retry: CardAgentRetry | null, now = Date.now()): number {
  if (!retry?.next_retry_at) return 0;
  return Math.max(0, Math.ceil(retry.next_retry_at - now / 1000));
}
