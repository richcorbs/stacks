import { describe, expect, it } from 'vitest';
import { composeDiffReviewPrompt, hasDiffReviewFeedback } from './prompt';

describe('diff review prompt', () => {
  const comments = [
    { id: '1', filePath: 'src/app.ts', side: 'file' as const, line: null, body: 'Split this file.' },
    { id: '2', filePath: 'src/app.ts', side: 'new' as const, line: 42, body: 'Handle the error.' },
    { id: '3', filePath: 'src/old.ts', side: 'old' as const, line: 7, body: 'Keep this behavior.' },
  ];

  it('formats overall, file, and line feedback for Pi', () => {
    expect(composeDiffReviewPrompt('Please preserve compatibility.', comments)).toBe([
      'Please address the following feedback',
      '',
      'Please preserve compatibility.',
      '',
      '1. [git diff] src/app.ts',
      '   Split this file.',
      '',
      '2. [git diff] src/app.ts:42 (new)',
      '   Handle the error.',
      '',
      '3. [git diff] src/old.ts:7 (old)',
      '   Keep this behavior.',
    ].join('\n'));
  });

  it('requires at least one non-empty piece of feedback', () => {
    expect(hasDiffReviewFeedback(' ', [{ ...comments[0], body: '' }])).toBe(false);
    expect(hasDiffReviewFeedback('', comments)).toBe(true);
  });
});
