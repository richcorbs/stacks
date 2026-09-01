import { describe, expect, it } from 'vitest';
import { appendPiMessage, compactPiMessages, MAX_STORED_PI_MESSAGES, visiblePiMessages } from './transcript';
import type { PiMessage } from './types';

describe('Pi transcript', () => {
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

  it('retains recent transcript state while bounding the rendered window', () => {
    const messages = Array.from({ length: 5 }, (_, timestamp) => ({ role: 'user', timestamp, content: String(timestamp) }));
    const visible = visiblePiMessages(messages, 2);
    expect(visible.hiddenCount).toBe(3);
    expect(visible.messages.map((message) => message.content)).toEqual(['3', '4']);
    expect(messages).toHaveLength(5);
  });
});
