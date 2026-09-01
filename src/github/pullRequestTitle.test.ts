import { describe, expect, it } from 'vitest';
import { pullRequestTitleParts } from './pullRequestTitle';

describe('pullRequestTitleParts', () => {
  it('preserves a trailing Superthread card reference as the suffix', () => {
    expect(pullRequestTitleParts('Add a very long checkout workflow ST-1234')).toEqual({
      prefix: 'Add a very long checkout workflow',
      suffix: 'ST-1234',
    });
  });

  it('keeps trailing punctuation with the card reference', () => {
    expect(pullRequestTitleParts('Fix checkout (ST-42)')).toEqual({
      prefix: 'Fix checkout',
      suffix: '(ST-42)',
    });
  });

  it('uses normal end truncation when there is no card reference', () => {
    expect(pullRequestTitleParts('Fix checkout')).toEqual({ prefix: 'Fix checkout', suffix: null });
  });
});
