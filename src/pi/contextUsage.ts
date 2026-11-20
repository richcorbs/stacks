import type { PiMessage, PiMessageUsage, PiModel, PiSessionContext } from './types';

export type ReportedPiContextUsage = {
  tokens?: number | null;
  contextWindow?: number | null;
  percent?: number | null;
};

export type PiContextIdentity = {
  provider?: string;
  modelId?: string;
};

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Pi's own context accounting uses the prompt-side usage counters. Derive the
 * same value from the last assistant message instead of trusting Pi's projected
 * estimate, which can report a numeric zero for a live session.
 */
export function calculatePiContextTokens(usage: PiMessageUsage | undefined): number | null {
  if (!usage) return null;
  const tokenCount = (value: unknown) => finiteNumber(value) ?? 0;
  return tokenCount(usage.input) + tokenCount(usage.cacheRead) + tokenCount(usage.cacheWrite);
}

/** The newest assistant usage in the retained transcript, if any. */
export function lastAssistantUsage(messages: PiMessage[]): PiMessageUsage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.usage && typeof message.usage === 'object') return message.usage;
  }
  return null;
}

/**
 * Resolve the three displayed context values from data Stacks already has.
 *
 * Precedence is: the last assistant usage in the transcript, then Pi's RPC
 * stat only while no assistant usage exists, then unknown. The window comes
 * from the model catalogue so it cannot race the separate model/stat requests.
 */
export function derivePiContextUsage(
  messages: PiMessage[],
  reported: ReportedPiContextUsage,
  availableModels: PiModel[],
  identity: PiContextIdentity,
): Pick<PiSessionContext, 'contextTokens' | 'contextWindow' | 'contextPercent'> {
  const usage = lastAssistantUsage(messages);
  const hasAssistantMessages = messages.some((message) => message.role === 'assistant');
  let contextTokens = usage ? calculatePiContextTokens(usage) : finiteNumber(reported.tokens);
  // A zero estimate alongside assistant output is the unreliable Pi stat, not
  // an empty conversation. Render unknown rather than a false "0 / window".
  if (contextTokens === 0 && hasAssistantMessages) contextTokens = null;

  const catalogueWindow = availableModels.find((model) =>
    model.provider === identity.provider && model.id === identity.modelId)?.contextWindow;
  const reportedWindow = finiteNumber(reported.contextWindow);
  const matchedWindow = finiteNumber(catalogueWindow);
  const contextWindow = matchedWindow !== null && matchedWindow > 0 ? matchedWindow : reportedWindow;

  const contextPercent = contextTokens !== null && contextWindow !== null && contextWindow > 0
    ? (contextTokens / contextWindow) * 100
    : null;

  return { contextTokens, contextWindow, contextPercent };
}
