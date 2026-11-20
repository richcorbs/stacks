import { describe, expect, it } from 'vitest';
import { calculatePiContextTokens, derivePiContextUsage, lastAssistantUsage } from './contextUsage';
import type { PiMessage, PiMessageUsage, PiModel } from './types';

const usage = (overrides: Partial<PiMessageUsage> = {}): PiMessageUsage => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { total: 0 }, ...overrides,
});

const model: PiModel = { provider: 'deepseek', id: 'deepseek-v4.1-flash', name: 'DeepSeek Flash', contextWindow: 1_048_576 };

describe('Pi context usage derivation', () => {
  it('uses the last assistant usage instead of Pi reporting a numeric zero', () => {
    const messages: PiMessage[] = [
      { role: 'user', content: 'work' },
      { role: 'assistant', content: 'first', usage: usage({ input: 10, cacheRead: 20 }) },
      { role: 'assistant', content: 'working', usage: usage({ input: 269, cacheRead: 130_176, output: 40 }) },
    ];

    const result = derivePiContextUsage(
      messages,
      { tokens: 0, contextWindow: 1_000_000 },
      [model],
      { provider: 'deepseek', modelId: 'deepseek-v4.1-flash' },
    );

    expect(result).toEqual({
      contextTokens: 130_445,
      contextWindow: 1_048_576,
      contextPercent: (130_445 / 1_048_576) * 100,
    });
  });

  it('prefers the newest assistant message that carries usage', () => {
    const messages: PiMessage[] = [
      { role: 'assistant', content: 'old', usage: usage({ input: 1, cacheRead: 2 }) },
      { role: 'user', content: 'next' },
      { role: 'assistant', content: 'still streaming' },
    ];
    expect(lastAssistantUsage(messages)).toEqual(usage({ input: 1, cacheRead: 2 }));
    expect(calculatePiContextTokens(lastAssistantUsage(messages)!)).toBe(3);
  });

  it('falls back to the RPC stat only until an assistant message carries usage', () => {
    const result = derivePiContextUsage(
      [{ role: 'user', content: 'work' }],
      { tokens: 1_234, contextWindow: 9_999, percent: 99 },
      [model],
      { provider: 'deepseek', modelId: 'deepseek-v4.1-flash' },
    );

    expect(result.contextTokens).toBe(1_234);
    expect(result.contextWindow).toBe(1_048_576);
    expect(result.contextPercent).toBe((1_234 / 1_048_576) * 100);
  });

  it('returns unknown when neither local usage nor the RPC stat exists', () => {
    expect(derivePiContextUsage(
      [{ role: 'user', content: 'work' }],
      { tokens: null, contextWindow: null },
      [],
      { provider: 'missing', modelId: 'missing' },
    )).toEqual({ contextTokens: null, contextWindow: null, contextPercent: null });
  });

  it('uses the reported window only when the catalogue has no matching model', () => {
    expect(derivePiContextUsage(
      [{ role: 'user', content: 'work' }],
      { tokens: 1_000, contextWindow: 200_000 },
      [model],
      { provider: 'other', modelId: 'other-model' },
    ).contextWindow).toBe(200_000);
  });

  it('renders unknown rather than zero when a transcript with assistant output has a zero usage sum', () => {
    expect(derivePiContextUsage(
      [{ role: 'assistant', content: 'working', usage: usage() }],
      { tokens: 500, contextWindow: 1_000_000 },
      [model],
      { provider: 'deepseek', modelId: 'deepseek-v4.1-flash' },
    )).toEqual({
      contextTokens: null,
      contextWindow: 1_048_576,
      contextPercent: null,
    });
  });

  it('keeps a genuine zero before the first assistant message', () => {
    expect(derivePiContextUsage(
      [{ role: 'user', content: 'work' }],
      { tokens: 0, contextWindow: 1_048_576 },
      [model],
      { provider: 'deepseek', modelId: 'deepseek-v4.1-flash' },
    ).contextTokens).toBe(0);
  });
});
