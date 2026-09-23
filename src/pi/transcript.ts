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
  const existingIndex = messages.findIndex((current) => sameMessage(current, message));
  if (existingIndex >= 0) {
    if (!messages[existingIndex].local || message.local) return messages;
    const next = [...messages];
    next[existingIndex] = restoreImagePreviews(message, messages[existingIndex]);
    return retainRecentImagePreviews(next);
  }
  const last = messages[messages.length - 1];
  if (last?.local && last.role === 'user' && message.role === 'user' && textContent(last) === textContent(message)) {
    return retainRecentImagePreviews([...messages.slice(0, -1), restoreImagePreviews(message, last)]);
  }
  return retainRecentImagePreviews([...messages, message]);
}

/**
 * Reconciles an authoritative hydration with messages already projected from
 * optimistic UI and live events. Occurrence matching is one-to-one so two
 * intentional, identical turns remain two messages.
 */
export function reconcilePiMessages(hydrated: PiMessage[], projected: PiMessage[]): PiMessage[] {
  let messages = compactPiMessages(hydrated);
  const hydratedCount = messages.length;
  const claimedHydrated = new Set<number>();
  for (const rawCurrent of projected) {
    const current = rawCurrent.local ? rawCurrent : compactPiMessage(rawCurrent);
    let match = messages.findIndex((candidate, index) => index < hydratedCount && sameMessage(candidate, current));
    if (match < 0) {
      match = messages.findIndex((candidate, index) => index < hydratedCount && !claimedHydrated.has(index)
        && candidate.role === current.role
        && textContent(candidate) === textContent(current));
    }
    if (match >= 0) {
      claimedHydrated.add(match);
      if (current.local) messages[match] = restoreImagePreviews(messages[match], current);
      continue;
    }
    messages = appendPiMessage(messages, current);
  }
  return compactPiMessages(messages);
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
  if (typeof left.id === 'string' && left.id && typeof right.id === 'string' && right.id) return left.id === right.id;
  if (typeof left.messageId === 'string' && left.messageId && typeof right.messageId === 'string' && right.messageId) return left.messageId === right.messageId;
  if (left.timestamp !== undefined && left.timestamp !== null && right.timestamp !== undefined && right.timestamp !== null) return left.timestamp === right.timestamp;
  if (left.toolCallId && right.toolCallId) return left.toolCallId === right.toolCallId;
  return false;
}
