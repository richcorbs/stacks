import { describe, expect, it } from 'vitest';
import { normalizeClipboardText } from './clipboard';

describe('normalizeClipboardText', () => {
  it.each([
    ['CRLF', 'first\r\nsecond', 'first\nsecond'],
    ['lone CR', 'first\rsecond', 'first\nsecond'],
    ['LF', 'first\nsecond', 'first\nsecond'],
    ['mixed endings', 'a\r\nb\rc\nd', 'a\nb\nc\nd'],
    ['preserves whitespace and final newline', ' a  \r\n\r\n', ' a  \n\n'],
  ])('normalizes %s', (_name, input, expected) => {
    expect(normalizeClipboardText(input)).toBe(expected);
  });
});
