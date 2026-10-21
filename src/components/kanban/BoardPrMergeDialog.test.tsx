import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KanbanCardSummary } from '../../kanban/types';
import { BoardPrMergeDialog } from './BoardPrMergeDialog';

const card = { external_id: '265', title: 'Target card', pull_request: { number: 98, url: 'https://github.com/a/b/pull/98' } } as KanbanCardSummary;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('identifies the captured card and PR in an accessible confirmation', () => {
  const markup = renderToStaticMarkup(<BoardPrMergeDialog card={card} busy={false} error={null} onCancel={() => {}} onConfirm={() => {}} />);
  expect(markup).toContain('role="alertdialog"');
  expect(markup).toContain('Merge PR #98?');
  expect(markup).toContain('Card #265: Target card');
  expect(markup).toContain('https://github.com/a/b/pull/98');
  expect(markup).toContain('class="primaryAction" type="submit"');
  expect(markup).toContain('MERGE &amp; CLEANUP');
  expect(markup).toContain('confirm local environment cleanup separately');
});

it('delays alternate retry cleanup while preserving error and busy guards', () => {
  const retry = vi.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  const dialog = (busy = false) => <BoardPrMergeDialog card={card} busy={busy} error="PR merged; cleanup failed" onCancel={() => {}} onConfirm={() => {}} onRetryCleanup={retry} />;
  act(() => { renderer = TestRenderer.create(dialog()); });
  const action = () => renderer.root.findAllByType('button')[1];
  expect(action().props.disabled).toBe(true);
  action().props.onClick();
  expect(retry).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(2000); });
  expect(retry).not.toHaveBeenCalled();
  action().props.onClick();
  expect(retry).toHaveBeenCalledOnce();
  act(() => { renderer.update(dialog(true)); });
  action().props.onClick();
  expect(retry).toHaveBeenCalledOnce();
  act(() => renderer.unmount());
});

it('delays both merge actions, cancels on Escape, and prevents submission while busy or after failure', () => {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  const focus = vi.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  const component = (busy = false, error: string | null = null) => <BoardPrMergeDialog card={card} busy={busy} error={error} onCancel={onCancel} onConfirm={onConfirm} />;
  act(() => { renderer = TestRenderer.create(component(), { createNodeMock: (element) => ({ focus: () => focus((element.props as { className?: string }).className) }) }); });
  expect(renderer.root.findAllByType('button').map((button) => button.props.disabled)).toEqual([false, true, true]);
  renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
  renderer.root.findAllByType('button')[1].props.onClick();
  expect(onConfirm).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(2000); });
  const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
  renderer.root.findByType('form').props.onKeyDown(event);
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
  const firstFocus = vi.fn();
  const lastFocus = vi.fn();
  const controls = [{ focus: firstFocus }, { focus: vi.fn() }, { focus: lastFocus }];
  const tab = { key: 'Tab', target: controls[2], currentTarget: { querySelectorAll: () => controls }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  renderer.root.findByType('form').props.onKeyDown(tab);
  expect(firstFocus).toHaveBeenCalledOnce();
  renderer.root.findByType('form').props.onKeyDown({ ...tab, target: controls[0], shiftKey: true });
  expect(lastFocus).toHaveBeenCalledOnce();
  const cancelButton = renderer.root.findAllByType('button')[0];
  const cancelEnter = { key: 'Enter', target: { closest: () => ({}) }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  renderer.root.findByType('form').props.onKeyDown(cancelEnter);
  expect(cancelEnter.preventDefault).not.toHaveBeenCalled(); // Native activation must stay with Cancel.
  expect(onConfirm).not.toHaveBeenCalled();
  cancelButton.props.onClick();
  expect(onCancel).toHaveBeenCalledTimes(2);
  renderer.root.findByType('form').props.onSubmit(event);
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith('merge-and-cleanup');
  expect(renderer.root.findAllByType('button')[1].props.className).toBeUndefined();
  renderer.root.findAllByType('button')[1].props.onClick();
  expect(onConfirm).toHaveBeenLastCalledWith('merge');
  onConfirm.mockClear();
  act(() => renderer.update(component(true)));
  renderer.root.findByType('form').props.onKeyDown(event);
  renderer.root.findByType('form').props.onSubmit(event);
  expect(onCancel).toHaveBeenCalledTimes(2);
  expect(onConfirm).not.toHaveBeenCalled();
  expect(renderer.root.findAllByType('button').every((button) => button.props.disabled)).toBe(true);
  act(() => renderer.update(component(false, 'PR merged, but branch deletion failed')));
  expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('PR merged');
  expect(renderer.root.findAllByType('button')).toHaveLength(1);
  renderer.root.findByType('form').props.onSubmit(event);
  expect(onConfirm).not.toHaveBeenCalled();
  act(() => renderer.unmount());
});
