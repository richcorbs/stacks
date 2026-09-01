import { describe, expect, it } from 'vitest';
import { buildDiffTree } from './diffTree';

describe('diff file tree', () => {
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
