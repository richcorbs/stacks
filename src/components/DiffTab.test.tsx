import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import type { DiffReviewModel } from '../diffReview/types';
import { DiffTab } from './DiffTab';

const review: DiffReviewModel = {
  openDiff: null,
  overallComment: '',
  comments: [],
  reviewedFiles: new Set(),
  setOpenDiff: vi.fn(),
  setOverallComment: vi.fn(),
  addComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
  toggleReviewed: vi.fn(),
  reset: vi.fn(),
};

describe('DiffTab', () => {
  it('uses a generic branch source label rather than PR discovery', () => {
    const markup = renderToStaticMarkup(<DiffTab activePath="/repo" comparisonTarget="refs/heads/main" refreshNonce={0} review={review} />);
    expect(markup).toContain('Branch changes');
    expect(markup).not.toContain('PR #');
    expect(markup).not.toContain('Working tree');
  });

  it('selects the opened file without losing reviewed marks when switching files', async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'git_diff_files') return { files: [{ path: 'src/a.ts', status: 'M' }, { path: 'src/b.ts', status: 'A' }] };
      if (command === 'git_file_diff') return { path: (args as { file: string }).file, patch: '' };
      return null;
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    let currentReview = { ...review, reviewedFiles: new Set(['src/a.ts']), setOpenDiff: vi.fn() };
    await act(async () => { renderer = TestRenderer.create(<DiffTab activePath="/repo" comparisonTarget="main" refreshNonce={0} review={currentReview} />); });
    const rows = () => renderer.root.findAllByProps({ role: 'treeitem' }).filter((row) => row.props.className?.includes('diffFileRow'));
    const openButtons = () => renderer.root.findAllByProps({ className: 'diffFileOpen' });
    expect(rows().map((row) => row.props['aria-selected'])).toEqual([false, false]);
    await act(async () => { openButtons()[0].props.onClick(); });
    expect(currentReview.setOpenDiff).toHaveBeenCalledWith({ path: 'src/a.ts', patch: '' });
    currentReview = { ...currentReview, openDiff: { path: 'src/a.ts', patch: '' } };
    act(() => renderer.update(<DiffTab activePath="/repo" comparisonTarget="main" refreshNonce={0} review={currentReview} />));
    expect(rows()[0].props.className).toContain('selected reviewed');
    expect(rows()[0].props['aria-selected']).toBe(true);
    await act(async () => { openButtons()[1].props.onClick(); });
    currentReview = { ...currentReview, openDiff: { path: 'src/b.ts', patch: '' } };
    act(() => renderer.update(<DiffTab activePath="/repo" comparisonTarget="main" refreshNonce={0} review={currentReview} />));
    expect(rows()[0].props.className).toContain('reviewed');
    expect(rows()[0].props.className).not.toContain('selected');
    expect(rows()[1].props.className).toContain('selected');
    expect(rows()[1].props['aria-selected']).toBe(true);
    act(() => renderer.unmount());
  });

  it('toggles review from a separate keyboard-operable dot without opening or selecting a file', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'git_diff_files') return { files: [{ path: 'src/a.ts', status: 'M' }, { path: 'src/b.ts', status: 'A' }] };
      return null;
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    let currentReview = { ...review, reviewedFiles: new Set<string>(), toggleReviewed: vi.fn(), setOpenDiff: vi.fn() };
    await act(async () => { renderer = TestRenderer.create(<DiffTab activePath="/repo" comparisonTarget="main" refreshNonce={0} review={currentReview} />); });
    const rows = () => renderer.root.findAllByProps({ role: 'treeitem' }).filter((row) => row.props.className?.includes('diffFileRow'));
    const dots = () => renderer.root.findAllByProps({ className: 'diffReviewDot' });
    vi.mocked(invoke).mockClear();
    expect(rows()).toHaveLength(2);
    expect(rows()[0].props['aria-selected']).toBe(false);
    expect(dots()[0].props['aria-label']).toBe('Mark reviewed: src/a.ts');
    expect(dots()[0].props['aria-pressed']).toBe(false);
    expect(dots()[0].props.type).toBe('button');
    expect(rows()[0].findAllByType('button')).toHaveLength(2);
    expect(rows()[0].findByProps({ className: 'diffFileOpen' }).children.every((child) => typeof child === 'string' || child.type !== 'button')).toBe(true);
    act(() => dots()[0].props.onClick());
    expect(currentReview.toggleReviewed).toHaveBeenCalledWith('src/a.ts');
    expect(currentReview.setOpenDiff).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('git_file_diff', expect.anything());
    expect(rows()[0].props['aria-selected']).toBe(false);
    currentReview = { ...currentReview, reviewedFiles: new Set(['src/a.ts']) };
    act(() => renderer.update(<DiffTab activePath="/repo" comparisonTarget="main" refreshNonce={0} review={currentReview} />));
    expect(rows()[0].props.className).toContain('reviewed');
    expect(dots()[0].props['aria-label']).toBe('Mark unreviewed: src/a.ts');
    expect(dots()[0].props['aria-pressed']).toBe(true);
    expect(dots()[1].props['aria-pressed']).toBe(false);
    act(() => dots()[0].props.onClick());
    expect(currentReview.toggleReviewed).toHaveBeenCalledTimes(2);
    expect(currentReview.setOpenDiff).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('shows an actionable error when comparison metadata is missing', () => {
    const markup = renderToStaticMarkup(<DiffTab activePath="/repo" comparisonTarget={null} refreshNonce={0} review={review} />);
    expect(markup).toContain('comparison target is missing');
    expect(markup).toContain('repair the card environment');
    expect(markup).not.toContain('aria-label="Changed files"');
  });
});
