import { describe, expect, it } from 'vitest';
import { activePathToken, applyPathCompletion, formatDroppedPathReference, formatPathReference, insertPathReferences, quotePiPath } from './pathReferences';

describe('Pi path references', () => {
  it('finds only the active unquoted token at the cursor', () => {
    expect(activePathToken('read @src/uti then', 12)).toEqual({ start: 5, end: 13, query: 'src/uti', quoted: false });
    expect(activePathToken('read @src/uti then', 18)).toBeNull();
    expect(activePathToken('@one\n@two', 9)?.query).toBe('two');
  });

  it('finds quoted tokens containing spaces and unescapes their query', () => {
    expect(activePathToken('see @"docs/my file.md" now', 16)).toEqual({ start: 4, end: 22, query: 'docs/my file.md', quoted: true });
    expect(activePathToken('@"a\\"b"', 5)?.query).toBe('a"b');
  });

  it('replaces only the active token and preserves multiline surroundings', () => {
    const token = activePathToken('before\nopen @src/ut please\nafter', 19)!;
    expect(applyPathCompletion('before\nopen @src/ut please\nafter', token, 'src/utils.ts', false)).toEqual({
      value: 'before\nopen @src/utils.ts please\nafter', cursor: 25,
    });
  });

  it('continues directory navigation, including inside quotes', () => {
    const result = applyPathCompletion('open @doc', activePathToken('open @doc', 9)!, 'docs/my files', true);
    expect(result.value).toBe('open @"docs/my files/"');
    expect(result.cursor).toBe(result.value.length - 1);
  });

  it('quotes Pi paths only when needed', () => {
    expect(quotePiPath('src/a.ts')).toBe('src/a.ts');
    expect(formatPathReference('docs/my file.md')).toBe('@"docs/my file.md"');
    expect(formatPathReference('a"b.md')).toBe('@"a\\"b.md"');
  });

  it('uses relative references inside cwd and absolute references outside', () => {
    expect(formatDroppedPathReference('/repo/src/a.ts', '/repo')).toBe('@src/a.ts');
    expect(formatDroppedPathReference('/repo two/a.md', '/repo two')).toBe('@a.md');
    expect(formatDroppedPathReference('/other/my file.md', '/repo')).toBe('@"/other/my file.md"');
    expect(formatDroppedPathReference('/repository/a', '/repo')).toBe('@/repository/a');
  });

  it('inserts multiple references at a cursor or over a selection', () => {
    expect(insertPathReferences('lookhere', 4, 4, ['@a', '@"b b"'])).toEqual({ value: 'look @a @"b b" here', cursor: 15 });
    expect(insertPathReferences('before OLD after', 7, 10, ['@one', '@two'])).toEqual({ value: 'before @one @two after', cursor: 16 });
    expect(insertPathReferences('', 0, 0, ['@image.png'])).toEqual({ value: '@image.png ', cursor: 11 });
  });
});
