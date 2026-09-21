import type { PiRpcEnvelope } from '../pi/types';
import type { PiUiRequestWorkflowHandler } from '../pi/uiRequestWorkflow';
import type { CardSnapshot, KanbanCardDetail, KanbanCardSummary, PiLifecycleIntent } from './types';

type CardThread = 'planning' | 'work';
export type LifecycleSession = { lifecycleGeneration(): string | null; stopRefinement(): Promise<void> };

export type WorkflowLifecycleDependencies = {
  card: (id: string) => KanbanCardSummary | undefined;
  applyCard: (card: KanbanCardSummary, boardRevision?: number) => KanbanCardSummary;
  applyIntent: (id: string, thread: CardThread, intent: PiLifecycleIntent, generation: string, eventId: string, eventOrder?: number, failureDetail?: string) => Promise<CardSnapshot>;
  applyAction: (id: string, action: 'return_to_refinement' | 'request_changes' | 'stop_refinement', expectedRevision: number) => Promise<CardSnapshot>;
  subscribePi: (listener: (envelope: PiRpcEnvelope) => void) => Promise<() => void>;
  registerUiRequests: (handler: PiUiRequestWorkflowHandler) => () => void;
  session: (paneId: string) => LifecycleSession | undefined;
  load: () => Promise<void>;
  loadDetails: (card: KanbanCardSummary) => Promise<KanbanCardDetail | KanbanCardSummary>;
  reportError: (message: string) => void;
};

/** Serializes all automatic workflow projections for each canonical card. */
export class KanbanWorkflowLifecycleService {
  private transitions = new Map<string, Promise<void>>();
  private uiBlocks = new Map<string, { generation: string; transition: Promise<KanbanCardSummary | null> }>();
  private unsubscribePi?: () => void;
  private unregisterUi?: () => void;
  private disposed = false;

  constructor(private dependencies: WorkflowLifecycleDependencies) {}

  start() {
    this.unregisterUi = this.dependencies.registerUiRequests({
      received: (paneId, requestId, viewOpen) => this.uiRequestReceived(paneId, requestId, viewOpen),
      beforeResponse: (paneId, requestId) => this.reconcileUiRequest(paneId, requestId, true),
      dismissed: (paneId, requestId, restore) => this.reconcileUiRequest(paneId, requestId, false, restore),
    });
    this.dependencies.subscribePi(this.handleEnvelope).then((unsubscribe) => {
      if (this.disposed) unsubscribe();
      else this.unsubscribePi = unsubscribe;
    }).catch((error) => this.dependencies.reportError(`Pi lifecycle events could not be observed: ${errorMessage(error)}`));
  }

  dispose() {
    this.disposed = true;
    this.unsubscribePi?.();
    this.unregisterUi?.();
    this.uiBlocks.clear();
    this.transitions.clear();
  }

  async act(id: string, action: 'return_to_refinement' | 'request_changes') {
    const current = this.dependencies.card(id);
    if (!current) throw new Error('Card was not found; reload the board');
    try {
      const snapshot = await this.dependencies.applyAction(id, action, current.workflow_revision);
      return this.dependencies.applyCard(snapshot.card, snapshot.board_revision);
    } catch (error) {
      this.dependencies.reportError(errorMessage(error));
      throw error;
    }
  }

  async stopRefinement(id: string) {
    const paneId = `kanban-card:${id}:planning`;
    for (const key of this.uiBlocks.keys()) if (key.startsWith(`${paneId}:`)) this.uiBlocks.delete(key);
    const current = this.dependencies.card(id);
    if (!current || !['refining', 'needs_refinement_input'].includes(current.status)) throw new Error('Card is no longer being refined; reload the board');
    const snapshot = await this.dependencies.applyAction(id, 'stop_refinement', current.workflow_revision);
    const updated = this.dependencies.applyCard(snapshot.card, snapshot.board_revision);
    await this.dependencies.session(paneId)?.stopRefinement();
    return updated;
  }

  private enqueue(cardId: string, thread: CardThread, intent: PiLifecycleIntent, generation: string, eventId: string, eventOrder?: number, failurePrefix?: string, expectedRevision?: number, failureDetail?: string) {
    const previous = this.transitions.get(cardId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(async () => {
      if (this.disposed) return null;
      const current = this.dependencies.card(cardId);
      if (!current || (expectedRevision !== undefined && current.workflow_revision !== expectedRevision)) return null;
      const snapshot = await this.dependencies.applyIntent(cardId, thread, intent, generation, eventId, eventOrder, failureDetail);
      if (this.disposed || !this.dependencies.card(cardId)) return null;
      return this.dependencies.applyCard(snapshot.card, snapshot.board_revision);
    });
    const gate = result.then(() => undefined, (error) => {
      const message = `${failurePrefix ?? 'Card status could not be updated'}: ${errorMessage(error)}`;
      this.dependencies.reportError(message);
      if (!this.disposed) this.dependencies.load().catch(() => {});
    });
    this.transitions.set(cardId, gate);
    gate.finally(() => { if (this.transitions.get(cardId) === gate) this.transitions.delete(cardId); }).catch(() => {});
    return result.catch(() => null);
  }

  private uiRequestReceived(paneId: string, requestId: string, viewOpen: boolean) {
    const session = cardAgentSession(paneId);
    if (!session || (session.thread === 'work' && viewOpen)) return;
    const key = `${paneId}:${requestId}`;
    if (this.uiBlocks.has(key)) return;
    const generation = this.dependencies.session(paneId)?.lifecycleGeneration();
    if (!generation) return;
    this.uiBlocks.set(key, { generation, transition: this.enqueue(session.cardId, session.thread, 'ui_input_requested', generation, `ui:${requestId}:requested`, undefined,
      session.thread === 'planning' ? 'Pi needs refinement input, but the card status could not be updated' : 'Pi needs input, but the card status could not be updated') });
  }

  private async reconcileUiRequest(paneId: string, requestId: string, responding: boolean, restoreWorking = true) {
    const key = `${paneId}:${requestId}`;
    const block = this.uiBlocks.get(key);
    if (!block) return;
    this.uiBlocks.delete(key);
    const blocked = await block.transition;
    if (!blocked) {
      if (responding) throw new Error('the automatic Needs you transition failed');
      return;
    }
    if (!restoreWorking) return;
    const current = this.dependencies.card(blocked.id);
    if (!shouldRestoreUiRequestCard(current, blocked)) return;
    const session = cardAgentSession(paneId);
    const generation = this.dependencies.session(paneId)?.lifecycleGeneration();
    if (!session || !generation || generation !== block.generation) return;
    await this.enqueue(current.id, session.thread, 'ui_input_resolved', generation, `ui:${requestId}:resolved`, undefined, undefined, blocked.workflow_revision);
  }

  private handleEnvelope = (envelope: PiRpcEnvelope) => {
    if (this.disposed) return;
    const session = cardAgentSession(envelope.pane_id);
    const eventType = typeof envelope.event?.type === 'string' ? envelope.event.type : '';
    const lifecycleError = eventType === 'pi_protocol_error' || eventType === 'pi_process_exit';
    if (!session || (eventType !== 'agent_start' && eventType !== 'agent_settled' && !lifecycleError)) return;
    const diagnostic = { stage: 'frontend_projection', pane: envelope.pane_id, generation: envelope.generation,
      eventId: envelope.event_id, eventOrder: envelope.event_order, eventType, source: envelope.event.source ?? 'native' };
    if (eventType === 'pi_process_exit' && envelope.event.expected === true) {
      console.debug('[pi-lifecycle]', { ...diagnostic, result: 'filtered', reason: 'expected_exit' });
      return;
    }
    const acceptedGeneration = this.dependencies.session(envelope.pane_id)?.lifecycleGeneration();
    if (acceptedGeneration && acceptedGeneration !== envelope.generation) {
      console.debug('[pi-lifecycle]', { ...diagnostic, result: 'filtered', reason: 'stale_generation', acceptedGeneration });
      return;
    }
    if (lifecycleError && !acceptedGeneration) {
      console.debug('[pi-lifecycle]', { ...diagnostic, result: 'filtered', reason: 'generation_unavailable' });
      return;
    }
    const card = this.dependencies.card(session.cardId);
    if (!card) {
      console.debug('[pi-lifecycle]', { ...diagnostic, result: 'filtered', reason: 'card_not_loaded' });
      return;
    }
    console.debug('[pi-lifecycle]', { ...diagnostic, result: 'received' });
    const intent = piLifecycleIntent(eventType);
    const failureDetail = eventType === 'pi_protocol_error'
      ? (typeof (envelope.event as { message?: unknown }).message === 'string' ? String((envelope.event as { message: string }).message) : 'Pi protocol failed')
      : eventType === 'pi_process_exit' ? 'Pi process exited unexpectedly' : undefined;
    const transition = intent ? this.enqueue(session.cardId, session.thread, intent, envelope.generation, envelope.event_id, envelope.event_order, undefined, undefined, failureDetail) : Promise.resolve(null);
    if (eventType === 'agent_settled' || lifecycleError) transition.finally(() => {
      const current = this.dependencies.card(session.cardId);
      if (current && !this.disposed) this.dependencies.loadDetails(current).catch(() => {});
    });
  };
}

export function shouldRestoreUiRequestCard(current: KanbanCardSummary | undefined, blocked: KanbanCardSummary): current is KanbanCardSummary {
  const waitingStatus = blocked.status === 'needs_refinement_input' ? 'needs_refinement_input' : 'needs_human';
  return Boolean(current && current.status === waitingStatus && current.workflow_revision === blocked.workflow_revision);
}
export function piLifecycleIntent(eventType: string): PiLifecycleIntent | null {
  if (eventType === 'agent_start') return 'agent_started';
  if (eventType === 'agent_settled') return 'agent_settled';
  if (eventType === 'pi_protocol_error') return 'protocol_failed';
  if (eventType === 'pi_process_exit') return 'process_exited';
  return null;
}
export function cardAgentSession(paneId: string): { cardId: string; thread: CardThread } | null {
  const prefix = 'kanban-card:';
  if (!paneId.startsWith(prefix)) return null;
  for (const thread of ['planning', 'work'] as const) {
    const suffix = `:${thread}`;
    if (paneId.endsWith(suffix)) return { cardId: paneId.slice(prefix.length, -suffix.length), thread };
  }
  return null;
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
