import { describe, expect, it } from 'vitest';
import { runGitBatch } from './gitRefreshBatch';

const clean = { branch: 'main', status: 'ok' as const, created: 0, changed: 0, deleted: 0 };

describe('Git refresh batch', () => {
  it('bounds concurrency, retains input order and never turns errors into clean counts', async () => {
    let running = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const batch = runGitBatch([0, 1, 2, 3, 4], async (index) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running--;
      if (index === 1) throw new Error('private path');
      return clean;
    }, 2);
    for (let i = 0; i < 5; i++) {
      while (!release.length) await new Promise((resolve) => setTimeout(resolve, 0));
      release.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const results = await batch;
    expect(peak).toBe(2);
    expect(results[1]).toMatchObject({ status: 'error' });
    expect(JSON.stringify(results)).not.toContain('private path');
    expect(results[0]).toEqual(clean);
    expect(results[4]).toEqual(clean);
  });
});
