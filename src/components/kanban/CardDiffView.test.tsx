import { createRef } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { DiffReviewModel } from '../../diffReview/types';
import type { KanbanCard } from '../../kanban/types';
import { CardDiffView } from './CardDiffView';
import { WorkDiffView } from '../WorkDiffView';
import { DiffTab, type DiffTreeNavigation } from '../DiffTab';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../DiffOverlay', () => ({ DiffOverlay: () => <div className="mockDiffContent" /> }));

function makeReview(): DiffReviewModel {
  return { openDiff: { path: 'z.ts', patch: 'existing' }, overallComment: '', comments: [], reviewedFiles: new Set(),
    setOpenDiff: vi.fn(), setOverallComment: vi.fn(), addComment: vi.fn(), updateComment: vi.fn(), deleteComment: vi.fn(), toggleReviewed: vi.fn(), reset: vi.fn() };
}
const files = [{ path: 'src/nested/a.ts', status: 'M' }, { path: 'src/b.ts', status: 'A' }, { path: 'z.ts', status: 'M' }];
const card = { environment: { target_branch: 'main' } } as KanbanCard;

async function setupDiff(context: 'project' | 'card', initiallyActive = true, pendingFiles?: Promise<unknown>) {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => command === 'git_diff_files' ? (pendingFiles ?? { files }) : { path: (args as { file: string }).file, patch: 'new' });
  const review = makeReview();
  let renderer!: TestRenderer.ReactTestRenderer;
  const render = (active = true, refreshNonce = 0, cardPath = '/repo') => context === 'card'
    ? <CardDiffView active={active} card={card} cardPath={cardPath} refreshNonce={refreshNonce} review={review} canSubmit={false} onSubmit={vi.fn()} onClose={vi.fn()} />
    : <WorkDiffView active={active} label="Project diff" path={cardPath} comparisonTarget="refs/remotes/origin/main" refreshNonce={refreshNonce} review={review} canSubmit onSubmit={vi.fn()} onClose={vi.fn()} />;
  const focus = vi.fn();
  await act(async () => {
    renderer = TestRenderer.create(render(initiallyActive), {
      createNodeMock: (element) => element.type === 'section' ? { focus } : null,
    });
  });
  expect(renderer.root.findByType(DiffTab).props.comparisonTarget).toBe(context === 'card' ? 'refs/heads/main' : 'refs/remotes/origin/main');
  const highlight = () => renderer.root.findAllByProps({ role: 'treeitem' }).find((row) => row.props['aria-current'] === 'location')?.props['aria-label'];
  const key = async (key: string, options: Record<string, unknown> = {}, selector: string | null = null) => {
    const target = { closest: (query: string) => selector && query.includes(selector) ? {} : null };
    const event = { key, target, currentTarget: { contains: () => true }, nativeEvent: {}, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...options };
    await act(async () => { renderer.root.findByType('section').props.onKeyDown(event); });
    return event;
  };
  return { renderer, review, render, highlight, key, focus };
}

describe.each(['project', 'card'] as const)('%s diff Vim navigation', (context) => {
  const setup = () => setupDiff(context);
  it('focuses on initial active mount and each activation, preserving highlight and ignoring ordinary updates', async () => {
    const { renderer, render, highlight, key, focus } = await setup();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    await key('j'); await key('j');
    expect(highlight()).toBe('src/nested/a.ts');
    await act(async () => { renderer.update(render(false)); });
    expect((await key('j')).preventDefault).not.toHaveBeenCalled();
    await act(async () => { renderer.update(render()); });
    expect(focus).toHaveBeenCalledTimes(2);
    expect(highlight()).toBe('src/nested/a.ts');
    // A focused comment editor/control must not lose focus to rerenders or refreshes.
    await act(async () => { renderer.update(render()); });
    await act(async () => { renderer.update(render(true, 1)); });
    expect(focus).toHaveBeenCalledTimes(2);
    expect(highlight()).toBe('src/nested/a.ts');
    await act(async () => { renderer.update(render(false, 1)); });
    vi.mocked(invoke).mockResolvedValueOnce({ files: [{ path: 'replacement.ts', status: 'M' }] });
    await act(async () => { renderer.update(render(true, 2)); });
    expect(focus).toHaveBeenCalledTimes(3);
    expect(highlight()).toBe('replacement.ts');
    act(() => renderer.unmount());
  });

  it('does not focus while initially hidden, then focuses before delayed files arrive without refocusing on completion', async () => {
    let resolveFiles!: (value: unknown) => void;
    const pending = new Promise((resolve) => { resolveFiles = resolve; });
    const { renderer, render, highlight, key, focus } = await setupDiff(context, false, pending);
    expect(focus).not.toHaveBeenCalled();
    await act(async () => { renderer.update(render()); });
    expect(focus).toHaveBeenCalledOnce();
    expect((await key('j')).preventDefault).not.toHaveBeenCalled();
    await act(async () => { resolveFiles({ files }); });
    expect(focus).toHaveBeenCalledOnce();
    expect(highlight()).toBe('src');
    await key('j');
    expect(highlight()).toBe('src/nested');
    act(() => renderer.unmount());
  });

  it('moves independently of the opened diff, stops at boundaries, and opens only on Enter', async () => {
    const { renderer, review, highlight, key } = await setup();
    expect(highlight()).toBe('src');
    await key('k');
    expect(highlight()).toBe('src');
    await key('j');
    expect(highlight()).toBe('src/nested');
    await key('j');
    expect(highlight()).toBe('src/nested/a.ts');
    expect(review.setOpenDiff).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ 'aria-label': 'z.ts' }).props['aria-selected']).toBe(true);
    expect(renderer.root.findByProps({ 'aria-label': 'src/nested/a.ts' }).props['aria-selected']).toBe(false);
    await key('Enter');
    expect(review.setOpenDiff).toHaveBeenCalledWith({ path: 'src/nested/a.ts', patch: 'new' });
    await key('j'); await key('j'); await key('j');
    expect(highlight()).toBe('z.ts');
    await key('l');
    expect(highlight()).toBe('z.ts');
    act(() => renderer.unmount());
  });

  it.each([false, true])('toggles the highlighted file with Space without changing focus or preview (preview open: %s)', async (previewOpen) => {
    const { renderer, review, render, highlight, key, focus } = await setup();
    if (!previewOpen) {
      review.openDiff = null;
      await act(async () => { renderer.update(render()); });
    }
    const originalPreview = review.openDiff;
    await key('j'); await key('j');
    const file = 'src/nested/a.ts';
    expect(highlight()).toBe(file);
    review.toggleReviewed = vi.fn((path: string) => {
      if (review.reviewedFiles.has(path)) review.reviewedFiles.delete(path);
      else review.reviewedFiles.add(path);
    });
    await act(async () => { renderer.update(render()); });
    const focusCalls = focus.mock.calls.length;
    vi.mocked(invoke).mockClear();
    for (const reviewed of [true, false]) {
      const event = await key(' ');
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
      await act(async () => { renderer.update(render()); });
      expect(review.reviewedFiles.has(file)).toBe(reviewed);
      const row = renderer.root.findByProps({ 'aria-label': file });
      expect(row.props.className.includes('reviewed')).toBe(reviewed);
      expect(row.findByProps({ className: 'diffReviewDot' }).props['aria-pressed']).toBe(reviewed);
      expect(highlight()).toBe(file);
      expect(review.openDiff).toBe(originalPreview);
      expect(focus).toHaveBeenCalledTimes(focusCalls);
      expect(review.setOpenDiff).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      const repeat = await key(' ', { repeat: true });
      expect(repeat.preventDefault).toHaveBeenCalledOnce();
      expect(repeat.stopPropagation).toHaveBeenCalledOnce();
      expect(review.reviewedFiles.has(file)).toBe(reviewed);
    }
    expect(review.toggleReviewed).toHaveBeenCalledTimes(2);
    expect(review.toggleReviewed).toHaveBeenNthCalledWith(1, file);
    expect(review.toggleReviewed).toHaveBeenNthCalledWith(2, file);
    // Space does not disturb subsequent navigation or opening.
    await key('Enter');
    expect(review.setOpenDiff).toHaveBeenCalledWith({ path: file, patch: 'new' });
    await key('j');
    expect(highlight()).toBe('src/b.ts');
    act(() => renderer.unmount());
  });

  it('ignores Space on folders and when no file is highlighted', async () => {
    const { renderer, review, render, highlight, key } = await setup();
    expect(highlight()).toBe('src');
    expect((await key(' ')).preventDefault).not.toHaveBeenCalled();
    expect(highlight()).toBe('src');
    expect(renderer.root.findByProps({ 'aria-label': 'src' }).props['aria-expanded']).toBe(true);
    vi.mocked(invoke).mockResolvedValueOnce({ files: [] });
    await act(async () => { renderer.update(render(true, 1)); });
    expect(highlight()).toBeUndefined();
    expect((await key(' ')).preventDefault).not.toHaveBeenCalled();
    expect(review.toggleReviewed).not.toHaveBeenCalled();
    expect(review.setOpenDiff).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('preserves Space typing and native control activation and ignores guarded events', async () => {
    const { renderer, review, render, highlight, key } = await setup();
    await key('j'); await key('j');
    for (const repeat of [false, true]) {
      for (const option of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'defaultPrevented']) {
        expect((await key(' ', { repeat, [option]: true })).preventDefault).not.toHaveBeenCalled();
      }
      expect((await key(' ', { repeat, nativeEvent: { isComposing: true } })).preventDefault).not.toHaveBeenCalled();
      expect((await key(' ', { repeat, currentTarget: { contains: () => false } })).preventDefault).not.toHaveBeenCalled();
      for (const selector of ['input', 'textarea', 'select', 'contenteditable', 'textbox', 'searchbox', 'combobox', 'spinbutton', 'button', 'a[href]', 'summary', 'link', 'checkbox', 'switch', 'menuitem', 'tab', 'radio']) {
        const event = await key(' ', { repeat }, selector);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(event.stopPropagation).not.toHaveBeenCalled();
      }
      await act(async () => { renderer.update(render(false)); });
      expect((await key(' ', { repeat })).preventDefault).not.toHaveBeenCalled();
      await act(async () => { renderer.update(render()); });
    }
    expect(highlight()).toBe('src/nested/a.ts');
    expect(review.toggleReviewed).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('expands, collapses, skips hidden descendants, and navigates parents and children', async () => {
    const { renderer, highlight, key } = await setup();
    await key('h');
    expect(renderer.root.findByProps({ 'aria-label': 'src' }).props['aria-expanded']).toBe(false);
    await key('j');
    expect(highlight()).toBe('z.ts');
    await key('k'); await key('l');
    expect(highlight()).toBe('src');
    await key('l');
    expect(highlight()).toBe('src/nested');
    await key('l');
    expect(highlight()).toBe('src/nested/a.ts');
    await key('h');
    expect(highlight()).toBe('src/nested');
    await key('Enter');
    expect(renderer.root.findByProps({ 'aria-label': 'src/nested' }).props['aria-expanded']).toBe(false);
    await key('h');
    expect(highlight()).toBe('src');
    act(() => renderer.unmount());
  });

  it('synchronizes mouse review/open/folder actions and reconciles refresh and card changes', async () => {
    const { renderer, review, render, highlight, key } = await setup();
    act(() => renderer.root.findByProps({ 'aria-label': 'Mark reviewed: src/b.ts' }).props.onClick());
    expect(highlight()).toBe('src/b.ts');
    expect(review.toggleReviewed).toHaveBeenCalledWith('src/b.ts');
    expect(review.setOpenDiff).not.toHaveBeenCalled();
    await act(async () => { renderer.update(render(true, 1)); });
    expect(highlight()).toBe('src/b.ts');
    await act(async () => { renderer.root.findByProps({ 'aria-label': 'Open src/nested/a.ts' }).props.onClick(); });
    expect(highlight()).toBe('src/nested/a.ts');
    act(() => renderer.root.findByProps({ 'aria-label': 'src' }).findAllByType('button')[0].props.onClick());
    expect(highlight()).toBe('src');
    await key('l'); await key('j');
    vi.mocked(invoke).mockResolvedValueOnce({ files: [{ path: 'other.ts', status: 'A' }] });
    await act(async () => { renderer.update(render(true, 2)); });
    expect(highlight()).toBe('other.ts');
    await act(async () => { renderer.update(render(true, 2, '/another-card')); });
    expect(highlight()).toBe('src');
    vi.mocked(invoke).mockResolvedValueOnce({ files: [] });
    await act(async () => { renderer.update(render(true, 3, '/another-card')); });
    expect(highlight()).toBeUndefined();
    expect((await key('j')).preventDefault).not.toHaveBeenCalled();
    expect((await key('Enter')).preventDefault).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('excludes inactive views, unrelated targets, modifiers, composition and editable controls; preserves native Enter', async () => {
    const { renderer, render, highlight, key } = await setup();
    for (const option of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'defaultPrevented']) {
      expect((await key('j', { [option]: true })).preventDefault).not.toHaveBeenCalled();
    }
    expect((await key('j', { nativeEvent: { isComposing: true } })).preventDefault).not.toHaveBeenCalled();
    expect((await key('j', { currentTarget: { contains: () => false } })).preventDefault).not.toHaveBeenCalled();
    for (const selector of ['input', 'textarea', 'select', 'contenteditable', 'textbox', 'searchbox', 'combobox', 'spinbutton']) {
      expect((await key('j', {}, selector)).preventDefault).not.toHaveBeenCalled();
      expect((await key('Enter', {}, selector)).preventDefault).not.toHaveBeenCalled();
    }
    for (const selector of ['button', 'a[href]', 'summary', 'checkbox', 'switch', 'menuitem', 'tab', 'radio']) {
      expect((await key('Enter', {}, selector)).preventDefault).not.toHaveBeenCalled();
    }
    expect(highlight()).toBe('src');
    await act(async () => { renderer.update(render(false)); });
    expect((await key('j')).preventDefault).not.toHaveBeenCalled();
    expect(highlight()).toBe('src');
    await act(async () => { renderer.update(render()); });
    expect((await key('j')).preventDefault).toHaveBeenCalledOnce();
    expect(highlight()).toBe('src/nested');
    act(() => renderer.unmount());
  });

  it('reuses file loading/error handling and rejects stale keyboard-opened patches after refresh', async () => {
    const { renderer, review, render, key, highlight } = await setup();
    let resolvePatch!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation((command) => command === 'git_file_diff'
      ? new Promise((resolve) => { resolvePatch = resolve; })
      : Promise.resolve({ files }));
    await key('j'); await key('j');
    await key('Enter');
    expect(renderer.root.findByProps({ 'aria-label': 'Open src/nested/a.ts' }).props.disabled).toBe(true);
    expect((await key('Enter')).preventDefault).not.toHaveBeenCalled();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'git_file_diff')).toHaveLength(1);
    await key('j');
    expect(highlight()).toBe('src/b.ts');
    await act(async () => { renderer.update(render(true, 1)); });
    await act(async () => { resolvePatch({ path: 'src/nested/a.ts', patch: 'stale' }); });
    expect(review.setOpenDiff).not.toHaveBeenCalled();
    expect(highlight()).toBe('src/b.ts');
    vi.mocked(invoke).mockRejectedValueOnce(new Error('Patch unavailable'));
    await key('Enter');
    expect(renderer.root.findByProps({ className: 'superthreadState superthreadError' }).children).toEqual(['Error: Patch unavailable']);
    expect(review.setOpenDiff).not.toHaveBeenCalled();
    expect((await key('j')).preventDefault).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('scrolls only the explorer without focusing a row', async () => {
    vi.mocked(invoke).mockResolvedValue({ files });
    const navigationRef = createRef<DiffTreeNavigation>();
    const explorer = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 100 }) };
    const row = { getBoundingClientRect: () => ({ top: 120, bottom: 140 }) };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<DiffTab navigationRef={navigationRef} activePath="/repo" comparisonTarget="main" refreshNonce={0} review={makeReview()} />, {
        createNodeMock: (element) => (element.props as { role?: string }).role === 'tree' ? { querySelector: () => row, closest: () => explorer } : null,
      });
    });
    explorer.scrollTop = 0;
    act(() => { navigationRef.current!.navigate('j'); });
    expect(explorer.scrollTop).toBe(40);
    act(() => renderer.unmount());
  });
});
