import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PiCommand, PiMessage, PiModel, PiPromptImage, PiResponseEvent, PiSessionContext, PiToolActivity, PiUiRequest } from './types';
import { subscribePiEvents } from './eventBroker';
import { appendPiMessage, compactPiMessages } from './transcript';
import { GUI_BUILTIN_COMMANDS } from './commands';

const EMPTY_CONTEXT: PiSessionContext = {
  modelName: '',
  modelId: '',
  provider: '',
  thinkingLevel: '',
  sessionId: '',
  sessionName: '',
  supportsImages: false,
  contextTokens: null,
  contextWindow: null,
  contextPercent: null,
};

type PendingRequest = {
  resolve: (event: PiResponseEvent) => void;
  reject: (error: Error) => void;
  timer: number;
};

export function usePiSession(paneId: string, cwd: string, workspaceId: string, projectPath: string) {
  const [messages, setMessages] = useState<PiMessage[]>([]);
  const [context, setContext] = useState<PiSessionContext>(EMPTY_CONTEXT);
  const [streamingText, setStreamingText] = useState('');
  const [isStreamingText, setIsStreamingText] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [tools, setTools] = useState<PiToolActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [stopped, setStopped] = useState(false);
  const [uiRequest, setUiRequest] = useState<PiUiRequest | null>(null);
  const [editorTextRequest, setEditorTextRequest] = useState<{ text: string } | null>(null);
  const [commands, setCommands] = useState<PiCommand[]>(GUI_BUILTIN_COMMANDS);
  const [availableModels, setAvailableModels] = useState<PiModel[]>([]);
  const [availableThinkingLevels, setAvailableThinkingLevels] = useState<string[]>([]);
  const [queuedSteering, setQueuedSteering] = useState<string[]>([]);
  const [queuedFollowUps, setQueuedFollowUps] = useState<string[]>([]);
  const requestSequence = useRef(0);
  const generationRef = useRef<string | null>(null);
  const pendingRequests = useRef(new Map<string, PendingRequest>());
  const streamingTextBufferRef = useRef('');
  const streamingFrameRef = useRef<number | null>(null);
  const completionNotificationEligibleRef = useRef(false);

  const resetStreamingText = useCallback(() => {
    streamingTextBufferRef.current = '';
    if (streamingFrameRef.current !== null) cancelAnimationFrame(streamingFrameRef.current);
    streamingFrameRef.current = null;
    setStreamingText('');
  }, []);

  const appendStreamingText = useCallback((delta: string) => {
    streamingTextBufferRef.current += delta;
    if (streamingFrameRef.current !== null) return;
    streamingFrameRef.current = requestAnimationFrame(() => {
      streamingFrameRef.current = null;
      setStreamingText(streamingTextBufferRef.current);
    });
  }, []);

  const writeCommand = useCallback((command: Record<string, unknown>) => (
    invoke<void>('send_pi_rpc', { paneId, command }).catch((sendError) => {
      const nextError = asError(sendError);
      setError(nextError.message);
      throw nextError;
    })
  ), [paneId]);

  const sendRequest = useCallback((command: Record<string, unknown>, timeoutMs = 15_000) => {
    requestSequence.current += 1;
    const id = `stacks-${paneId}-${requestSequence.current}`;
    return new Promise<PiResponseEvent>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingRequests.current.delete(id);
        const timeoutError = new Error(`Pi ${String(command.type || 'request')} timed out`);
        setError(timeoutError.message);
        reject(timeoutError);
      }, timeoutMs);
      pendingRequests.current.set(id, { resolve, reject, timer });
      writeCommand({ ...command, id }).catch((sendError) => {
        window.clearTimeout(timer);
        pendingRequests.current.delete(id);
        reject(asError(sendError));
      });
    });
  }, [paneId, writeCommand]);

  const refreshMessages = useCallback(() => sendRequest({ type: 'get_messages' }, 60_000), [sendRequest]);
  const refreshState = useCallback(() => sendRequest({ type: 'get_state' }), [sendRequest]);
  const refreshStats = useCallback(() => sendRequest({ type: 'get_session_stats' }), [sendRequest]);
  const refreshCommands = useCallback(() => sendRequest({ type: 'get_commands' }).then((response) => {
    setCommands(withGuiBuiltinCommands(normalizeCommands(response.data?.commands)));
  }), [sendRequest]);
  const refreshAvailableModels = useCallback(() => sendRequest({ type: 'get_available_models' }).then((response) => {
    setAvailableModels(normalizeModels(response.data?.models));
  }), [sendRequest]);
  const refreshAvailableThinkingLevels = useCallback(() => sendRequest({ type: 'get_available_thinking_levels' }).then((response) => {
    setAvailableThinkingLevels(normalizeThinkingLevels(response.data?.levels));
  }), [sendRequest]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    subscribePiEvents(paneId, (payload) => {
      if (disposed) return;
      if (generationRef.current && generationRef.current !== payload.generation) return;
      if (!generationRef.current) generationRef.current = payload.generation;
      const event = payload.event;

      if (event.type === 'response' && event.id) {
        const response = event as PiResponseEvent;
        const pending = pendingRequests.current.get(event.id);
        if (pending) {
          window.clearTimeout(pending.timer);
          pendingRequests.current.delete(event.id);
          if (response.success) pending.resolve(response);
          else pending.reject(new Error(response.error || `${response.command || 'Pi command'} failed`));
        }
      }

      switch (event.type) {
        case 'response': {
          const response = event as PiResponseEvent;
          if (!response.success) {
            setError(response.error || `${response.command || 'Pi command'} failed`);
            break;
          }
          if (response.command === 'get_messages' && Array.isArray(response.data?.messages)) {
            setMessages(compactPiMessages(response.data.messages));
          }
          if (response.command === 'get_state') updateContext(response, setContext, setIsStreaming);
          if (response.command === 'get_session_stats') updateContextUsage(response, setContext);
          if (response.command === 'get_commands') setCommands(withGuiBuiltinCommands(normalizeCommands(response.data?.commands)));
          break;
        }
        case 'agent_start':
          completionNotificationEligibleRef.current = true;
          setIsStreaming(true);
          setIsStreamingText(false);
          resetStreamingText();
          setTools([]);
          setError(null);
          break;
        case 'message_update': {
          const updateType = event.assistantMessageEvent?.type;
          if (updateType === 'text_start' || updateType === 'text_delta') setIsStreamingText(true);
          else if (updateType === 'text_end' || updateType === 'thinking_start' || updateType === 'thinking_delta' || updateType === 'thinking_end' || updateType === 'toolcall_start') setIsStreamingText(false);
          if (updateType === 'text_delta') {
            appendStreamingText(event.assistantMessageEvent?.delta || '');
            notifyOutput(workspaceId, paneId);
          }
          break;
        }
        case 'message_end':
          if (event.message && typeof event.message === 'object') {
            const message = event.message as PiMessage;
            setMessages((current) => appendPiMessage(current, message));
            if (message.role === 'assistant') {
              setIsStreamingText(false);
              resetStreamingText();
              notifyOutput(workspaceId, paneId);
            }
            if (message.role === 'user') {
              const deliveredText = messageContentText(message.content).trim();
              setQueuedSteering((current) => removeDeliveredQueuedMessage(current, deliveredText));
              setQueuedFollowUps((current) => removeDeliveredQueuedMessage(current, deliveredText));
            }
            if (message.role === 'toolResult' && message.toolCallId) {
              setTools((current) => current.filter((tool) => tool.id !== message.toolCallId));
            }
          }
          break;
        case 'tool_execution_start':
          notifyOutput(workspaceId, paneId);
          setTools((current) => [...current.filter((tool) => tool.id !== event.toolCallId), {
            id: event.toolCallId || `tool-${Date.now()}`,
            name: event.toolName || 'tool',
            args: event.args,
            partialText: '',
            status: 'running',
          }]);
          break;
        case 'tool_execution_update':
          setTools((current) => current.map((tool) => tool.id === event.toolCallId ? {
            ...tool,
            partialText: toolResultText(event.partialResult),
          } : tool));
          break;
        case 'tool_execution_end':
          setTools((current) => current.map((tool) => tool.id === event.toolCallId ? {
            ...tool,
            partialText: toolResultText(event.result),
            status: event.isError ? 'error' : 'complete',
          } : tool));
          break;
        case 'queue_update':
          setQueuedSteering(Array.isArray(event.steering) ? event.steering.filter((item): item is string => typeof item === 'string') : []);
          setQueuedFollowUps(Array.isArray(event.followUp) ? event.followUp.filter((item): item is string => typeof item === 'string') : []);
          break;
        case 'agent_settled':
          if (completionNotificationEligibleRef.current) {
            window.dispatchEvent(new CustomEvent('app-attention', {
              detail: { kind: 'pi-complete', workspaceId, terminalId: paneId },
            }));
          }
          completionNotificationEligibleRef.current = false;
          setIsStreaming(false);
          setIsStreamingText(false);
          resetStreamingText();
          setTools([]);
          refreshState().catch(() => {});
          refreshStats().catch(() => {});
          break;
        case 'auto_compaction_end':
        case 'session_switch':
        case 'session_fork':
          refreshMessages().catch(() => {});
          refreshState().catch(() => {});
          break;
        case 'pi_stderr':
          // Pi uses stderr for diagnostics and benign startup warnings. Preserve
          // visibility for developers without presenting every line as failure.
          console.warn('[pi]', event.message);
          break;
        case 'pi_protocol_error':
          setError(typeof event.message === 'string' ? event.message : 'Pi reported an error');
          break;
        case 'pi_process_exit':
          completionNotificationEligibleRef.current = false;
          notifyRunning(paneId, false);
          setIsStreaming(false);
          setIsStreamingText(false);
          resetStreamingText();
          setQueuedSteering([]);
          setQueuedFollowUps([]);
          setStopped(true);
          setError('Pi session stopped');
          for (const pending of pendingRequests.current.values()) {
            window.clearTimeout(pending.timer);
            pending.reject(new Error('Pi session stopped'));
          }
          pendingRequests.current.clear();
          break;
        case 'extension_ui_request': {
          if (event.method === 'set_editor_text' && typeof event.text === 'string') {
            setEditorTextRequest({ text: event.text });
            break;
          }
          const request = extensionUiRequest(event);
          if (request) setUiRequest(request);
          break;
        }
      }
    }).then((stopListening) => {
      if (disposed) stopListening();
      else {
        unlisten = stopListening;
        // Accept events from the first generation while startup is in flight so
        // an immediate process exit or diagnostic is not silently discarded.
        generationRef.current = null;
        invoke<string>('start_pi_session', { paneId, cwd, projectPath })
          .then(async (generation) => {
            generationRef.current = generation;
            await Promise.all([refreshState(), refreshMessages()]);
            refreshCommands().catch(() => setCommands(GUI_BUILTIN_COMMANDS));
            refreshAvailableModels().catch(() => setAvailableModels([]));
            refreshAvailableThinkingLevels().catch(() => setAvailableThinkingLevels([]));
            refreshStats().catch(() => {});
            notifyRunning(paneId, true);
            setStopped(false);
            setStarting(false);
          })
          .catch((startError) => {
            notifyRunning(paneId, false);
            setStarting(false);
            setStopped(true);
            setError(asError(startError).message);
          });
      }
    }).catch((listenError) => {
      notifyRunning(paneId, false);
      setStarting(false);
      setStopped(true);
      setError(asError(listenError).message);
    });

    return () => {
      disposed = true;
      unlisten?.();
      for (const pending of pendingRequests.current.values()) {
        window.clearTimeout(pending.timer);
        pending.reject(new Error('Pi pane disconnected'));
      }
      pendingRequests.current.clear();
      if (streamingFrameRef.current !== null) cancelAnimationFrame(streamingFrameRef.current);
    };
  }, [appendStreamingText, cwd, paneId, projectPath, refreshAvailableModels, refreshAvailableThinkingLevels, refreshCommands, refreshMessages, refreshState, refreshStats, resetStreamingText, workspaceId, writeCommand]);

  useEffect(() => {
    if (!uiRequest?.timeout) return;
    const timer = window.setTimeout(() => setUiRequest((current) => current?.id === uiRequest.id ? null : current), uiRequest.timeout);
    return () => window.clearTimeout(timer);
  }, [uiRequest]);

  const runBuiltinCommand = useCallback(async (input: string) => {
    const trimmed = input.trim();
    const command = trimmed.slice(1).split(/\s/, 1)[0].toLowerCase();
    if (command === 'new') {
      const response = await sendRequest({ type: 'new_session' }, 60_000);
      if (response.data?.cancelled) return;
      await Promise.all([refreshMessages(), refreshState()]);
      refreshStats().catch(() => {});
      return;
    }
    if (command === 'compact') {
      const instructions = trimmed.slice('/compact'.length).trim();
      await sendRequest({ type: 'compact', ...(instructions ? { customInstructions: instructions } : {}) }, 180_000);
      await Promise.all([refreshMessages(), refreshState()]);
      refreshStats().catch(() => {});
      return;
    }
    throw new Error(`Unsupported Pi GUI command: /${command}`);
  }, [refreshMessages, refreshState, refreshStats, sendRequest]);

  const prompt = useCallback(async (message: string, images: PiPromptImage[] = []) => {
    const text = message.trim() || (images.length ? 'Please review the attached image.' : '');
    if (!text) return;
    if (images.length && !context.supportsImages) throw new Error('The selected model does not support image input');
    const optimisticContent = images.length
      ? [{ type: 'text' as const, text }, ...images.map((image) => ({ type: 'image', mimeType: image.mimeType, name: image.name, data: image.data }))]
      : text;
    // Skills and templates expand into a different persisted user message, while
    // extension commands may not create one at all. Avoid a duplicate/stale
    // optimistic bubble for slash commands.
    const optimisticTimestamp = Date.now();
    const optimistic = !text.startsWith('/');
    if (optimistic) setMessages((current) => appendPiMessage(current, { role: 'user', content: optimisticContent, timestamp: optimisticTimestamp, local: true }));
    try {
      await sendRequest({ type: 'prompt', message: text, ...(images.length ? { images } : {}) });
    } catch (promptError) {
      if (optimistic) setMessages((current) => current.filter((item) => !(item.local && item.timestamp === optimisticTimestamp)));
      throw promptError;
    }
  }, [context.supportsImages, sendRequest]);

  const steer = useCallback(async (message: string, images: PiPromptImage[] = []) => {
    const text = message.trim() || (images.length ? 'Please review the attached image.' : '');
    if (!text) return;
    if (images.length && !context.supportsImages) throw new Error('The selected model does not support image input');
    await sendRequest({ type: 'steer', message: text, ...(images.length ? { images } : {}) });
  }, [context.supportsImages, sendRequest]);

  const followUp = useCallback(async (message: string, images: PiPromptImage[] = []) => {
    const text = message.trim() || (images.length ? 'Please review the attached image.' : '');
    if (!text) return;
    if (images.length && !context.supportsImages) throw new Error('The selected model does not support image input');
    await sendRequest({ type: 'follow_up', message: text, ...(images.length ? { images } : {}) });
  }, [context.supportsImages, sendRequest]);

  const abort = useCallback(() => {
    completionNotificationEligibleRef.current = false;
    return sendRequest({ type: 'abort' });
  }, [sendRequest]);
  const selectModel = useCallback(async (model: PiModel) => {
    await sendRequest({ type: 'set_model', provider: model.provider, modelId: model.id });
    await refreshState();
    refreshAvailableThinkingLevels().catch(() => setAvailableThinkingLevels([]));
    refreshStats().catch(() => {});
  }, [refreshAvailableThinkingLevels, refreshState, refreshStats, sendRequest]);
  const selectThinkingLevel = useCallback(async (level: string) => {
    await sendRequest({ type: 'set_thinking_level', level });
    await refreshState();
  }, [refreshState, sendRequest]);
  const respondToUiRequest = useCallback(async (response: Record<string, unknown>) => {
    const request = uiRequest;
    if (!request) return;
    setUiRequest(null);
    await writeCommand({ type: 'extension_ui_response', id: request.id, ...response });
  }, [uiRequest, writeCommand]);
  const restart = useCallback(async () => {
    completionNotificationEligibleRef.current = false;
    setStarting(true);
    setStopped(false);
    setIsStreamingText(false);
    resetStreamingText();
    setError(null);
    setQueuedSteering([]);
    setQueuedFollowUps([]);
    // Reject every event from the old generation before asking Rust to stop it.
    generationRef.current = 'restarting';
    try {
      await invoke('stop_pi_session', { paneId });
      const generation = await invoke<string>('start_pi_session', { paneId, cwd, projectPath });
      generationRef.current = generation;
      await Promise.all([refreshState(), refreshMessages()]);
      refreshCommands().catch(() => setCommands(GUI_BUILTIN_COMMANDS));
      refreshAvailableModels().catch(() => setAvailableModels([]));
      refreshAvailableThinkingLevels().catch(() => setAvailableThinkingLevels([]));
      refreshStats().catch(() => {});
      notifyRunning(paneId, true);
      setStopped(false);
    } catch (restartError) {
      notifyRunning(paneId, false);
      setStopped(true);
      setError(asError(restartError).message);
      throw restartError;
    } finally {
      setStarting(false);
    }
  }, [cwd, paneId, projectPath, refreshAvailableModels, refreshAvailableThinkingLevels, refreshCommands, refreshMessages, refreshState, refreshStats, resetStreamingText]);

  return { messages, context, commands, availableModels, availableThinkingLevels, queuedSteering, queuedFollowUps, editorTextRequest, streamingText, isStreamingText, isStreaming, tools, error, starting, stopped, uiRequest, prompt, runBuiltinCommand, steer, followUp, abort, selectModel, selectThinkingLevel, restart, respondToUiRequest };
}

function notifyRunning(paneId: string, running: boolean) {
  window.dispatchEvent(new CustomEvent('terminal-running-changed', { detail: { terminalId: paneId, running } }));
}

function notifyOutput(workspaceId: string, paneId: string) {
  window.dispatchEvent(new CustomEvent('terminal-output', { detail: { workspaceId, terminalId: paneId } }));
}

type SetPiContext = (value: PiSessionContext | ((current: PiSessionContext) => PiSessionContext)) => void;

function updateContext(event: PiResponseEvent, setContext: SetPiContext, setIsStreaming: (streaming: boolean) => void) {
  const model = event.data?.model;
  setContext((current) => ({
    ...current,
    modelName: model?.name || model?.id || '',
    modelId: model?.id || '',
    provider: model?.provider || '',
    thinkingLevel: event.data?.thinkingLevel || '',
    sessionId: event.data?.sessionId || '',
    sessionName: event.data?.sessionName || '',
    supportsImages: Array.isArray(model?.input) && model.input.includes('image'),
  }));
  setIsStreaming(Boolean(event.data?.isStreaming));
}

function updateContextUsage(event: PiResponseEvent, setContext: SetPiContext) {
  const usage = event.data?.contextUsage;
  setContext((current) => ({
    ...current,
    contextTokens: typeof usage?.tokens === 'number' ? usage.tokens : null,
    contextWindow: typeof usage?.contextWindow === 'number' ? usage.contextWindow : null,
    contextPercent: typeof usage?.percent === 'number' ? usage.percent : null,
  }));
}

function withGuiBuiltinCommands(commands: PiCommand[]) {
  const builtinNames = new Set(GUI_BUILTIN_COMMANDS.map((command) => command.name));
  return [...GUI_BUILTIN_COMMANDS, ...commands.filter((command) => !builtinNames.has(command.name))];
}

function normalizeCommands(value: unknown): PiCommand[] {
  if (!Array.isArray(value)) return [];
  return value.filter((command): command is PiCommand => {
    if (!command || typeof command !== 'object') return false;
    const item = command as Partial<PiCommand>;
    return typeof item.name === 'string' && ['extension', 'prompt', 'skill'].includes(String(item.source));
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeModels(value: unknown): PiModel[] {
  if (!Array.isArray(value)) return [];
  return value.filter((model): model is PiModel => {
    if (!model || typeof model !== 'object') return false;
    const item = model as Partial<PiModel>;
    return typeof item.id === 'string' && typeof item.provider === 'string';
  }).sort((left, right) => (left.name || left.id).localeCompare(right.name || right.id));
}

function normalizeThinkingLevels(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((level): level is string => typeof level === 'string') : [];
}

function removeDeliveredQueuedMessage(messages: string[], deliveredText: string) {
  const deliveredIndex = messages.findIndex((queued) => queued.trim() === deliveredText);
  return deliveredIndex < 0 ? messages : messages.filter((_, index) => index !== deliveredIndex);
}

function messageContentText(content: PiMessage['content']) {
  if (typeof content === 'string') return content;
  return content.flatMap((block) => block.type === 'text' && 'text' in block && typeof block.text === 'string' ? [block.text] : []).join('\n');
}

function toolResultText(result: unknown) {
  const content = typeof result === 'object' && result ? (result as { content?: unknown }).content : null;
  if (!Array.isArray(content)) return '';
  return content.filter((item): item is { type: string; text?: string } => typeof item === 'object' && item !== null && 'type' in item)
    .filter((item) => item.type === 'text').map((item) => item.text || '').join('\n');
}

function extensionUiRequest(event: Record<string, unknown>): PiUiRequest | null {
  if (typeof event.id !== 'string' || !['confirm', 'input', 'editor', 'select'].includes(String(event.method))) return null;
  return {
    id: event.id,
    method: event.method as PiUiRequest['method'],
    title: typeof event.title === 'string' ? event.title : 'Pi request',
    message: typeof event.message === 'string' ? event.message : '',
    prefill: typeof event.prefill === 'string' ? event.prefill : '',
    options: Array.isArray(event.options) ? event.options.filter((option): option is string => typeof option === 'string') : [],
    timeout: typeof event.timeout === 'number' ? event.timeout : undefined,
  };
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
