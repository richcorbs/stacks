import { describe, expect, it } from 'vitest';
import { githubStatusPresentation } from './status';

describe('githubStatusPresentation', () => {
  it('maps API states to stable icon presentations', () => {
    expect(githubStatusPresentation('pending').kind).toBe('running');
    expect(githubStatusPresentation('success').kind).toBe('passed');
    expect(githubStatusPresentation('failure').kind).toBe('failed');
    expect(githubStatusPresentation('skipped').kind).toBe('skipped');
    expect(githubStatusPresentation('no_ci')).toEqual({ kind: 'text', label: 'No CI' });
  });
});
