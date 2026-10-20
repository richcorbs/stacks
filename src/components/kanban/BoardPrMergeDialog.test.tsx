import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KanbanCardSummary } from '../../kanban/types';
import { BoardPrMergeDialog } from './BoardPrMergeDialog';

const card = { external_id: '265', title: 'Target card', pull_request: { number: 98, url: 'https://github.com/a/b/pull/98' } } as KanbanCardSummary;
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

it('identifies the captured card and PR in an accessible confirmation', () => {
  const markup = renderToStaticMarkup(<BoardPrMergeDialog card={card} busy={false} error={null} onCancel={() => {}} onConfirm={() => {}} />);
  expect(markup).toContain('role="alertdialog"');
  expect(markup).toContain('Merge PR #98?');
  expect(markup).toContain('Card #265: Target card');
  expect(markup).toContain('https://github.com/a/b/pull/98');
});

it('focuses confirmation, cancels on Escape, and prevents submission while busy or after failure', () => {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  const focus = vi.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  const component = (busy = false, error: string | null = null) => <BoardPrMergeDialog card={card} busy={busy} error={error} onCancel={onCancel} onConfirm={onConfirm} />;
  act(() => { renderer = TestRenderer.create(component(), { createNodeMock: () => ({ focus }) }); });
  expect(focus).toHaveBeenCalled();
  const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
  renderer.root.findByType('form').props.onKeyDown(event);
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
  const cancelButton = renderer.root.findAllByType('button')[0];
  const cancelEnter = { key: 'Enter', target: { closest: () => ({}) }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  renderer.root.findByType('form').props.onKeyDown(cancelEnter);
  expect(cancelEnter.preventDefault).not.toHaveBeenCalled(); // Native activation must stay with Cancel.
  expect(onConfirm).not.toHaveBeenCalled();
  cancelButton.props.onClick();
  expect(onCancel).toHaveBeenCalledTimes(2);
  renderer.root.findByType('form').props.onSubmit(event);
  expect(onConfirm).toHaveBeenCalledOnce();
  act(() => renderer.update(component(true)));
  renderer.root.findByType('form').props.onKeyDown(event);
  renderer.root.findByType('form').props.onSubmit(event);
  expect(onCancel).toHaveBeenCalledTimes(2);
  expect(onConfirm).toHaveBeenCalledOnce();
  expect(renderer.root.findAllByType('button').every((button) => button.props.disabled)).toBe(true);
  act(() => renderer.update(component(false, 'PR merged, but branch deletion failed')));
  expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('PR merged');
  expect(renderer.root.findAllByType('button')).toHaveLength(1);
  renderer.root.findByType('form').props.onSubmit(event);
  expect(onConfirm).toHaveBeenCalledOnce();
  act(() => renderer.unmount());
});
