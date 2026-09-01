import { describe, expect, it } from 'vitest';
import { numberDiffLines } from './diffLines';

describe('diff line numbers', () => {
  it('tracks old and new line numbers through a hunk', () => {
    expect(numberDiffLines([
      '@@ -10,3 +10,4 @@',
      ' context',
      '-removed',
      '+added',
      '+another',
      ' final',
    ].join('\n'))).toEqual([
      { text: '@@ -10,3 +10,4 @@', oldLine: null, newLine: null },
      { text: ' context', oldLine: 10, newLine: 10 },
      { text: '-removed', oldLine: 11, newLine: null },
      { text: '+added', oldLine: null, newLine: 11 },
      { text: '+another', oldLine: null, newLine: 12 },
      { text: ' final', oldLine: 12, newLine: 13 },
    ]);
  });

  it('does not number metadata or missing-newline markers', () => {
    expect(numberDiffLines('--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file')).toEqual([
      { text: '--- a/file', oldLine: null, newLine: null },
      { text: '+++ b/file', oldLine: null, newLine: null },
      { text: '@@ -1 +1 @@', oldLine: null, newLine: null },
      { text: '-old', oldLine: 1, newLine: null },
      { text: '+new', oldLine: null, newLine: 1 },
      { text: '\\ No newline at end of file', oldLine: null, newLine: null },
    ]);
  });
});
