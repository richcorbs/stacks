import type { PiMessage } from './types';

export const MAX_RENDERED_PI_MESSAGES = 300;
export const MAX_STORED_PI_MESSAGES = 1_000;

export function compactPiMessage(message: PiMessage): PiMessage {
  if (!Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map((block) => block.type === 'image' && typeof block.data === 'string'
      ? { ...block, data: '', omitted: true }
      : block),
  };
}

export function compactPiMessages(messages: PiMessage[]): PiMessage[] {
  return messages.slice(-MAX_STORED_PI_MESSAGES).map(compactPiMessage);
}

export function appendPiMessage(messages: PiMessage[], rawMessage: PiMessage): PiMessage[] {
  const message = compactPiMessage(rawMessage);
  const last = messages[messages.length - 1];
  if (last && sameMessage(last, message)) return messages;
  if (last?.local && last.role === 'user' && message.role === 'user' && textContent(last) === textContent(message)) {
    return [...messages.slice(0, -1), message];
  }
  return [...messages, message].slice(-MAX_STORED_PI_MESSAGES);
}

export function visiblePiMessages(messages: PiMessage[], limit = MAX_RENDERED_PI_MESSAGES) {
  const hiddenCount = Math.max(0, messages.length - limit);
  return {
    hiddenCount,
    messages: hiddenCount ? messages.slice(-limit) : messages,
  };
}

function textContent(message: PiMessage) {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((block) => block.type === 'text' && typeof block.text === 'string' ? block.text : '').filter(Boolean).join('\n');
}

function sameMessage(left: PiMessage, right: PiMessage) {
  if (left.role !== right.role) return false;
  if (left.timestamp && right.timestamp) return left.timestamp === right.timestamp;
  if (left.toolCallId && right.toolCallId) return left.toolCallId === right.toolCallId;
  return false;
}
