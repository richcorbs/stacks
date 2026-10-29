import { describe, expect, it } from 'vitest';
import { buildDiffTree, visibleDiffRows, reconcileDiffHighlight, navigateDiffRows } from './diffTree';

describe('diff file tree', () => {
  const tree = buildDiffTree([
    { path: 'z.ts', status: 'M' }, { path: 'src/b.ts', status: 'M' },
    { path: 'src/nested/a.ts', status: 'A' }, { path: 'src/a.ts', status: 'M' },
  ]);

  it('flattens visible rows in rendered folders-first order, skipping collapsed descendants', () => {
    expect(visibleDiffRows(tree, new Set()).map(({ node }) => node.path)).toEqual(['src', 'src/nested', 'src/nested/a.ts', 'src/a.ts', 'src/b.ts', 'z.ts']);
    expect(visibleDiffRows(tree, new Set(['src/nested'])).map(({ node }) => node.path)).toEqual(['src', 'src/nested', 'src/a.ts', 'src/b.ts', 'z.ts']);
    expect(visibleDiffRows(tree, new Set(['src'])).map(({ node }) => node.path)).toEqual(['src', 'z.ts']);
  });

  it('navigates without wrapping and resolves parent and first visible child', () => {
    const rows = visibleDiffRows(tree, new Set());
    expect(navigateDiffRows(rows, 'src', 'k')).toBe('src');
    expect(navigateDiffRows(rows, 'z.ts', 'j')).toBe('z.ts');
    expect(navigateDiffRows(rows, 'src', 'j')).toBe('src/nested');
    expect(navigateDiffRows(rows, 'src/a.ts', 'k')).toBe('src/nested/a.ts');
    expect(navigateDiffRows(rows, 'src/nested/a.ts', 'h')).toBe('src/nested');
    expect(navigateDiffRows(rows, 'src', 'h')).toBe('src');
    expect(navigateDiffRows(rows, 'src', 'l')).toBe('src/nested');
    expect(navigateDiffRows(rows, 'src/a.ts', 'l')).toBe('src/a.ts');
    expect(navigateDiffRows(visibleDiffRows(tree, new Set(['src'])), 'src', 'l')).toBe('src');
    expect(navigateDiffRows([], null, 'j')).toBeNull();
  });

  it('retains valid positions, reconciles to visible ancestors, and falls back for missing or empty rows', () => {
    const rows = visibleDiffRows(tree, new Set(['src']));
    expect(reconcileDiffHighlight(rows, 'z.ts')).toBe('z.ts');
    expect(reconcileDiffHighlight(rows, 'src/nested/a.ts')).toBe('src');
    expect(reconcileDiffHighlight(rows, 'removed.ts')).toBe('src');
    expect(reconcileDiffHighlight(rows, null)).toBe('src');
    expect(reconcileDiffHighlight([], 'src')).toBeNull();
  });
  it('groups changed files into sorted folders', () => {
    expect(buildDiffTree([
      { path: 'src/z.ts', status: 'M' },
      { path: 'README.md', status: 'A' },
      { path: 'src/components/App.tsx', status: 'D' },
    ])).toEqual([
      {
        type: 'folder', name: 'src', path: 'src', children: [
          {
            type: 'folder', name: 'components', path: 'src/components', children: [
              { type: 'file', name: 'App.tsx', path: 'src/components/App.tsx', status: 'D' },
            ],
          },
          { type: 'file', name: 'z.ts', path: 'src/z.ts', status: 'M' },
        ],
      },
      { type: 'file', name: 'README.md', path: 'README.md', status: 'A' },
    ]);
  });
});
