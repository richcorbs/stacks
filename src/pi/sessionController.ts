import { invoke } from '@tauri-apps/api/core';
import type { PiCommand, PiMessage, PiModel, PiPromptImage, PiResponseEvent, PiRpcEnvelope, PiSessionContext, PiToolActivity, PiUiRequest } from './types';
import { subscribePiEvents } from './eventBroker';
import { appendPiMessage, createPiTranscriptReconciliation, reconcilePiMessages } from './transcript';
import { GUI_BUILTIN_COMMANDS } from './commands';
import { notifyPiAgentSettled, notifyPiPromptFailed } from './promptEvent';
import { notifyPiUiRequestDismissed, notifyPiUiRequestReceived, preparePiUiRequestResponse } from './uiRequestWorkflow';
import { parseWorkOwnerId, type AgentThread } from '../appAttention';
import { applicationEvents, type AppEventMap, type EventBroker } from '../applicationEvents';

const EMPTY_CONTEXT: PiSessionContext = {
  modelName: '', modelId: '', provider: '', thinkingLevel: '', sessionId: '', sessionName: '',
  supportsImages: false, contextTokens: null, contextWindow: null, contextPercent: null,
};
const MAX_LIVE_TOOLS = 100;
const MAX_STREAMING_TEXT = 1_000_000;

type PendingRequest = {
  resolve: (event: PiResponseEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type PiSessionConfig = { paneId: string; cwd: string; workspaceId: string; projectId: string; projectPath: string };
export type PiSessionSnapshot = {
  messages: PiMessage[];
  context: PiSessionContext;
  streamingText: string;
  isStreamingText: boolean;
  isStreaming: boolean;
  tools: PiToolActivity[];
  error: string | null;
  starting: boolean;
  stopped: boolean;
  uiRequest: PiUiRequest | null;
  editorTextRequest: { text: string } | null;
  commands: PiCommand[];
  availableModels: PiModel[];
  availableThinkingLevels: string[];
  queuedSteering: string[];
  queuedFollowUps: string[];
};

export type ControllerDependencies = {
  invoke: typeof invoke;
  subscribe: typeof subscribePiEvents;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  events: Pick<EventBroker<AppEventMap>, 'publish'>;
};

const defaultDependencies: ControllerDependencies = {
  invoke,
  subscribe: subscribePiEvents,
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  events: applicationEvents,
};

export class PiSessionController {
  private snapshot: PiSessionSnapshot = {
    messages: [], context: EMPTY_CONTEXT, streamingText: '', isStreamingText: false, isStreaming: false,
    tools: [], error: null, starting: true, stopped: false, uiRequest: null, editorTextRequest: null,
    commands: GUI_BUILTIN_COMMANDS, availableModels: [], availableThinkingLevels: [], queuedSteering: [], queuedFollowUps: [],
  };
  private listeners = new Set<() => void>();
  private transcriptReconciliation = createPiTranscriptReconciliation();
  private pendingRequests = new Map<string, PendingRequest>();
  private requestSequence = 0;
  private generation: string | null = null;
  private completionNotificationEligible = false;
  private activityRevision = 0;
  private uiResponseEpoch = 0;
  private initializationPromise: Promise<void> | null = null;
  private launchPromptPromise: Promise<boolean> | null = null;
  private deleted = false;
  private stopListening?: () => void;
  private uiRequestTimer?: ReturnType<typeof setTimeout>;

  constructor(private config: PiSessionConfig, private dependencies: ControllerDependencies = defaultDependencies) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  configure(config: PiSessionConfig) {
    this.config = config;
  }

  initialize() {
    this.initializeAndHydrate().catch(() => {});
  }

  /** Starts the retained process and resolves only after state and transcript hydration. */
  initializeAndHydrate = () => {
    if (this.initializationPromise) return this.initializationPromise;
    if (this.deleted) return Promise.reject(new Error('Pi session deleted'));
    this.initializationPromise = this.dependencies.subscribe(this.config.paneId, this.handleEnvelope).then(async (stop) => {
      if (this.deleted) {
        stop();
        throw new Error('Pi session deleted');
      }
      this.stopListening = stop;
      this.generation = null;
      await this.start();
    }).catch((error) => {
      if (!this.snapshot.stopped) this.failStart(error);
      throw asError(error);
    });
    return this.initializationPromise;
  };

  /**
   * Hydrates the retained transcript before launching card work. A blank work
   * conversation receives the full task exactly once; an interrupted existing
   * conversation receives a continuation instead. Concurrent callers share the
   * same accepted prompt, while later explicit retries may start another turn.
   */
  submitWorkLaunch = (initialPrompt: string, stillEligible: () => Promise<boolean> = async () => true) => {
    if (this.launchPromptPromise) return this.launchPromptPromise;
    const launch = this.initializeAndHydrate().then(async () => {
      if (this.snapshot.stopped || this.snapshot.error) await this.restart();
      if (!await stillEligible()) return false;
      if (this.snapshot.isStreaming) return true;
      const acceptedPromptExists = this.snapshot.messages.some((message) => message.role === 'user');
      const userMessagesBeforePrompt = this.userMessageCount();
      try {
        await this.prompt(acceptedPromptExists ? 'continue' : initialPrompt);
      } catch (error) {
        // A transport timeout is ambiguous: Pi may have accepted the prompt
        // even though its response never reached Stacks. Reinspect the durable
        // process before allowing orchestration to retry with a new controller.
        if (!await this.reinspectPromptAcceptance(userMessagesBeforePrompt)) throw error;
      }
      return true;
    });
    this.launchPromptPromise = launch;
    launch.finally(() => { if (this.launchPromptPromise === launch) this.launchPromptPromise = null; }).catch(() => {});
    return launch;
  };

  /** Planning relaunch compatibility; work launch uses submitWorkLaunch. */
  submitLaunchContinue = (stillEligible: () => Promise<boolean> = async () => true) => this.submitWorkLaunch('continue', stillEligible);

  setViewOpen = (open: boolean) => {
    viewPresence.set(this.config.paneId, open);
  };

  prompt = async (message: string, images: PiPromptImage[] = []) => {
    const text = message.trim() || (images.length ? 'Please review the attached image.' : '');
    if (!text) return;
    if (images.length && !this.snapshot.context.supportsImages) throw new Error('The selected model does not support image input');
    const optimisticContent = images.length
      ? [{ type: 'text' as const, text }, ...images.map((image) => ({ type: 'image' as const, mimeType: image.mimeType, name: image.name, data: image.data }))]
      : text;
    const timestamp = Date.now();
    const optimistic = !text.startsWith('/');
    if (optimistic) this.patch({ messages: appendPiMessage(this.snapshot.messages, { role: 'user', content: optimisticContent, timestamp, local: true }, this.transcriptReconciliation) });
    try {
      await this.sendRequest({ type: 'prompt', message: text, ...(images.length ? { images } : {}) });
    } catch (error) {
      if (optimistic) this.patch({ messages: this.snapshot.messages.filter((item) => !(item.local && item.timestamp === timestamp)) });
      throw error;
    }
  };

  steer = (message: string, images: PiPromptImage[] = []) => this.sendMessageCommand('steer', message, images);
  followUp = (message: string, images: PiPromptImage[] = []) => this.sendMessageCommand('follow_up', message, images);

  abort = async () => {
    this.completionNotificationEligible = false;
    notifyPiPromptFailed(this.config.paneId);
    // Pi's abort intentionally continues queued steering and follow-up messages.
    // A user-facing stop must clear that queue first or each queued message starts
    // another run and leaves the card projected as Agent working.
    await this.sendRequest({ type: 'clear_queue' });
    this.patch({ queuedSteering: [], queuedFollowUps: [] });
    await this.sendRequest({ type: 'abort' });
  };

  /** Stops an active card refinement turn without deleting its durable session. */
  stopRefinement = async () => {
    this.uiResponseEpoch += 1;
    this.clearUiRequest(true, false);
    if (this.snapshot.isStreaming) await this.abort();
  };

  runBuiltinCommand = async (input: string) => {
    const trimmed = input.trim();
    const command = trimmed.slice(1).split(/\s/, 1)[0].toLowerCase();
    if (command === 'new') {
      const response = await this.sendRequest({ type: 'new_session' }, 60_000);
      if (!response.data?.cancelled) await Promise.all([this.refreshMessages(), this.refreshState()]);
      this.refreshStats().catch(() => {});
      return;
    }
    if (command === 'compact') {
      const instructions = trimmed.slice('/compact'.length).trim();
      await this.sendRequest({ type: 'compact', ...(instructions ? { customInstructions: instructions } : {}) }, 180_000);
      await Promise.all([this.refreshMessages(), this.refreshState()]);
      this.refreshStats().catch(() => {});
      return;
    }
    throw new Error(`Unsupported Pi GUI command: /${command}`);
  };

  selectModel = async (model: PiModel) => {
    await this.sendRequest({ type: 'set_model', provider: model.provider, modelId: model.id });
    await this.refreshState();
    this.refreshAvailableThinkingLevels().catch(() => this.patch({ availableThinkingLevels: [] }));
    this.refreshStats().catch(() => {});
  };

  selectThinkingLevel = async (level: string) => {
    await this.sendRequest({ type: 'set_thinking_level', level });
    await this.refreshState();
  };

  respondToUiRequest = async (requestId: string, response: Record<string, unknown>) => {
    const claim = this.claimUiRequest(requestId);
    if (!claim) return false;
    await this.completeUiRequest(claim.request, claim.epoch, response);
    return true;
  };

  /** Cancels an inline structured request before normal composer submission. */
  dismissStructuredUiRequest = async () => {
    const current = this.snapshot.uiRequest;
    if (!current || (current.method !== 'confirm' && current.method !== 'select')) return false;
    const claim = this.claimUiRequest(current.id);
    if (!claim) return false;
    await this.completeUiRequest(claim.request, claim.epoch, { cancelled: true });
    return true;
  };

  restart = async () => {
    this.completionNotificationEligible = false;
    this.uiResponseEpoch += 1;
    this.clearUiRequest(true, false);
    this.patch({ starting: true, stopped: false, isStreamingText: false, streamingText: '', error: null, queuedSteering: [], queuedFollowUps: [] });
    this.generation = 'restarting';
    try {
      await this.dependencies.invoke('stop_pi_session', { paneId: this.config.paneId });
      const generation = await this.dependencies.invoke<string>('start_pi_session', this.startArgs());
      this.generation = generation;
      await this.hydrate();
      notifyRunning(this.dependencies, this.config.paneId, true);
      this.patch({ stopped: false });
    } catch (error) {
      notifyRunning(this.dependencies, this.config.paneId, false);
      this.patch({ stopped: true, error: asError(error).message });
      throw error;
    } finally {
      this.patch({ starting: false });
    }
  };

  /** Permanently removes frontend ownership. Backend deletion remains explicit at the caller. */
  delete() {
    if (this.deleted) return;
    this.uiResponseEpoch += 1;
    this.clearUiRequest(true, false);
    this.deleted = true;
    this.stopListening?.();
    this.stopListening = undefined;
    viewPresence.delete(this.config.paneId);
    for (const pending of this.pendingRequests.values()) {
      this.dependencies.clearTimeout(pending.timer);
      pending.reject(new Error('Pi session deleted'));
    }
    this.pendingRequests.clear();
    this.listeners.clear();
  }

  lifecycleGeneration() {
    return this.generation && this.generation !== 'restarting' ? this.generation : null;
  }

  /** Test seam for projection ordering and stale generation behavior. */
  project(envelope: PiRpcEnvelope) {
    this.handleEnvelope(envelope);
  }

  private startArgs() {
    const { paneId, cwd, projectPath, projectId } = this.config;
    return { paneId, cwd, projectPath, projectId };
  }

  private async start() {
    try {
      const generation = await this.dependencies.invoke<string>('start_pi_session', this.startArgs());
      this.generation = generation;
      await this.hydrate();
      notifyRunning(this.dependencies, this.config.paneId, true);
      this.patch({ stopped: false, starting: false });
    } catch (error) {
      this.failStart(error);
      throw asError(error);
    }
  }

  private failStart(error: unknown) {
    notifyRunning(this.dependencies, this.config.paneId, false);
    this.patch({ starting: false, stopped: true, error: asError(error).message });
  }

  private hydrate = async () => {
    await Promise.all([this.refreshState(), this.refreshMessages()]);
    this.refreshCommands().catch(() => this.patch({ commands: GUI_BUILTIN_COMMANDS }));
    this.refreshAvailableModels().catch(() => this.patch({ availableModels: [] }));
    this.refreshAvailableThinkingLevels().catch(() => this.patch({ availableThinkingLevels: [] }));
    this.refreshStats().catch(() => {});
  };

  private writeCommand = (command: Record<string, unknown>) => this.dependencies.invoke<void>('send_pi_rpc', { paneId: this.config.paneId, command }).catch((error) => {
    const next = asError(error);
    this.patch({ error: next.message });
    throw next;
  });

  private sendRequest = (command: Record<string, unknown>, timeoutMs = 15_000) => {
    this.requestSequence += 1;
    const id = `stacks-${this.config.paneId}-${this.requestSequence}`;
    return new Promise<PiResponseEvent>((resolve, reject) => {
      const timer = this.dependencies.setTimeout(() => {
        this.pendingRequests.delete(id);
        const error = new Error(`Pi ${String(command.type || 'request')} timed out`);
        this.patch({ error: error.message });
        reject(error);
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.writeCommand({ ...command, id }).catch((error) => {
        this.dependencies.clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(asError(error));
      });
    });
  };

  private refreshMessages = async () => {
    const response = await this.sendRequest({ type: 'get_messages' }, 60_000);
    if (!Array.isArray(response.data?.messages)) return;
    // Live message_end events may race hydration. Hydrated history is the base,
    // then newer projected messages are appended with transcript deduplication.
    this.patch({ messages: reconcilePiMessages(response.data.messages, this.snapshot.messages, this.transcriptReconciliation) });
  };

  private userMessageCount() {
    return this.snapshot.messages.filter((message) => message.role === 'user' && !message.local).length;
  }

  private async reinspectPromptAcceptance(userMessagesBeforePrompt: number) {
    try {
      await Promise.all([this.refreshState(), this.refreshMessages()]);
    } catch {
      return false;
    }
    const accepted = this.snapshot.isStreaming || this.userMessageCount() > userMessagesBeforePrompt;
    if (accepted) this.patch({ error: null });
    return accepted;
  }

  private refreshState = async () => {
    const requestedAtRevision = this.activityRevision;
    const response = await this.sendRequest({ type: 'get_state' });
    const model = response.data?.model;
    this.patch({
      context: { ...this.snapshot.context, modelName: model?.name || model?.id || '', modelId: model?.id || '', provider: model?.provider || '',
        thinkingLevel: response.data?.thinkingLevel || '', sessionId: response.data?.sessionId || '', sessionName: response.data?.sessionName || '',
        supportsImages: Array.isArray(model?.input) && model.input.includes('image') },
      ...(requestedAtRevision === this.activityRevision ? { isStreaming: Boolean(response.data?.isStreaming) } : {}),
    });
  };

  private refreshStats = async () => {
    const response = await this.sendRequest({ type: 'get_session_stats' });
    const usage = response.data?.contextUsage;
    this.patch({ context: { ...this.snapshot.context, contextTokens: typeof usage?.tokens === 'number' ? usage.tokens : null,
      contextWindow: typeof usage?.contextWindow === 'number' ? usage.contextWindow : null,
      contextPercent: typeof usage?.percent === 'number' ? usage.percent : null } });
  };

  private refreshCommands = async () => {
    const response = await this.sendRequest({ type: 'get_commands' });
    this.patch({ commands: withGuiBuiltinCommands(normalizeCommands(response.data?.commands)) });
  };
  private refreshAvailableModels = async () => {
    const response = await this.sendRequest({ type: 'get_available_models' });
    this.patch({ availableModels: normalizeModels(response.data?.models) });
  };
  private refreshAvailableThinkingLevels = async () => {
    const response = await this.sendRequest({ type: 'get_available_thinking_levels' });
    this.patch({ availableThinkingLevels: normalizeThinkingLevels(response.data?.levels) });
  };

  private sendMessageCommand = async (type: 'steer' | 'follow_up', message: string, images: PiPromptImage[]) => {
    const text = message.trim() || (images.length ? 'Please review the attached image.' : '');
    if (!text) return;
    if (images.length && !this.snapshot.context.supportsImages) throw new Error('The selected model does not support image input');
    await this.sendRequest({ type, message: text, ...(images.length ? { images } : {}) });
  };

  private handleEnvelope = (payload: PiRpcEnvelope) => {
    if (this.deleted || payload.pane_id !== this.config.paneId) return;
    const lifecycleDiagnostic = ['agent_start', 'agent_end', 'agent_settled', 'pi_protocol_error', 'pi_process_exit'].includes(payload.event.type);
    if (this.generation && this.generation !== payload.generation) {
      if (lifecycleDiagnostic) console.debug('[pi-lifecycle]', { stage: 'frontend_session', pane: payload.pane_id, generation: payload.generation,
        acceptedGeneration: this.generation, eventId: payload.event_id, eventOrder: payload.event_order, eventType: payload.event.type, result: 'filtered', reason: 'stale_generation' });
      return;
    }
    if (!this.generation) this.generation = payload.generation;
    const event = payload.event;
    if (lifecycleDiagnostic) console.debug('[pi-lifecycle]', { stage: 'frontend_session', pane: payload.pane_id, generation: payload.generation,
      eventId: payload.event_id, eventOrder: payload.event_order, eventType: event.type, source: event.source ?? 'native', result: 'received' });
    if (event.type === 'response' && event.id) {
      const response = event as PiResponseEvent;
      const pending = this.pendingRequests.get(event.id);
      if (pending) {
        this.dependencies.clearTimeout(pending.timer);
        this.pendingRequests.delete(event.id);
        if (response.success) pending.resolve(response);
        else pending.reject(new Error(response.error || `${response.command || 'Pi command'} failed`));
      }
      if (!response.success) this.patch({ error: response.error || `${response.command || 'Pi command'} failed` });
      return;
    }
    switch (event.type) {
      case 'agent_start':
        this.activityRevision += 1;
        this.completionNotificationEligible = true;
        this.patch({ isStreaming: true, isStreamingText: false, streamingText: '', tools: [], error: null });
        break;
      case 'message_update': {
        const type = event.assistantMessageEvent?.type;
        const isText = type === 'text_start' || type === 'text_delta';
        if (type) this.patch({ isStreamingText: isText });
        if (type === 'text_delta') {
          this.patch({ streamingText: `${this.snapshot.streamingText}${event.assistantMessageEvent?.delta || ''}`.slice(-MAX_STREAMING_TEXT) });
          notifyOutput(this.dependencies, this.config.workspaceId, this.config.paneId);
        }
        break;
      }
      case 'message_end':
        if (event.message && typeof event.message === 'object') {
          const message = event.message as PiMessage;
          const next: Partial<PiSessionSnapshot> = { messages: appendPiMessage(this.snapshot.messages, message, this.transcriptReconciliation) };
          if (message.role === 'assistant') Object.assign(next, { isStreamingText: false, streamingText: '' });
          if (message.role === 'user') {
            const text = messageContentText(message.content).trim();
            next.queuedSteering = removeDeliveredQueuedMessage(this.snapshot.queuedSteering, text);
            next.queuedFollowUps = removeDeliveredQueuedMessage(this.snapshot.queuedFollowUps, text);
          }
          if (message.role === 'toolResult' && message.toolCallId) next.tools = this.snapshot.tools.filter((tool) => tool.id !== message.toolCallId);
          this.patch(next);
          if (message.role === 'assistant') notifyOutput(this.dependencies, this.config.workspaceId, this.config.paneId);
        }
        break;
      case 'tool_execution_start':
        notifyOutput(this.dependencies, this.config.workspaceId, this.config.paneId);
        this.patch({ tools: [...this.snapshot.tools.filter((tool) => tool.id !== event.toolCallId), {
          id: event.toolCallId || `tool-${Date.now()}`, name: event.toolName || 'tool', args: event.args, partialText: '', status: 'running' as const,
        }].slice(-MAX_LIVE_TOOLS) });
        break;
      case 'tool_execution_update':
        this.patch({ tools: this.snapshot.tools.map((tool) => tool.id === event.toolCallId ? { ...tool, partialText: toolResultText(event.partialResult) } : tool) });
        break;
      case 'tool_execution_end':
        this.patch({ tools: this.snapshot.tools.map((tool) => tool.id === event.toolCallId ? { ...tool, partialText: toolResultText(event.result), status: event.isError ? 'error' : 'complete' } : tool) });
        break;
      case 'queue_update':
        this.patch({ queuedSteering: stringArray(event.steering), queuedFollowUps: stringArray(event.followUp) });
        break;
      case 'agent_settled':
        this.activityRevision += 1;
        this.uiResponseEpoch += 1;
        // A settled run supersedes any unanswered overlay. Keep the card in
        // Needs you for normal review rather than restoring Agent working.
        this.clearUiRequest(true, false);
        notifyPiAgentSettled(this.config.paneId);
        if (this.completionNotificationEligible) this.dispatchAttention('pi-complete', `${payload.generation}:run:${this.activityRevision}`);
        this.completionNotificationEligible = false;
        this.patch({ isStreaming: false, isStreamingText: false, streamingText: '', tools: [] });
        this.refreshState().catch(() => {});
        this.refreshStats().catch(() => {});
        break;
      case 'auto_compaction_end': case 'session_switch': case 'session_fork':
        this.refreshMessages().catch(() => {});
        this.refreshState().catch(() => {});
        break;
      case 'pi_stderr': console.warn('[pi]', event.message); break;
      case 'pi_protocol_error':
        notifyPiPromptFailed(this.config.paneId);
        this.patch({ error: typeof event.message === 'string' ? event.message : 'Pi reported an error' });
        break;
      case 'pi_process_exit':
        this.activityRevision += 1;
        this.uiResponseEpoch += 1;
        this.clearUiRequest(true, false);
        notifyPiPromptFailed(this.config.paneId);
        this.completionNotificationEligible = false;
        notifyRunning(this.dependencies, this.config.paneId, false);
        this.patch({ isStreaming: false, isStreamingText: false, streamingText: '', queuedSteering: [], queuedFollowUps: [], stopped: true, error: 'Pi session stopped' });
        for (const pending of this.pendingRequests.values()) { this.dependencies.clearTimeout(pending.timer); pending.reject(new Error('Pi session stopped')); }
        this.pendingRequests.clear();
        break;
      case 'extension_ui_request': {
        if (event.method === 'set_editor_text' && typeof event.text === 'string') { this.patch({ editorTextRequest: { text: event.text } }); break; }
        const request = extensionUiRequest(event);
        if (!request) break;
        this.uiResponseEpoch += 1;
        this.clearUiRequest(true);
        this.patch({ uiRequest: request });
        const open = viewPresence.get(this.config.paneId) === true;
        notifyPiUiRequestReceived(this.config.paneId, request.id, open);
        this.dispatchAttention('pi-request', `${payload.generation}:request:${request.id}`);
        if (request.timeout) this.uiRequestTimer = this.dependencies.setTimeout(() => this.clearUiRequest(true, true, request.id), request.timeout);
        break;
      }
    }
  };

  private dispatchAttention(kind: 'pi-complete' | 'pi-request', lifecycleKey: string) {
    const owner = parseWorkOwnerId(this.config.workspaceId);
    if (!owner) return;
    const agentThread: AgentThread | undefined = owner.kind === 'card'
      ? (this.config.paneId.endsWith(':planning') ? 'planning' : 'work')
      : undefined;
    this.dependencies.events.publish('attention', {
      kind,
      owner,
      target: { view: 'agent', agentThread, terminalId: this.config.paneId },
      lifecycleKey: `pi:${this.config.paneId}:${lifecycleKey}:${kind}`,
    });
  }

  private claimUiRequest(requestId: string) {
    const request = this.snapshot.uiRequest;
    if (!request || request.id !== requestId) return null;
    this.clearUiRequest(false, true, requestId);
    return { request, epoch: this.uiResponseEpoch };
  }

  private async completeUiRequest(request: PiUiRequest, epoch: number, response: Record<string, unknown>) {
    try {
      await preparePiUiRequestResponse(this.config.paneId, request.id);
    } catch (error) {
      this.patch({ error: `Card status could not be restored: ${asError(error).message}` });
    }
    if (this.deleted || this.snapshot.stopped || epoch !== this.uiResponseEpoch) return;
    await this.writeCommand({ type: 'extension_ui_response', id: request.id, ...response });
  }

  private clearUiRequest(reconcile: boolean, restoreWorking = true, requestId?: string) {
    const request = this.snapshot.uiRequest;
    if (!request || (requestId !== undefined && request.id !== requestId)) return;
    if (this.uiRequestTimer) this.dependencies.clearTimeout(this.uiRequestTimer);
    this.uiRequestTimer = undefined;
    // Hide synchronously before any asynchronous workflow reconciliation.
    this.patch({ uiRequest: null });
    if (reconcile) notifyPiUiRequestDismissed(this.config.paneId, request.id, restoreWorking);
  }

  private patch(next: Partial<PiSessionSnapshot>) {
    if (this.deleted) return;
    this.snapshot = { ...this.snapshot, ...next };
    this.listeners.forEach((listener) => listener());
  }
}

const controllers = new Map<string, PiSessionController>();
const viewPresence = new Map<string, boolean>();

export function getPiSessionController(config: PiSessionConfig) {
  let controller = controllers.get(config.paneId);
  if (!controller) {
    controller = new PiSessionController(config);
    controllers.set(config.paneId, controller);
  } else controller.configure(config);
  return controller;
}

export function getRetainedPiSessionController(paneId: string) {
  return controllers.get(paneId) ?? null;
}

export function deletePiSessionController(paneId: string) {
  controllers.get(paneId)?.delete();
  controllers.delete(paneId);
}

export async function deletePersistentPiSession(paneId: string) {
  await invoke('delete_pi_session', { paneId });
  deletePiSessionController(paneId);
}

export function retainedPiSessionCount() { return controllers.size; }

function notifyRunning(dependencies: ControllerDependencies, paneId: string, running: boolean) {
  dependencies.events.publish('terminal-running-changed', { terminalId: paneId, running });
}
function notifyOutput(dependencies: ControllerDependencies, workspaceId: string, paneId: string) {
  dependencies.events.publish('terminal-output', { workspaceId, terminalId: paneId });
}
function withGuiBuiltinCommands(commands: PiCommand[]) {
  const names = new Set(GUI_BUILTIN_COMMANDS.map((command) => command.name));
  return [...GUI_BUILTIN_COMMANDS, ...commands.filter((command) => !names.has(command.name))];
}
function normalizeCommands(value: unknown): PiCommand[] {
  if (!Array.isArray(value)) return [];
  return value.filter((command): command is PiCommand => Boolean(command && typeof command === 'object' && typeof (command as PiCommand).name === 'string' && ['extension', 'prompt', 'skill'].includes(String((command as PiCommand).source))))
    .sort((left, right) => left.name.localeCompare(right.name));
}
function normalizeModels(value: unknown): PiModel[] {
  if (!Array.isArray(value)) return [];
  return value.filter((model): model is PiModel => Boolean(model && typeof model === 'object' && typeof (model as PiModel).id === 'string' && typeof (model as PiModel).provider === 'string'))
    .sort((left, right) => (left.name || left.id).localeCompare(right.name || right.id));
}
function normalizeThinkingLevels(value: unknown): string[] { return stringArray(value); }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function removeDeliveredQueuedMessage(messages: string[], deliveredText: string) {
  const index = messages.findIndex((queued) => queued.trim() === deliveredText);
  return index < 0 ? messages : messages.filter((_, candidate) => candidate !== index);
}
function messageContentText(content: PiMessage['content']) {
  if (typeof content === 'string') return content;
  return content.flatMap((block) => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n');
}
function toolResultText(result: unknown) {
  const content = typeof result === 'object' && result ? (result as { content?: unknown }).content : null;
  if (!Array.isArray(content)) return '';
  return content.filter((item): item is { type: string; text?: string } => Boolean(item && typeof item === 'object' && 'type' in item))
    .filter((item) => item.type === 'text').map((item) => item.text || '').join('\n');
}
function extensionUiRequest(event: Record<string, unknown>): PiUiRequest | null {
  if (typeof event.id !== 'string' || !['confirm', 'input', 'editor', 'select'].includes(String(event.method))) return null;
  return { id: event.id, method: event.method as PiUiRequest['method'], title: typeof event.title === 'string' ? event.title : 'Pi request',
    message: typeof event.message === 'string' ? event.message : '', prefill: typeof event.prefill === 'string' ? event.prefill : '',
    options: stringArray(event.options), timeout: typeof event.timeout === 'number' ? event.timeout : undefined };
}
function asError(error: unknown) { return error instanceof Error ? error : new Error(String(error)); }
