import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PiCommand, PiMessage, PiPromptImage, PiResponseEvent, PiSessionContext, PiToolActivity, PiUiRequest } from './types';
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

export function usePiSession(paneId: string, cwd: string, workspaceId: string) {
  const [messages, setMessages] = useState<PiMessage[]>([]);
  const [context, setContext] = useState<PiSessionContext>(EMPTY_CONTEXT);
  const [streamingText, setStreamingText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [tools, setTools] = useState<PiToolActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [stopped, setStopped] = useState(false);
  const [uiRequest, setUiRequest] = useState<PiUiRequest | null>(null);
  const [commands, setCommands] = useState<PiCommand[]>(GUI_BUILTIN_COMMANDS);
  const [queuedFollowUps, setQueuedFollowUps] = useState<string[]>([]);
  const requestSequence = useRef(0);
  const generationRef = useRef<string | null>(null);
  const pendingRequests = useRef(new Map<string, PendingRequest>());

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
          setIsStreaming(true);
          setStreamingText('');
          setTools([]);
          setError(null);
          break;
        case 'message_update':
          if (event.assistantMessageEvent?.type === 'text_delta') {
            setStreamingText((current) => current + (event.assistantMessageEvent?.delta || ''));
            notifyOutput(workspaceId, paneId);
          }
          break;
        case 'message_end':
          if (event.message && typeof event.message === 'object') {
            const message = event.message as PiMessage;
            setMessages((current) => appendPiMessage(current, message));
            if (message.role === 'assistant') {
              setStreamingText('');
              notifyOutput(workspaceId, paneId);
            }
            if (message.role === 'user') {
              const deliveredText = messageContentText(message.content).trim();
              setQueuedFollowUps((current) => {
                const deliveredIndex = current.findIndex((queued) => queued.trim() === deliveredText);
                return deliveredIndex < 0 ? current : current.filter((_, index) => index !== deliveredIndex);
              });
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
          setQueuedFollowUps(Array.isArray(event.followUp) ? event.followUp.filter((item): item is string => typeof item === 'string') : []);
          break;
        case 'agent_settled':
          setIsStreaming(false);
          setStreamingText('');
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
          notifyRunning(paneId, false);
          setIsStreaming(false);
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
        invoke<string>('start_pi_session', { paneId, cwd })
          .then(async (generation) => {
            generationRef.current = generation;
            await Promise.all([refreshState(), refreshMessages()]);
            refreshCommands().catch(() => setCommands(GUI_BUILTIN_COMMANDS));
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
    };
  }, [cwd, paneId, refreshCommands, refreshMessages, refreshState, refreshStats, workspaceId, writeCommand]);

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
      ? [{ type: 'text' as const, text }, ...images.map((image) => ({ type: 'image', mimeType: image.mimeType, name: image.name, data: '', omitted: true }))]
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

  const followUp = useCallback(async (message: string, images: PiPromptImage[] = []) => {
    const text = message.trim() || (images.length ? 'Please review the attached image.' : '');
    if (!text) return;
    if (images.length && !context.supportsImages) throw new Error('The selected model does not support image input');
    await sendRequest({ type: 'follow_up', message: text, ...(images.length ? { images } : {}) });
  }, [context.supportsImages, sendRequest]);

  const abort = useCallback(() => sendRequest({ type: 'abort' }), [sendRequest]);
  const respondToUiRequest = useCallback(async (response: Record<string, unknown>) => {
    const request = uiRequest;
    if (!request) return;
    setUiRequest(null);
    await writeCommand({ type: 'extension_ui_response', id: request.id, ...response });
  }, [uiRequest, writeCommand]);
  const restart = useCallback(async () => {
    setStarting(true);
    setStopped(false);
    setError(null);
    setQueuedFollowUps([]);
    // Reject every event from the old generation before asking Rust to stop it.
    generationRef.current = 'restarting';
    try {
      await invoke('stop_pi_session', { paneId });
      const generation = await invoke<string>('start_pi_session', { paneId, cwd });
      generationRef.current = generation;
      await Promise.all([refreshState(), refreshMessages()]);
      refreshCommands().catch(() => setCommands(GUI_BUILTIN_COMMANDS));
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
  }, [cwd, paneId, refreshCommands, refreshMessages, refreshState, refreshStats]);

  return { messages, context, commands, queuedFollowUps, streamingText, isStreaming, tools, error, starting, stopped, uiRequest, prompt, runBuiltinCommand, followUp, abort, restart, respondToUiRequest };
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
