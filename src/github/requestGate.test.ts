import { describe, expect, it } from 'vitest';
import { GithubRequestGate, githubPollMilliseconds } from './requestGate';

describe('GithubRequestGate', () => {
  it('rejects overlapping requests for the same path', () => {
    const gate = new GithubRequestGate();
    expect(gate.begin('/repo')).toBe(1);
    expect(gate.begin('/repo')).toBeNull();
    gate.finish('/repo');
    expect(gate.begin('/repo')).toBe(2);
  });

  it('invalidates responses when another repository starts loading', () => {
    const gate = new GithubRequestGate();
    const first = gate.begin('/repo-a')!;
    const second = gate.begin('/repo-b')!;
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it('clamps polling to ten seconds', () => {
    expect(githubPollMilliseconds(1)).toBe(10_000);
    expect(githubPollMilliseconds(60)).toBe(60_000);
  });
});
