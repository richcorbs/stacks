import type { PiMessage } from './types';

export const MAX_RENDERED_PI_MESSAGES = 300;
export const MAX_STORED_PI_MESSAGES = 1_000;
export const MAX_LIVE_IMAGE_PREVIEWS = 10;

export function hasVisiblePiStreamingText(text: string) {
  return Boolean(text.replace(/\u200b/g, '').trim());
}

export function compactPiMessage(message: PiMessage): PiMessage {
  const skillInvocation = message.role === 'user' ? collapsedSkillInvocation(message.content) : null;
  if (skillInvocation) return { ...message, content: skillInvocation };
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
  const message = rawMessage.local ? rawMessage : compactPiMessage(rawMessage);
  const last = messages[messages.length - 1];
  if (last && sameMessage(last, message)) return messages;
  if (last?.local && last.role === 'user' && message.role === 'user' && textContent(last) === textContent(message)) {
    return retainRecentImagePreviews([...messages.slice(0, -1), restoreImagePreviews(message, last)]);
  }
  return retainRecentImagePreviews([...messages, message]);
}

function restoreImagePreviews(message: PiMessage, localMessage: PiMessage): PiMessage {
  if (!Array.isArray(message.content) || !Array.isArray(localMessage.content)) return message;
  const previews = localMessage.content.filter((block) => block.type === 'image' && typeof block.data === 'string' && block.data);
  let previewIndex = 0;
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type !== 'image') return block;
      const preview = previews[previewIndex];
      previewIndex += 1;
      return preview ? { ...block, ...preview, omitted: false } : block;
    }),
  };
}

function retainRecentImagePreviews(messages: PiMessage[]) {
  const bounded = messages.slice(-MAX_STORED_PI_MESSAGES);
  let previewsRemaining = MAX_LIVE_IMAGE_PREVIEWS;
  return bounded.map((_, messageIndex) => {
    const reverseIndex = bounded.length - 1 - messageIndex;
    const sourceMessage = bounded[reverseIndex];
    if (!Array.isArray(sourceMessage.content)) return sourceMessage;
    const content = [...sourceMessage.content].reverse().map((block) => {
      if (block.type !== 'image' || typeof block.data !== 'string' || !block.data) return block;
      if (previewsRemaining > 0) {
        previewsRemaining -= 1;
        return block;
      }
      return { ...block, data: '', omitted: true };
    }).reverse();
    return { ...sourceMessage, content };
  }).reverse();
}

export function visiblePiMessages(messages: PiMessage[], limit = MAX_RENDERED_PI_MESSAGES) {
  const hiddenCount = Math.max(0, messages.length - limit);
  return {
    hiddenCount,
    messages: hiddenCount ? messages.slice(-limit) : messages,
  };
}

function collapsedSkillInvocation(content: PiMessage['content']) {
  const text = typeof content === 'string'
    ? content
    : content.length === 1 && content[0].type === 'text' && typeof content[0].text === 'string'
      ? content[0].text
      : null;
  if (!text) return null;
  const match = text.match(/^<skill name="([^"]+)"[^>]*>[\s\S]*<\/skill>(?:\s*([\s\S]*))?$/);
  if (!match) return null;
  const args = match[2]?.trim();
  return `/skill:${match[1]}${args ? ` ${args}` : ''}`;
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
