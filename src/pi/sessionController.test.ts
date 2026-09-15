import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PiSessionController, type ControllerDependencies, type PiSessionConfig } from './sessionController';
import type { PiRpcEnvelope } from './types';

beforeAll(() => {
  if (!globalThis.window) Object.assign(globalThis, { window: new EventTarget() });
});

const config: PiSessionConfig = { paneId: 'pane-1', cwd: '/work', workspaceId: 'workspace-1', projectId: 'project-1', projectPath: '/project' };

function harness() {
  let eventSubscriber: ((event: PiRpcEnvelope) => void) | undefined;
  const commands: Record<string, unknown>[] = [];
  const stop = vi.fn();
  const invokeMock = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'start_pi_session') return 'generation-1';
    if (command === 'send_pi_rpc') commands.push(args?.command as Record<string, unknown>);
    return undefined;
  });
  const subscribeMock = vi.fn(async (_paneId: string, subscriber: (event: PiRpcEnvelope) => void) => {
    eventSubscriber = subscriber;
    return stop;
  });
  const dependencies: ControllerDependencies = {
    invoke: invokeMock as ControllerDependencies['invoke'],
    subscribe: subscribeMock,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    dispatch: vi.fn(() => true),
  };
  const controller = new PiSessionController(config, dependencies);
  return { controller, commands, dependencies, emit: (event: PiRpcEnvelope) => eventSubscriber?.(event), stop, subscribeMock };
}

function envelope(event: PiRpcEnvelope['event'], generation = 'generation-1'): PiRpcEnvelope {
  return { pane_id: config.paneId, generation, event };
}

async function begin(h: ReturnType<typeof harness>) {
  h.controller.initialize();
  await vi.waitFor(() => expect(h.commands.length).toBeGreaterThanOrEqual(2));
}

function respond(h: ReturnType<typeof harness>, index: number, command: string, data: Record<string, unknown>) {
  h.emit(envelope({ type: 'response', id: h.commands[index].id as string, command, success: true, data }));
}

describe('PiSessionController', () => {
  it('keeps one backend subscription and projects events while no view is subscribed', async () => {
    const h = harness();
    const first = vi.fn();
    const unsubscribe = h.controller.subscribe(first);
    await begin(h);
    unsubscribe();

    h.emit(envelope({ type: 'message_end', message: { role: 'assistant', content: 'continued in background', timestamp: 1 } }));
    expect(first).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().messages).toHaveLength(1);

    const reopened = vi.fn();
    h.controller.subscribe(reopened);
    expect(h.controller.getSnapshot().messages[0].content).toBe('continued in background');
    h.emit(envelope({ type: 'message_end', message: { role: 'assistant', content: 'still live', timestamp: 2 } }));
    expect(reopened).toHaveBeenCalledOnce();
    expect(h.subscribeMock).toHaveBeenCalledOnce();
  });

  it('merges hydration with interleaved live messages without duplicates or gaps', async () => {
    const h = harness();
    await begin(h);
    h.emit(envelope({ type: 'message_end', message: { role: 'assistant', content: 'live', timestamp: 2 } }));

    respond(h, 1, 'get_messages', { messages: [
      { role: 'user', content: 'old', timestamp: 1 },
      { role: 'assistant', content: 'live', timestamp: 2 },
    ] });
    respond(h, 0, 'get_state', { isStreaming: true });

    await vi.waitFor(() => expect(h.controller.getSnapshot().starting).toBe(false));
    expect(h.controller.getSnapshot().messages.map((message) => message.content)).toEqual(['old', 'live']);
    expect(h.controller.getSnapshot().isStreaming).toBe(true);
  });

  it('rejects stale generations and bounds transient tool state', async () => {
    const h = harness();
    await begin(h);
    h.emit(envelope({ type: 'message_end', message: { role: 'assistant', content: 'stale', timestamp: 1 } }, 'old-generation'));
    expect(h.controller.getSnapshot().messages).toEqual([]);

    for (let index = 0; index < 125; index += 1) {
      h.emit(envelope({ type: 'tool_execution_start', toolCallId: `tool-${index}`, toolName: 'read', args: {} }));
    }
    expect(h.controller.getSnapshot().tools).toHaveLength(100);
    expect(h.controller.getSnapshot().tools[0].id).toBe('tool-25');
  });

  it.each(['confirm', 'select', 'input', 'editor'] as const)('retains a %s request across view unsubscribe/resubscribe', async (method) => {
    const h = harness();
    const unsubscribe = h.controller.subscribe(() => {});
    await begin(h);
    unsubscribe();
    h.emit(envelope({ type: 'extension_ui_request', id: `request-${method}`, method, title: 'Question', timeout: 60_000 }));
    expect(h.controller.getSnapshot().uiRequest).toMatchObject({ id: `request-${method}`, method });
    h.controller.subscribe(() => {});
    expect(h.controller.getSnapshot().uiRequest?.method).toBe(method);
    h.controller.delete();
  });

  it('requests attention only when the pane view is not open', async () => {
    const open = harness();
    await begin(open);
    open.controller.setViewOpen(true);
    open.emit(envelope({ type: 'extension_ui_request', id: 'open-request', method: 'confirm' }));
    expect(vi.mocked(open.dependencies.dispatch).mock.calls.some(([event]) => (event as CustomEvent).detail?.kind === 'pi-request')).toBe(false);
    open.controller.delete();

    const closed = harness();
    await begin(closed);
    closed.controller.setViewOpen(false);
    closed.emit(envelope({ type: 'extension_ui_request', id: 'closed-request', method: 'confirm' }));
    expect(vi.mocked(closed.dependencies.dispatch).mock.calls.some(([event]) => (event as CustomEvent).detail?.kind === 'pi-request')).toBe(true);
    closed.controller.delete();
  });

  it('does not let stale state hydration overwrite a newer agent-start event', async () => {
    const h = harness();
    await begin(h);
    h.emit(envelope({ type: 'agent_start' }));
    respond(h, 0, 'get_state', { isStreaming: false });
    respond(h, 1, 'get_messages', { messages: [] });
    await vi.waitFor(() => expect(h.controller.getSnapshot().starting).toBe(false));
    expect(h.controller.getSnapshot().isStreaming).toBe(true);
  });

  it('stops active refinement without deleting its transcript or controller', async () => {
    const h = harness();
    await begin(h);
    h.emit(envelope({ type: 'message_end', message: { role: 'assistant', content: 'Retained plan', timestamp: 1 } }));
    h.emit(envelope({ type: 'agent_start' }));
    h.emit(envelope({ type: 'extension_ui_request', id: 'question', method: 'confirm' }));

    const stopping = h.controller.stopRefinement();
    await vi.waitFor(() => expect(h.commands.some((command) => command.type === 'abort')).toBe(true));
    const abortIndex = h.commands.findIndex((command) => command.type === 'abort');
    respond(h, abortIndex, 'abort', {});
    await stopping;

    expect(h.controller.getSnapshot().messages[0].content).toBe('Retained plan');
    expect(h.controller.getSnapshot().uiRequest).toBeNull();
    expect(h.stop).not.toHaveBeenCalled();
    h.controller.delete();
  });

  it('emits a completion notification exactly once for an eligible run', async () => {
    const h = harness();
    await begin(h);
    h.emit(envelope({ type: 'agent_start' }));
    h.emit(envelope({ type: 'agent_settled' }));
    h.emit(envelope({ type: 'agent_settled' }));
    const attentionEvents = vi.mocked(h.dependencies.dispatch).mock.calls
      .map(([event]) => event as CustomEvent<{ kind?: string }>)
      .filter((event) => event.type === 'app-attention' && event.detail?.kind === 'pi-complete');
    expect(attentionEvents).toHaveLength(1);
    h.controller.delete();
  });

  it('stops projection and releases the backend listener on explicit deletion', async () => {
    const h = harness();
    await begin(h);
    h.controller.delete();
    expect(h.stop).toHaveBeenCalledOnce();
    h.controller.project(envelope({ type: 'message_end', message: { role: 'assistant', content: 'ignored', timestamp: 1 } }));
    expect(h.controller.getSnapshot().messages).toEqual([]);
  });
});
