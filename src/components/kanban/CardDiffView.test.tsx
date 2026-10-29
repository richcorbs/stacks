import { createRef } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { DiffReviewModel } from '../../diffReview/types';
import type { KanbanCard } from '../../kanban/types';
import { CardDiffView } from './CardDiffView';
import { DiffTab, type DiffTreeNavigation } from '../DiffTab';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../DiffOverlay', () => ({ DiffOverlay: () => <div className="mockDiffContent" /> }));

function makeReview(): DiffReviewModel {
  return { openDiff: { path: 'z.ts', patch: 'existing' }, overallComment: '', comments: [], reviewedFiles: new Set(),
    setOpenDiff: vi.fn(), setOverallComment: vi.fn(), addComment: vi.fn(), updateComment: vi.fn(), deleteComment: vi.fn(), toggleReviewed: vi.fn(), reset: vi.fn() };
}
const files = [{ path: 'src/nested/a.ts', status: 'M' }, { path: 'src/b.ts', status: 'A' }, { path: 'z.ts', status: 'M' }];
const card = { environment: { target_branch: 'main' } } as KanbanCard;

async function setup() {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => command === 'git_diff_files' ? { files } : { path: (args as { file: string }).file, patch: 'new' });
  const review = makeReview();
  let renderer!: TestRenderer.ReactTestRenderer;
  const render = (active = true, refreshNonce = 0, cardPath = '/repo') => <CardDiffView active={active} card={card} cardPath={cardPath} refreshNonce={refreshNonce} review={review} canSubmit={false} onSubmit={vi.fn()} onClose={vi.fn()} />;
  await act(async () => { renderer = TestRenderer.create(render()); });
  const highlight = () => renderer.root.findAllByProps({ role: 'treeitem' }).find((row) => row.props['aria-current'] === 'location')?.props['aria-label'];
  const key = async (key: string, options: Record<string, unknown> = {}, selector: string | null = null) => {
    const target = { closest: (query: string) => selector && query.includes(selector) ? {} : null };
    const event = { key, target, currentTarget: { contains: () => true }, nativeEvent: {}, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...options };
    await act(async () => { renderer.root.findByType('section').props.onKeyDown(event); });
    return event;
  };
  return { renderer, review, render, highlight, key };
}

describe('card diff Vim navigation', () => {
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
