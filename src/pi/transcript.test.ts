import { describe, expect, it } from 'vitest';
import { appendPiMessage, compactPiMessages, MAX_LIVE_IMAGE_PREVIEWS, MAX_STORED_PI_MESSAGES, visiblePiMessages } from './transcript';
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

  it('retains recent transcript state while bounding the rendered window', () => {
    const messages = Array.from({ length: 5 }, (_, timestamp) => ({ role: 'user', timestamp, content: String(timestamp) }));
    const visible = visiblePiMessages(messages, 2);
    expect(visible.hiddenCount).toBe(3);
    expect(visible.messages.map((message) => message.content)).toEqual(['3', '4']);
    expect(messages).toHaveLength(5);
  });
});
