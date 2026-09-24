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

type PendingOptimisticSubmission = {
  contentKey: string;
  localTimestamp?: number;
  optimisticMessage: PiMessage;
  userOrdinal: number;
  liveSeen: boolean;
  hydratedSeen: boolean;
};

/** Reconciliation state is owned by one PiSessionController. */
export type PiTranscriptReconciliation = { pendingOptimisticSubmissions: PendingOptimisticSubmission[] };
export function createPiTranscriptReconciliation(): PiTranscriptReconciliation {
  return { pendingOptimisticSubmissions: [] };
}

export function appendPiMessage(messages: PiMessage[], rawMessage: PiMessage, reconciliation = createPiTranscriptReconciliation()): PiMessage[] {
  const message = rawMessage.local ? rawMessage : compactPiMessage(rawMessage);
  if (message.local && message.role === 'user') registerOptimisticSubmission(reconciliation, messages, message);

  if (!message.local && message.role === 'user') {
    const pending = reconciliation.pendingOptimisticSubmissions.find((submission) =>
      !submission.liveSeen && submission.contentKey === messageContentKey(message));
    if (pending) {
      pending.liveSeen = true;
      if (pending.hydratedSeen) {
        removeCompletedSubmissions(reconciliation);
        return messages;
      }
      const localIndex = messages.findIndex((current) => current === pending.optimisticMessage
        || (pending.localTimestamp !== undefined && current.local === true
          && current.role === 'user' && current.timestamp === pending.localTimestamp));
      if (localIndex >= 0) {
        const next = [...messages];
        next[localIndex] = restoreImagePreviews(message, pending.optimisticMessage);
        return retainRecentImagePreviews(next);
      }
    }
  }

  const existingIndex = messages.findIndex((current) => sameMessage(current, message));
  if (existingIndex >= 0) {
    if (!messages[existingIndex].local || message.local) return messages;
    const next = [...messages];
    next[existingIndex] = restoreImagePreviews(message, messages[existingIndex]);
    return retainRecentImagePreviews(next);
  }

  // Stateless callers still get the basic optimistic replacement behavior,
  // but controller-owned state above handles messages that are no longer last.
  const localIndex = messages.findIndex((current) => current.local === true && current.role === 'user'
    && message.role === 'user' && messageContentKey(current) === messageContentKey(message));
  if (localIndex >= 0) {
    const next = [...messages];
    next[localIndex] = restoreImagePreviews(message, messages[localIndex]);
    return retainRecentImagePreviews(next);
  }
  return retainRecentImagePreviews([...messages, message]);
}

export function discardOptimisticPiMessage(reconciliation: PiTranscriptReconciliation, timestamp: number) {
  reconciliation.pendingOptimisticSubmissions = reconciliation.pendingOptimisticSubmissions
    .filter((submission) => submission.localTimestamp !== timestamp);
}

/**
 * Reconciles authoritative hydration with projected events. Each optimistic
 * submission owns one user-turn ordinal, so hydration and live delivery can
 * replace it in either order without content-deduplicating later turns.
 */
export function reconcilePiMessages(hydrated: PiMessage[], projected: PiMessage[], reconciliation = createPiTranscriptReconciliation()): PiMessage[] {
  let messages = compactPiMessages(hydrated).map((message) => ({ ...message }));
  const hydratedCount = messages.length;
  const claimedHydrated = new Set<number>();
  const optimisticHydratedClaims: Array<{ contentKey: string }> = [];

  for (const submission of reconciliation.pendingOptimisticSubmissions) {
    const match = userMessageAtOrdinal(messages, submission.userOrdinal);
    if (match && messageContentKey(match.message) === submission.contentKey) {
      submission.hydratedSeen = true;
      messages[match.index] = restoreImagePreviews(match.message, submission.optimisticMessage);
    }
  }

  let projectedUserOrdinal = 0;
  for (const rawCurrent of projected) {
    const current = rawCurrent.local ? rawCurrent : compactPiMessage(rawCurrent);
    const currentUserOrdinal = current.role === 'user' ? projectedUserOrdinal++ : -1;
    const pending = current.role === 'user'
      ? reconciliation.pendingOptimisticSubmissions.find((submission) =>
        submission.userOrdinal === currentUserOrdinal && submission.contentKey === messageContentKey(current))
      : undefined;
    if (pending?.hydratedSeen) {
      const hydratedMatch = userMessageAtOrdinal(messages, pending.userOrdinal);
      if (hydratedMatch) claimedHydrated.add(hydratedMatch.index);
      continue;
    }
    if (!current.local && current.role === 'user') {
      const optimisticClaim = optimisticHydratedClaims.findIndex((claim) => claim.contentKey === messageContentKey(current));
      if (optimisticClaim >= 0) {
        optimisticHydratedClaims.splice(optimisticClaim, 1);
        continue;
      }
    }

    let match = messages.findIndex((candidate, index) => index < hydratedCount
      && !claimedHydrated.has(index) && sameMessage(candidate, current));
    if (match < 0) {
      match = messages.findIndex((candidate, index) => index < hydratedCount
        && !claimedHydrated.has(index) && fallbackMessageMatch(candidate, current, current.local === true));
    }
    if (match >= 0) {
      claimedHydrated.add(match);
      if (current.local) {
        messages[match] = restoreImagePreviews(messages[match], current);
        optimisticHydratedClaims.push({ contentKey: messageContentKey(current) });
      }
      continue;
    }
    messages = appendPiMessage(messages, current, reconciliation);
  }
  removeCompletedSubmissions(reconciliation);
  return retainRecentImagePreviews(messages);
}

function registerOptimisticSubmission(reconciliation: PiTranscriptReconciliation, messages: PiMessage[], message: PiMessage) {
  if (reconciliation.pendingOptimisticSubmissions.some((submission) =>
    submission.localTimestamp === message.timestamp && submission.optimisticMessage === message)) return;
  reconciliation.pendingOptimisticSubmissions.push({
    contentKey: messageContentKey(message),
    localTimestamp: message.timestamp,
    optimisticMessage: message,
    userOrdinal: messages.filter((current) => current.role === 'user').length,
    liveSeen: false,
    hydratedSeen: false,
  });
}

function removeCompletedSubmissions(reconciliation: PiTranscriptReconciliation) {
  reconciliation.pendingOptimisticSubmissions = reconciliation.pendingOptimisticSubmissions
    .filter((submission) => !(submission.liveSeen && submission.hydratedSeen));
}

function userMessageAtOrdinal(messages: PiMessage[], ordinal: number) {
  let currentOrdinal = 0;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role !== 'user') continue;
    if (currentOrdinal === ordinal) return { index, message: messages[index] };
    currentOrdinal += 1;
  }
  return null;
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

function messageContentKey(message: PiMessage) {
  if (typeof message.content === 'string') return `text:${message.content}`;
  if (message.content.every((block) => block.type === 'text' && 'text' in block && typeof block.text === 'string')) {
    return `text:${message.content.map((block) => 'text' in block ? String(block.text) : '').join('\n')}`;
  }
  return JSON.stringify(message.content.map((block) => {
    if (block.type === 'image') return { type: 'image', mimeType: block.mimeType, name: block.name };
    return block;
  }));
}

function fallbackMessageMatch(left: PiMessage, right: PiMessage, allowOptimisticTimestamp = false) {
  if (left.role !== right.role || messageContentKey(left) !== messageContentKey(right)) return false;
  if (allowOptimisticTimestamp) return true;
  return !hasConflictingIdentity(left, right);
}

function hasConflictingIdentity(left: PiMessage, right: PiMessage) {
  for (const key of ['id', 'messageId', 'timestamp', 'toolCallId'] as const) {
    const leftValue = left[key];
    const rightValue = right[key];
    if (leftValue !== undefined && leftValue !== null && leftValue !== ''
      && rightValue !== undefined && rightValue !== null && rightValue !== ''
      && leftValue !== rightValue) return true;
  }
  return false;
}

function sameMessage(left: PiMessage, right: PiMessage) {
  if (left.role !== right.role) return false;
  if (typeof left.id === 'string' && left.id && typeof right.id === 'string' && right.id) return left.id === right.id;
  if (typeof left.messageId === 'string' && left.messageId && typeof right.messageId === 'string' && right.messageId) return left.messageId === right.messageId;
  if (left.timestamp !== undefined && left.timestamp !== null && right.timestamp !== undefined && right.timestamp !== null) return left.timestamp === right.timestamp;
  if (left.toolCallId && right.toolCallId) return left.toolCallId === right.toolCallId;
  return false;
}
