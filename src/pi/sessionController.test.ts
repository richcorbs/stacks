import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PiSessionController, type ControllerDependencies, type PiSessionConfig } from './sessionController';
import type { PiRpcEnvelope } from './types';
import { setPiUiRequestWorkflowHandler } from './uiRequestWorkflow';

beforeAll(() => {
  if (!globalThis.window) Object.assign(globalThis, { window: new EventTarget() });
});

const config: PiSessionConfig = { paneId: 'kanban-card:card-1:work', cwd: '/work', workspaceId: 'kanban-card:card-1', projectId: 'project-1', projectPath: '/project' };

function harness(sessionConfig = config) {
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
  const publish = vi.fn();
  const dependencies: ControllerDependencies = {
    invoke: invokeMock as ControllerDependencies['invoke'],
    subscribe: subscribeMock,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    events: { publish: publish as ControllerDependencies['events']['publish'] },
  };
  const controller = new PiSessionController(sessionConfig, dependencies);
  return { controller, commands, dependencies, publish,
    emit: (event: PiRpcEnvelope) => eventSubscriber?.({ ...event, pane_id: sessionConfig.paneId }), stop, subscribeMock };
}

function envelope(event: PiRpcEnvelope['event'], generation = 'generation-1'): PiRpcEnvelope {
  return { pane_id: config.paneId, generation, event_id: `${generation}:0`, event_order: 0, event };
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

  it('keeps a manually submitted first prompt singular when its live event is not adjacent', async () => {
    const h = harness();
    await begin(h);
    respond(h, 0, 'get_state', { isStreaming: false });
    respond(h, 1, 'get_messages', { messages: [] });
    await vi.waitFor(() => expect(h.controller.getSnapshot().starting).toBe(false));

    const submitted = h.controller.prompt('manual first prompt');
    const prompt = h.commands.find((command) => command.type === 'prompt')!;
    h.emit(envelope({ type: 'message_end', message: { role: 'assistant', content: 'interleaved output', timestamp: 20 } }));
    h.emit(envelope({ type: 'message_end', message: { role: 'user', content: 'manual first prompt', timestamp: 21 } }));
    h.emit(envelope({ type: 'response', id: prompt.id as string, command: 'prompt', success: true, data: {} }));
    await submitted;

    expect(h.controller.getSnapshot().messages.map((message) => message.content)).toEqual([
      'manual first prompt', 'interleaved output',
    ]);
    h.controller.delete();
  });

  it('keeps one initial prompt through hydration, a late live replay, and view reopening', async () => {
    const h = harness({ ...config, paneId: 'kanban-card:card-1:planning' });
    const closeView = h.controller.subscribe(() => {});
    const launch = h.controller.submitWorkLaunch('initial planning prompt');
    await vi.waitFor(() => expect(h.commands.length).toBeGreaterThanOrEqual(2));
    respond(h, 0, 'get_state', { isStreaming: false });
    respond(h, 1, 'get_messages', { messages: [] });
    await vi.waitFor(() => expect(h.commands.some((command) => command.type === 'prompt')).toBe(true));
    const prompt = h.commands.find((command) => command.type === 'prompt')!;
    h.emit(envelope({ type: 'response', id: prompt.id as string, command: 'prompt', success: true, data: {} }));
    await launch;

    expect(h.controller.getSnapshot().messages).toHaveLength(1);
    expect(h.controller.getSnapshot().messages[0].local).toBe(true);

    h.emit(envelope({ type: 'session_switch' }));
    await vi.waitFor(() => expect(h.commands.filter((command) => command.type === 'get_messages')).toHaveLength(2));
    const messagesIndex = h.commands.map((command) => command.type).lastIndexOf('get_messages');
    const stateIndex = h.commands.map((command) => command.type).lastIndexOf('get_state');
    respond(h, messagesIndex, 'get_messages', { messages: [{ messageId: 'hydrated-prompt', role: 'user', content: [{ type: 'text', text: 'initial planning prompt' }], timestamp: 98 }] });
    respond(h, stateIndex, 'get_state', { isStreaming: true });
    await vi.waitFor(() => expect(h.controller.getSnapshot().messages[0].local).not.toBe(true));

    closeView();
    h.emit(envelope({ type: 'message_end', message: { role: 'user', content: 'initial planning prompt', timestamp: 99 } }));
    expect(h.controller.getSnapshot().messages).toHaveLength(1);

    const reopened = vi.fn();
    h.controller.subscribe(reopened);
    expect(h.controller.getSnapshot().messages).toHaveLength(1);
    expect(h.subscribeMock).toHaveBeenCalledOnce();

    h.emit(envelope({ type: 'message_end', message: { role: 'user', content: 'initial planning prompt', timestamp: 100 } }));
    expect(h.controller.getSnapshot().messages).toHaveLength(2);
    h.controller.delete();
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

  it('always projects structured requests for the application-level visibility filter', async () => {
    for (const open of [true, false]) {
      const h = harness();
      await begin(h);
      h.controller.setViewOpen(open);
      h.emit(envelope({ type: 'extension_ui_request', id: `request-${open}`, method: 'confirm' }));
      const attention = h.publish.mock.calls
        .find(([key, payload]) => key === 'attention' && payload.kind === 'pi-request')?.[1];
      expect(attention).toMatchObject({
        owner: { kind: 'card', cardId: 'card-1' },
        target: { view: 'agent', agentThread: 'work', terminalId: config.paneId },
      });
      expect(attention?.lifecycleKey).toContain(`request-${open}`);
      h.controller.delete();
    }
  });

  it.each([
    [{ confirmed: true }, { confirmed: true }],
    [{ confirmed: false }, { confirmed: false }],
  ])('claims a confirm once and writes its boolean payload', async (response, expected) => {
    const h = harness();
    h.controller.project(envelope({ type: 'extension_ui_request', id: 'confirm-1', method: 'confirm' }));

    const result = h.controller.respondToUiRequest('confirm-1', response);
    expect(h.controller.getSnapshot().uiRequest).toBeNull();
    expect(await result).toBe(true);
    expect(h.commands).toContainEqual({ type: 'extension_ui_response', id: 'confirm-1', ...expected });
  });

  it('claims a select once before asynchronous reconciliation and ignores duplicate clicks', async () => {
    const h = harness();
    let release!: () => void;
    const workflowGate = new Promise<void>((resolve) => { release = resolve; });
    const beforeResponse = vi.fn(() => workflowGate);
    const unsetWorkflow = setPiUiRequestWorkflowHandler({ received: vi.fn(), beforeResponse, dismissed: vi.fn() });
    h.controller.project(envelope({ type: 'extension_ui_request', id: 'select-1', method: 'select', options: ['A', 'B'] }));

    const first = h.controller.respondToUiRequest('select-1', { value: 'B' });
    const duplicate = h.controller.respondToUiRequest('select-1', { value: 'A' });
    expect(h.controller.getSnapshot().uiRequest).toBeNull();
    expect(await duplicate).toBe(false);
    expect(h.commands).toEqual([]);
    release();
    expect(await first).toBe(true);
    expect(beforeResponse).toHaveBeenCalledOnce();
    expect(h.commands).toEqual([{ type: 'extension_ui_response', id: 'select-1', value: 'B' }]);
    unsetWorkflow();
  });

  it('allows only one claim in click-versus-submit races', async () => {
    const h = harness();
    h.controller.project(envelope({ type: 'extension_ui_request', id: 'click-first', method: 'confirm' }));
    const click = h.controller.respondToUiRequest('click-first', { confirmed: true });
    expect(await h.controller.dismissStructuredUiRequest()).toBe(false);
    await click;

    h.controller.project(envelope({ type: 'extension_ui_request', id: 'submit-first', method: 'confirm' }));
    const submit = h.controller.dismissStructuredUiRequest();
    expect(await h.controller.respondToUiRequest('submit-first', { confirmed: false })).toBe(false);
    await submit;

    expect(h.commands).toEqual([
      { type: 'extension_ui_response', id: 'click-first', confirmed: true },
      { type: 'extension_ui_response', id: 'submit-first', cancelled: true },
    ]);
  });

  it('binds a response to its rendered request ID across replacement', async () => {
    const h = harness();
    h.controller.project(envelope({ type: 'extension_ui_request', id: 'old', method: 'select', options: ['Old'] }));
    h.controller.project(envelope({ type: 'extension_ui_request', id: 'new', method: 'select', options: ['New'] }));

    expect(await h.controller.respondToUiRequest('old', { value: 'Old' })).toBe(false);
    expect(h.controller.getSnapshot().uiRequest?.id).toBe('new');
    expect(h.commands).toEqual([]);
  });

  it('cancels a structured request before preserving normal typed prompt submission', async () => {
    const h = harness();
    h.controller.project(envelope({ type: 'extension_ui_request', id: 'question', method: 'confirm' }));

    const dismissal = h.controller.dismissStructuredUiRequest();
    expect(h.controller.getSnapshot().uiRequest).toBeNull();
    expect(await dismissal).toBe(true);
    expect(h.commands[0]).toEqual({ type: 'extension_ui_response', id: 'question', cancelled: true });

    const prompt = h.controller.prompt('typed answer');
    const promptCommand = h.commands.find((command) => command.type === 'prompt')!;
    expect(promptCommand.message).toBe('typed answer');
    h.controller.project(envelope({ type: 'response', id: promptCommand.id as string, command: 'prompt', success: true, data: {} }));
    await prompt;
  });

  it('times out only the request that owns the timer', async () => {
    const h = harness();
    h.controller.project(envelope({ type: 'extension_ui_request', id: 'short', method: 'confirm', timeout: 5 }));
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(h.controller.getSnapshot().uiRequest).toBeNull();
    expect(await h.controller.respondToUiRequest('short', { confirmed: true })).toBe(false);
  });

  it('prevents a claimed response from writing after replacement or session stop', async () => {
    const h = harness();
    let release!: () => void;
    const workflowGate = new Promise<void>((resolve) => { release = resolve; });
    const unsetWorkflow = setPiUiRequestWorkflowHandler({ received: vi.fn(), beforeResponse: () => workflowGate, dismissed: vi.fn() });
    h.controller.project(envelope({ type: 'extension_ui_request', id: 'old', method: 'confirm' }));
    const response = h.controller.respondToUiRequest('old', { confirmed: true });
    h.controller.project(envelope({ type: 'extension_ui_request', id: 'replacement', method: 'confirm' }));
    h.controller.project(envelope({ type: 'pi_process_exit' }));
    release();
    await response;
    expect(h.commands).toEqual([]);
    expect(h.controller.getSnapshot().uiRequest).toBeNull();
    unsetWorkflow();
  });

  it('clears controls on deletion and prevents a claimed response from writing afterward', async () => {
    const h = harness();
    let release!: () => void;
    const workflowGate = new Promise<void>((resolve) => { release = resolve; });
    const unsetWorkflow = setPiUiRequestWorkflowHandler({ received: vi.fn(), beforeResponse: () => workflowGate, dismissed: vi.fn() });
    h.controller.project(envelope({ type: 'extension_ui_request', id: 'delete-me', method: 'select', options: ['Go'] }));
    const response = h.controller.respondToUiRequest('delete-me', { value: 'Go' });
    h.controller.delete();
    expect(h.controller.getSnapshot().uiRequest).toBeNull();
    release();
    await response;
    expect(h.commands).toEqual([]);
    unsetWorkflow();
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
    await vi.waitFor(() => expect(h.commands.some((command) => command.type === 'clear_queue')).toBe(true));
    const clearIndex = h.commands.findIndex((command) => command.type === 'clear_queue');
    respond(h, clearIndex, 'clear_queue', { steering: [], followUp: [] });
    await vi.waitFor(() => expect(h.commands.some((command) => command.type === 'abort')).toBe(true));
    const abortIndex = h.commands.findIndex((command) => command.type === 'abort');
    respond(h, abortIndex, 'abort', {});
    await stopping;

    expect(h.controller.getSnapshot().messages[0].content).toBe('Retained plan');
    expect(h.controller.getSnapshot().uiRequest).toBeNull();
    expect(h.stop).not.toHaveBeenCalled();
    h.controller.delete();
  });

  it('does not emit completion attention after a user abort', async () => {
    const h = harness();
    await begin(h);
    h.emit(envelope({ type: 'agent_start' }));
    h.emit(envelope({ type: 'queue_update', steering: ['queued steer'], followUp: ['queued follow-up'] }));
    const aborting = h.controller.abort();
    await vi.waitFor(() => expect(h.commands.some((command) => command.type === 'clear_queue')).toBe(true));
    expect(h.commands.some((command) => command.type === 'abort')).toBe(false);
    const clearIndex = h.commands.findIndex((command) => command.type === 'clear_queue');
    respond(h, clearIndex, 'clear_queue', { steering: ['queued steer'], followUp: ['queued follow-up'] });
    await vi.waitFor(() => expect(h.commands.some((command) => command.type === 'abort')).toBe(true));
    expect(h.controller.getSnapshot()).toMatchObject({ queuedSteering: [], queuedFollowUps: [] });
    const abortIndex = h.commands.findIndex((command) => command.type === 'abort');
    respond(h, abortIndex, 'abort', {});
    await aborting;
    h.emit(envelope({ type: 'agent_settled' }));
    expect(h.publish.mock.calls.some(([key, payload]) => key === 'attention' && payload.kind === 'pi-complete')).toBe(false);
    h.controller.delete();
  });

  it('emits a completion notification exactly once for an eligible run', async () => {
    const h = harness();
    await begin(h);
    h.emit(envelope({ type: 'agent_start' }));
    h.emit(envelope({ type: 'agent_settled' }));
    h.emit(envelope({ type: 'agent_settled' }));
    const attentionEvents = h.publish.mock.calls
      .filter(([key, payload]) => key === 'attention' && payload.kind === 'pi-complete');
    expect(attentionEvents).toHaveLength(1);
    h.controller.delete();
  });

  it('shares awaitable initialization and accepts only one original work prompt', async () => {
    const h = harness();
    const first = h.controller.submitWorkLaunch('full card task');
    const duplicate = h.controller.submitWorkLaunch('full card task');
    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(h.commands.length).toBeGreaterThanOrEqual(2));
    respond(h, 0, 'get_state', { isStreaming: false });
    respond(h, 1, 'get_messages', { messages: [] });
    await vi.waitFor(() => expect(h.commands.some((command) => command.type === 'prompt')).toBe(true));
    const prompts = h.commands.filter((command) => command.type === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0].message).toBe('full card task');
    h.controller.project(envelope({ type: 'response', id: prompts[0].id as string, command: 'prompt', success: true, data: {} }));
    await first;
    h.controller.delete();
  });

  it('treats an already active hydrated turn as launched without another prompt', async () => {
    const h = harness();
    const launch = h.controller.submitWorkLaunch('full card task');
    await vi.waitFor(() => expect(h.commands.length).toBeGreaterThanOrEqual(2));
    respond(h, 0, 'get_state', { isStreaming: true });
    respond(h, 1, 'get_messages', { messages: [{ role: 'user', content: 'full card task', timestamp: 1 }] });
    await expect(launch).resolves.toBe(true);
    expect(h.commands.filter((command) => command.type === 'prompt')).toHaveLength(0);
    h.controller.delete();
  });

  it('rehydrates an ambiguous failed prompt and does not replay one Pi accepted', async () => {
    const h = harness();
    const launch = h.controller.submitWorkLaunch('full card task');
    await vi.waitFor(() => expect(h.commands.length).toBeGreaterThanOrEqual(2));
    respond(h, 0, 'get_state', { isStreaming: false });
    respond(h, 1, 'get_messages', { messages: [] });
    await vi.waitFor(() => expect(h.commands.some((command) => command.type === 'prompt')).toBe(true));
    const promptIndex = h.commands.findIndex((command) => command.type === 'prompt');
    h.emit(envelope({ type: 'message_end', message: { role: 'user', content: 'full card task', timestamp: 99 } }));
    h.controller.project(envelope({ type: 'response', id: h.commands[promptIndex].id as string, command: 'prompt', success: false, error: 'transport lost reply' }));

    await vi.waitFor(() => expect(h.commands.filter((command) => command.type === 'get_state')).toHaveLength(2));
    const stateIndex = h.commands.map((command) => command.type).lastIndexOf('get_state');
    const messagesIndex = h.commands.map((command) => command.type).lastIndexOf('get_messages');
    respond(h, stateIndex, 'get_state', { isStreaming: true });
    respond(h, messagesIndex, 'get_messages', { messages: [{ role: 'user', content: 'full card task', timestamp: 99 }] });

    await expect(launch).resolves.toBe(true);
    expect(h.commands.filter((command) => command.type === 'prompt')).toHaveLength(1);
    expect(h.controller.getSnapshot().messages).toHaveLength(1);
    expect(h.controller.getSnapshot().error).toBeNull();
    h.controller.delete();
  });

  it('continues a persisted work transcript instead of resending the original task', async () => {
    const h = harness();
    const launch = h.controller.submitWorkLaunch('full card task');
    await vi.waitFor(() => expect(h.commands.length).toBeGreaterThanOrEqual(2));
    respond(h, 0, 'get_state', { isStreaming: false });
    respond(h, 1, 'get_messages', { messages: [{ role: 'user', content: 'full card task', timestamp: 1 }] });
    await vi.waitFor(() => expect(h.commands.some((command) => command.type === 'prompt')).toBe(true));
    const prompt = h.commands.find((command) => command.type === 'prompt')!;
    expect(prompt.message).toBe('continue');
    h.controller.project(envelope({ type: 'response', id: prompt.id as string, command: 'prompt', success: true, data: {} }));
    await launch;
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
