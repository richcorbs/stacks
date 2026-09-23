import { describe, expect, it } from 'vitest';
import { appendPiMessage, compactPiMessages, hasVisiblePiStreamingText, INITIAL_RENDERED_PI_MESSAGES, MAX_LIVE_IMAGE_PREVIEWS, MAX_STORED_PI_MESSAGES, nextPiMessageLimit, prependAnchoredScrollTop, reconcilePiMessages, visiblePiMessages } from './transcript';
import type { PiMessage } from './types';

describe('Pi transcript', () => {
  it('does not treat whitespace-only streaming deltas as visible text', () => {
    expect(hasVisiblePiStreamingText(' \n\t\u200b')).toBe(false);
    expect(hasVisiblePiStreamingText('\nHello')).toBe(true);
  });

  it('deduplicates replayed messages by role and timestamp', () => {
    const message: PiMessage = { role: 'assistant', timestamp: 42, content: 'done' };
    const messages = [message];
    expect(appendPiMessage(messages, { ...message })).toBe(messages);
  });

  it('replaces an optimistic user message with the persisted event', () => {
    const optimistic: PiMessage = { role: 'user', content: 'hello', timestamp: 1, local: true };
    const persisted: PiMessage = { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 2 };
    expect(appendPiMessage([optimistic], persisted)).toEqual([persisted]);
  });

  it('reconciles optimistic, live, and hydrated copies by occurrence', () => {
    const optimistic: PiMessage = { role: 'user', content: 'plan this', timestamp: 10, local: true };
    const liveUser: PiMessage = { role: 'user', content: 'plan this', timestamp: 20 };
    const liveAssistant: PiMessage = { role: 'assistant', content: 'working', timestamp: 30 };
    const hydrated = [
      { role: 'user', content: [{ type: 'text' as const, text: 'plan this' }], timestamp: 20 },
      { role: 'assistant', content: 'working', timestamp: 30 },
    ];
    expect(reconcilePiMessages(hydrated, [optimistic, liveUser, liveAssistant])).toEqual(hydrated);
  });

  it('does not collapse intentional identical user messages from separate turns', () => {
    const first: PiMessage = { role: 'user', content: 'continue', timestamp: 1 };
    const second: PiMessage = { role: 'user', content: 'continue', timestamp: 2 };
    expect(reconcilePiMessages([first], [first, second])).toEqual([first, second]);
    expect(appendPiMessage([first], second)).toEqual([first, second]);
  });

  it('deduplicates a stable live message even when it is no longer last', () => {
    const assistant: PiMessage = { id: 'assistant-1', role: 'assistant', content: 'done' };
    const messages = [assistant, { role: 'user', content: 'later', timestamp: 2 }];
    expect(appendPiMessage(messages, { ...assistant })).toBe(messages);
  });

  it('collapses expanded skill documentation back to its invocation', () => {
    const optimistic: PiMessage = { role: 'user', content: '/skill:refine 2139', local: true };
    const persisted: PiMessage = {
      role: 'user',
      content: [{ type: 'text', text: '<skill name="refine" location="/tmp/refine/SKILL.md">\n# Long documentation\nDo many things.\n</skill>\n\n2139' }],
    };
    expect(appendPiMessage([optimistic], persisted)).toEqual([{ role: 'user', content: '/skill:refine 2139' }]);
    expect(compactPiMessages([persisted])).toEqual([{ role: 'user', content: '/skill:refine 2139' }]);
  });

  it('retains a recent submitted image preview when the persisted message arrives', () => {
    const optimistic: PiMessage = {
      role: 'user',
      local: true,
      content: [{ type: 'text', text: 'review this' }, { type: 'image', data: 'preview-base64', mimeType: 'image/jpeg' }],
    };
    const persisted: PiMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'review this' }, { type: 'image', data: 'persisted-base64', mimeType: 'image/jpeg' }],
    };
    const messages = appendPiMessage(appendPiMessage([], optimistic), persisted);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'review this' },
      { type: 'image', data: 'preview-base64', mimeType: 'image/jpeg', omitted: false },
    ]);
  });

  it('bounds retained live image previews', () => {
    let messages: PiMessage[] = [];
    for (let index = 0; index <= MAX_LIVE_IMAGE_PREVIEWS; index += 1) {
      messages = appendPiMessage(messages, {
        role: 'user',
        local: true,
        content: [{ type: 'text', text: String(index) }, { type: 'image', data: `image-${index}`, mimeType: 'image/jpeg' }],
      });
    }
    expect((messages[0].content as Array<{ data?: string }>)[1].data).toBe('');
    expect((messages.at(-1)?.content as Array<{ data?: string }>)[1].data).toBe(`image-${MAX_LIVE_IMAGE_PREVIEWS}`);
  });

  it('removes hydrated image payloads and bounds the in-memory projection', () => {
    const imageMessage: PiMessage = { role: 'user', content: [{ type: 'image', data: 'large-base64', mimeType: 'image/png' }] };
    const compacted = compactPiMessages([imageMessage]);
    expect(compacted[0].content).toEqual([{ type: 'image', data: '', mimeType: 'image/png', omitted: true }]);
    let messages: PiMessage[] = [];
    for (let index = 0; index <= MAX_STORED_PI_MESSAGES; index += 1) {
      messages = appendPiMessage(messages, { role: 'assistant', timestamp: index + 1, content: String(index) });
    }
    expect(messages).toHaveLength(MAX_STORED_PI_MESSAGES);
    expect(messages[0].content).toBe('1');
  });

  it('starts with the newest 50 messages without changing retained history', () => {
    const messages = Array.from({ length: 125 }, (_, timestamp) => ({ role: 'user', timestamp, content: String(timestamp) }));
    const visible = visiblePiMessages(messages);
    expect(INITIAL_RENDERED_PI_MESSAGES).toBe(50);
    expect(visible.hiddenCount).toBe(75);
    expect(visible.messages).toHaveLength(50);
    expect(visible.messages[0].content).toBe('75');
    expect(messages).toHaveLength(125);
  });

  it('reveals history in batches of 50 and includes a final partial batch', () => {
    const messages = Array.from({ length: 125 }, (_, timestamp) => ({ role: 'user', timestamp, content: String(timestamp) }));
    let limit = INITIAL_RENDERED_PI_MESSAGES;
    limit = nextPiMessageLimit(limit, messages.length);
    expect(visiblePiMessages(messages, limit)).toMatchObject({ hiddenCount: 25 });
    expect(visiblePiMessages(messages, limit).messages[0].content).toBe('25');
    limit = nextPiMessageLimit(limit, messages.length);
    expect(limit).toBe(125);
    expect(visiblePiMessages(messages, limit)).toEqual({ hiddenCount: 0, messages });
  });

  it('preserves the viewport offset by the height added above it', () => {
    expect(prependAnchoredScrollTop(2_000, 120, 3_250)).toBe(1_370);
    expect(prependAnchoredScrollTop(2_000, 120, 1_900)).toBe(120);
  });

  it('keeps settled message objects stable when appending ordinary messages', () => {
    const settled: PiMessage = { role: 'assistant', content: [{ type: 'text', text: 'settled' }], timestamp: 1 };
    const messages = appendPiMessage([settled], { role: 'assistant', content: 'new', timestamp: 2 });
    expect(messages[0]).toBe(settled);
  });
});
