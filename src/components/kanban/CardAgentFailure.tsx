import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Project } from '../../types';
import { AsyncButtonLabel } from '../AsyncButtonLabel';
import {
  AGENT_FAILURE_LABELS,
  activeAgentFailure,
  activeAgentRetry,
  actionableFailureLine,
  agentFailureRecovery,
  isTransientAgentFailure,
  retryCountdownSeconds,
} from '../../kanban/agentFailure';
import {
  cardAgentController,
  cancelCardRetry,
  claimCardRetry,
  chooseCardModel,
  continueCardAgent,
  restartCardAgent,
  retryCardSetup,
  scheduleCardRetry,
} from '../../kanban/agentRecovery';
import { recordKanbanAgentRetry } from '../../kanban/api';
import type { KanbanCardDetail } from '../../kanban/types';

export function CardAgentFailure({ card, project, onCardUpdated, onStartWork, onError }: {
  card: KanbanCardDetail;
  project: Project;
  onCardUpdated: (card: KanbanCardDetail) => void;
  onStartWork: () => Promise<boolean>;
  onError: (message: string | null) => void;
}) {
  const failure = activeAgentFailure(card);
  const retry = activeAgentRetry(card);
  const controller = useMemo(() => cardAgentController(card, project), [card.id, card.environment?.worktree_path, project.id, project.path]);
  const pi = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [modelPicker, setModelPicker] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!modelPicker) return;
    controller.initializeAndHydrate().catch((value) => setError(value instanceof Error ? value.message : String(value)));
  }, [controller, modelPicker]);

  useEffect(() => {
    if (retry?.state !== 'scheduled') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retry?.state, retry?.next_retry_at]);

  if (!failure) return null;
  const recovery = agentFailureRecovery(failure);
  const line = actionableFailureLine(failure.detail);
  const countdown = retryCountdownSeconds(retry, now);
  const retryExhausted = retry?.state === 'attempted' && retry.attempt >= retry.max_attempts;
  const canChooseModel = recovery === 'choose_model' || (recovery === 'retry_transient' && modelPicker);
  const transient = isTransientAgentFailure(failure);

  const report = (value: unknown) => {
    const message = value instanceof Error ? value.message : String(value);
    setError(message);
    onError(message);
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    onError(null);
    try { await operation(); }
    catch (value) { report(value); }
    finally { setBusy(false); }
  };
  const applySnapshot = (snapshot: { card: KanbanCardDetail }) => onCardUpdated(snapshot.card);

  return <section className="cardAgentFailure" role="alert" aria-label="Agent failure recovery">
    <div className="cardAgentFailureSummary">
      <div>
        <strong>{AGENT_FAILURE_LABELS[failure.class]}</strong>
        {line && <code title={line}>{line}</code>}
      </div>
      {retry?.state === 'scheduled' && <small className="cardAgentRetryStatus">
        Retrying {retry.attempt} of {retry.max_attempts} in {countdown}s
      </small>}
      {retryExhausted && <small className="cardAgentRetryStatus">Retried {retry.max_attempts} of {retry.max_attempts}; still waiting on you</small>}
    </div>
    <div className="cardAgentFailureActions">
      {recovery === 'retry_transient' && (!retry || retryExhausted) && <button data-card-action="primary" className="primaryAction" type="button" disabled={busy} onClick={() => void run(async () => {
        applySnapshot(await scheduleCardRetry(card));
      })}><AsyncButtonLabel idle="Retry in 30s" busy="Scheduling…" isBusy={busy} /></button>}
      {retry?.state === 'scheduled' && <>
        <button data-card-action="primary" className="primaryAction" type="button" disabled={busy} onClick={() => void run(async () => {
          applySnapshot(await claimCardRetry(card, retry));
          await continueCardAgent(card, project);
        })}><AsyncButtonLabel idle="Retry now" busy="Retrying…" isBusy={busy} /></button>
        <button data-card-action="secondary" type="button" disabled={busy} onClick={() => void run(async () => {
          applySnapshot(await cancelCardRetry(card, retry));
        })}>Cancel retry</button>
      </>}
      {recovery === 'retry_transient' && <button data-card-action="secondary" type="button" disabled={busy} onClick={() => setModelPicker((current) => !current)}>Retry on another model</button>}
      {recovery === 'choose_model' && <button data-card-action="primary" className="primaryAction" type="button" disabled={busy} onClick={() => setModelPicker((current) => !current)}>Choose model</button>}
      {recovery === 'retry_setup' && <button data-card-action="primary" className="primaryAction" type="button" disabled={busy} onClick={() => void run(async () => {
        const updated = await retryCardSetup(card, project);
        onCardUpdated(updated);
        if (updated.environment) await onStartWork();
      })}><AsyncButtonLabel idle="Retry setup" busy="Retrying setup…" isBusy={busy} /></button>}
      {recovery === 'restart_pi' && <button data-card-action="primary" className="primaryAction" type="button" disabled={busy} onClick={() => void run(async () => {
        await restartCardAgent(card, project);
      })}><AsyncButtonLabel idle="Restart Pi" busy="Restarting…" isBusy={busy} /></button>}
      {recovery === 'continue_agent' && <button data-card-action="primary" className="primaryAction" type="button" disabled={busy} onClick={() => void run(async () => {
        await continueCardAgent(card, project, note);
        setNote('');
      })}><AsyncButtonLabel idle="Continue" busy="Continuing…" isBusy={busy} /></button>}
      {recovery === 'retry_start' && <button data-card-action="primary" className="primaryAction" type="button" disabled={busy} onClick={() => void run(async () => {
        await onStartWork();
      })}><AsyncButtonLabel idle="Retry start" busy="Retrying…" isBusy={busy} /></button>}
      {retryExhausted && transient && <button data-card-action="secondary" type="button" disabled={busy} onClick={() => void run(async () => {
        applySnapshot(await recordKanbanAgentRetry(card.id, 'agent_retry_cancelled', retry.attempt, retry.max_attempts, null));
      })}>Reset retries</button>}
    </div>
    {recovery === 'continue_agent' && <label className="cardAgentFailureNote">
      <span>Optional note</span>
      <input value={note} placeholder="What should the agent do next?" disabled={busy} onChange={(event) => setNote(event.target.value)} />
    </label>}
    {canChooseModel && modelPicker && <div className="cardAgentModelPicker" role="listbox" aria-label="Choose a Pi model">
      {pi.effectiveModels.length === 0 && <small>No configured models.</small>}
      {pi.effectiveModels.map((model) => <button type="button" role="option" aria-selected={model.id === pi.context.modelId && model.provider === pi.context.provider}
        key={`${model.provider}:${model.id}`} disabled={busy} onClick={() => void run(async () => {
          await chooseCardModel(card, project, model);
          setModelPicker(false);
        })}>
        <strong>{model.name || model.id}</strong><small>{model.provider} · {model.id}</small>
      </button>)}
    </div>}
    {error && <div className="kanbanActionError" role="alert">{error}</div>}
    <details className="cardAgentFailureDetail">
      <summary>Full error log</summary>
      <pre>{failure.detail || line || 'No detail was recorded.'}</pre>
    </details>
  </section>;
}
