import { describe, expect, it } from 'vitest';
import { piDiffLineKind, piEditDiff, piToolSummary } from './toolPresentation';

describe('Pi tool presentation', () => {
  it('describes edit calls by filename', () => {
    expect(piToolSummary('edit', { path: 'src/components/App.tsx' }, true)).toEqual({
      label: 'editing App.tsx',
      title: 'editing src/components/App.tsx',
    });
  });

  it('describes read calls by filename', () => {
    expect(piToolSummary('read', { path: 'src/components/PiGuiView.tsx' }, false)).toEqual({
      label: 'read PiGuiView.tsx',
      title: 'read src/components/PiGuiView.tsx',
    });
    expect(piToolSummary('read', { file_path: '/tmp/output.log' }, true).label).toBe('reading output.log');
  });

  it('describes running bash calls by command', () => {
    expect(piToolSummary('bash', { command: 'npm run test\necho done' }, true).label).toBe('running: npm run test');
  });

  it('builds an edit diff from replacement arguments when result details are unavailable', () => {
    expect(piEditDiff(null, { edits: [{ oldText: 'old', newText: 'new' }] })).toBe('-old\n+new');
    expect(piDiffLineKind('-old')).toBe('removed');
    expect(piDiffLineKind('+new')).toBe('added');
    expect(piDiffLineKind(' context')).toBe('context');
  });
});
