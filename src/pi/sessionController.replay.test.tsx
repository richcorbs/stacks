import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PiMarkdown } from '../components/PiMarkdown';
import { PiSessionController, type ControllerDependencies } from './sessionController';

// Keep the optional Node benchmark's host API local; application TS has no Node globals.
declare const process: {
  env: Record<string, string | undefined>;
  cpuUsage(previous?: { user: number; system: number }): { user: number; system: number };
  stdout: { write(text: string): void };
};

/** A controllable host clock, including a host that has throttled its timers. */
export function replaySession() {
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const dependencies = {
    invoke: async () => undefined,
    subscribe: async () => () => {},
    events: { publish: () => {} },
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++sequence;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  } as unknown as ControllerDependencies;
  const controller = new PiSessionController({ paneId: 'replay', workspaceId: 'replay', cwd: '/', projectId: 'replay', projectPath: '/' }, dependencies);
  let order = 0;
  const emit = (event: Parameters<typeof controller.project>[0]['event'], generation = 'generation-1') => controller.project({
    pane_id: 'replay', generation, event_id: `${generation}:${++order}`, event_order: order, event,
  });
  return {
    controller, emit, timers, dependencies,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

const textDelta = (delta: string) => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
const toolUpdate = (text: string, toolCallId = 'tool') => ({ type: 'tool_execution_update', toolCallId, partialResult: { content: [{ type: 'text', text }] } });

describe('live presentation batching', () => {
  it('coalesces bursts, preserves exact text, and avoids unchanged flags and tool snapshots', () => {
    const h = replaySession();
    const listener = vi.fn();
    h.controller.subscribe(listener);
    h.emit({ type: 'tool_execution_start', toolCallId: 'tool', toolName: 'bash' });
    listener.mockClear();
    const pieces = Array.from({ length: 1000 }, (_, i) => `part ${i} 🦊\n`);
    for (const piece of pieces) {
      h.emit(textDelta(piece));
      h.emit(toolUpdate(piece));
    }
    expect(listener).not.toHaveBeenCalled();
    expect(h.timers.size).toBe(1);
    h.advance(15);
    expect(listener).not.toHaveBeenCalled();
    h.advance(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot()).toMatchObject({ streamingText: pieces.join(''), isStreamingText: true, tools: [{ partialText: pieces.at(-1) }] });
    const snapshot = h.controller.getSnapshot();
    h.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } });
    h.emit(toolUpdate(pieces.at(-1)!));
    h.advance(16);
    expect(h.controller.getSnapshot()).toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(h.timers.size).toBe(0);
    h.controller.delete(false);
  });

  it('flushes before completion even when background timers never run', () => {
    const h = replaySession();
    h.controller.setViewOpen(false);
    const seen: string[] = [];
    h.controller.subscribe(() => seen.push(h.controller.getSnapshot().streamingText));
    h.emit(textDelta('exact final 🦊'));
    h.emit({ type: 'message_end', message: { role: 'assistant', content: 'exact final 🦊' } });
    expect(seen).toEqual(['exact final 🦊', '']);
    expect(h.controller.getSnapshot().messages[0].content).toBe('exact final 🦊');
    expect(h.timers.size).toBe(0);
    h.advance(10_000);
    expect(seen).toHaveLength(2);
    h.controller.delete(false);
  });

  it('publishes hidden retained views without animation frames or subscribers', () => {
    const h = replaySession();
    h.controller.setViewOpen(false);
    h.emit(textDelta('background'));
    h.advance(16);
    expect(h.controller.getSnapshot().streamingText).toBe('background');
    expect(h.timers.size).toBe(0);
    h.controller.delete(false);
  });

  it('preserves text/tool ordering, cumulative partial results and final tool results', () => {
    const h = replaySession();
    const seen: Array<{ text: string; tools: string[]; messages: number }> = [];
    h.controller.subscribe(() => {
      const s = h.controller.getSnapshot();
      seen.push({ text: s.streamingText, tools: s.tools.map(t => `${t.id}:${t.status}:${t.partialText}`), messages: s.messages.length });
    });
    h.emit(textDelta('before tool'));
    h.emit({ type: 'tool_execution_start', toolCallId: 'tool', toolName: 'bash' });
    h.emit({ type: 'tool_execution_start', toolCallId: 'other', toolName: 'read' });
    h.emit(toolUpdate('partial'));
    h.emit(toolUpdate('other partial', 'other'));
    h.emit(toolUpdate('latest partial'));
    h.emit(textDelta(' after tool'));
    h.emit({ type: 'tool_execution_end', toolCallId: 'tool', result: { content: [{ type: 'text', text: 'final result' }] }, durationMs: 5 });
    expect(seen[0]).toEqual({ text: 'before tool', tools: [], messages: 0 });
    expect(seen.at(-2)).toEqual({ text: 'before tool after tool', tools: ['tool:running:latest partial', 'other:running:other partial'], messages: 0 });
    expect(h.controller.getSnapshot().tools[0]).toMatchObject({ partialText: 'final result', status: 'complete', durationMs: 5 });
    h.emit({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'tool', content: 'final result' } });
    h.emit(toolUpdate('must not resurrect'));
    h.advance(16);
    expect(h.controller.getSnapshot().tools.map(t => t.id)).toEqual(['other']);
    expect(h.controller.getSnapshot().messages[0].content).toBe('final result');
    h.controller.delete(false);
    expect(h.timers.size).toBe(0);
  });

  it('flushes before non-text message events and retains the live text size limit', () => {
    const h = replaySession();
    const seen: Array<[string, boolean]> = [];
    h.controller.subscribe(() => {
      const s = h.controller.getSnapshot();
      seen.push([s.streamingText, s.isStreamingText]);
    });
    h.emit(textDelta('text'));
    h.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'private' } });
    expect(seen).toEqual([['text', true], ['text', false]]);
    h.emit(textDelta('a'.repeat(1_000_010)));
    h.emit(textDelta('last'));
    h.advance(16);
    expect(h.controller.getSnapshot().streamingText).toBe(`${'a'.repeat(999_996)}last`);
    h.controller.delete(false);
    expect(h.timers.size).toBe(0);
  });

  it('keeps protocol responses immediate and flushes before UI/lifecycle transitions', () => {
    const h = replaySession();
    const seen: string[] = [];
    h.controller.subscribe(() => seen.push(h.controller.getSnapshot().streamingText));
    h.emit(textDelta('pending'));
    h.emit({ type: 'response', id: 'unknown', success: false, error: 'immediate error' });
    expect(seen).toEqual(['pending', 'pending']);
    expect(h.controller.getSnapshot().error).toBe('immediate error');
    h.emit(textDelta(' tail'));
    h.emit({ type: 'pi_process_exit' });
    expect(seen.slice(-2)).toEqual(['pending tail', '']);
    expect(h.controller.getSnapshot()).toMatchObject({ stopped: true, isStreaming: false });
    expect(h.timers.size).toBe(0);
    h.controller.delete(false);
  });

  it('cancels restart work and rejects stale generations and already queued callbacks', async () => {
    const h = replaySession();
    h.emit({ type: 'tool_execution_start', toolCallId: 'tool', toolName: 'bash' });
    h.emit(toolUpdate('old partial'));
    h.emit(textDelta('old'));
    const stale = [...h.timers.values()][0].callback;
    h.dependencies.invoke = (async (command: string, args?: Record<string, unknown>) => {
      if (command === 'start_pi_session') return 'generation-2';
      if (command === 'send_pi_rpc') {
        const request = args?.command as Record<string, unknown>;
        queueMicrotask(() => h.emit({ type: 'response', id: request.id as string, success: true, data: {} }, 'generation-2'));
      }
    }) as ControllerDependencies['invoke'];
    await h.controller.restart();
    expect(h.controller.getSnapshot().tools).toEqual([]);
    h.emit(textDelta('new'), 'generation-2');
    h.emit(textDelta('stale'), 'generation-1');
    stale();
    expect(h.controller.getSnapshot().streamingText).toBe('');
    expect(h.timers.size).toBe(1);
    h.advance(16);
    expect(h.controller.getSnapshot().streamingText).toBe('new');
    h.controller.delete(false);
    expect(h.timers.size).toBe(0);
  });

  it('deletes/disposes without leaked callbacks or late publications', () => {
    const h = replaySession();
    const listener = vi.fn();
    h.controller.subscribe(listener);
    h.emit(textDelta('discard'));
    const stale = [...h.timers.values()][0].callback;
    const snapshot = h.controller.getSnapshot();
    h.controller.delete(false);
    h.controller.delete(false);
    stale();
    h.emit(textDelta('late'));
    h.advance(1000);
    expect(listener).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot()).toBe(snapshot);
    expect(h.timers.size).toBe(0);
  });
});

// Opt-in: real Markdown parse/sanitize/render CPU, not part of the timing-sensitive test suite.
// PI_STREAM_BENCH=1 npx vitest run src/pi/sessionController.replay.test.tsx
// SSR is a reproducible render-work proxy, not a browser input-latency measurement.
describe.skipIf(!process.env.PI_STREAM_BENCH)('live stream replay benchmark', () => {
  for (const agents of [1, 4]) it(`${agents} concurrent agents`, () => {
    const sessions = Array.from({ length: agents }, replaySession);
    let notifications = 0;
    let renders = 0;
    let renderMs = 0;
    let worstPublishMs = 0;
    const cpu = process.cpuUsage();
    const start = performance.now();
    for (const h of sessions) {
      let previousText = '';
      h.controller.subscribe(() => {
        notifications++;
        const text = h.controller.getSnapshot().streamingText;
        if (!text || text === previousText) return;
        previousText = text;
        const started = performance.now();
        renderToStaticMarkup(<PiMarkdown>{text}</PiMarkdown>);
        const elapsed = performance.now() - started;
        renderMs += elapsed;
        worstPublishMs = Math.max(worstPublishMs, elapsed);
        renders++;
      });
      h.emit({ type: 'tool_execution_start', toolCallId: 'tool', toolName: 'bash' });
    }
    let expected = '';
    for (let index = 0; index < 320; index++) {
      const delta = `Streaming **line ${index}** with [safe link](https://example.com).\n\n`;
      expected += delta;
      for (const h of sessions) {
        h.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
        h.emit({ type: 'tool_execution_update', toolCallId: 'tool', partialResult: { content: [{ type: 'text', text: `progress ${index}` }] } });
        h.advance(2);
      }
    }
    for (const h of sessions) {
      h.advance(100);
      expect(h.controller.getSnapshot().streamingText).toBe(expected);
      h.emit({ type: 'message_end', message: { role: 'assistant', content: expected } });
      expect(h.controller.getSnapshot().messages[0].content).toBe(expected);
      h.controller.delete(false);
      expect(h.timers.size).toBe(0);
    }
    const used = process.cpuUsage(cpu);
    process.stdout.write(`${JSON.stringify({ agents, notifications, renders, renderMs: Math.round(renderMs), wallMs: Math.round(performance.now() - start), cpuMs: Math.round((used.user + used.system) / 1000), worstPublishMs: Math.round(worstPublishMs) })}\n`);
  }, 180_000);
});
