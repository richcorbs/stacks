import { describe, expect, it } from 'vitest';
import { localCardProvider } from './providers';
import type { CardProviderAdapter } from './types';

function acceptsProviderContract(provider: CardProviderAdapter) {
  return provider;
}

describe('card provider contract', () => {
  it('represents local cards through the same adapter contract as remote cards', async () => {
    const provider = acceptsProviderContract(localCardProvider);
    expect(provider.kind).toBe('local');
    await expect(provider.sync()).resolves.toEqual({ cards: [], warnings: [] });
  });
});
