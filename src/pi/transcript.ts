import type { PiContentBlock, PiMessage } from './types';

export const INITIAL_RENDERED_PI_MESSAGES = 50;
export const PI_MESSAGE_REVEAL_BATCH = 50;
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
  for (let messageIndex = bounded.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const sourceMessage = bounded[messageIndex];
    if (!Array.isArray(sourceMessage.content)) continue;
    let content: PiContentBlock[] | null = null;
    for (let blockIndex = sourceMessage.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = sourceMessage.content[blockIndex];
      if (block.type !== 'image' || typeof block.data !== 'string' || !block.data) continue;
      if (previewsRemaining > 0) {
        previewsRemaining -= 1;
        continue;
      }
      content ??= [...sourceMessage.content];
      content[blockIndex] = { ...block, data: '', omitted: true };
    }
    // Keep settled message identity stable unless image-preview compaction
    // actually changes that message.
    if (content) bounded[messageIndex] = { ...sourceMessage, content };
  }
  return bounded;
}

export function visiblePiMessages(messages: PiMessage[], limit = INITIAL_RENDERED_PI_MESSAGES) {
  const renderedCount = Math.min(messages.length, Math.max(0, limit));
  const hiddenCount = messages.length - renderedCount;
  return {
    hiddenCount,
    messages: hiddenCount ? (renderedCount ? messages.slice(-renderedCount) : []) : messages,
  };
}

export function nextPiMessageLimit(current: number, retainedCount: number) {
  return Math.min(retainedCount, current + PI_MESSAGE_REVEAL_BATCH);
}

export function prependAnchoredScrollTop(previousHeight: number, previousTop: number, nextHeight: number) {
  return previousTop + Math.max(0, nextHeight - previousHeight);
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
