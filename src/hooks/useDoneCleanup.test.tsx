import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDoneCleanup } from './useDoneCleanup';
import type { DoneCleanupDependencies } from '../kanban/doneCleanup';
import { hasActiveConfirmation } from '../components/ConfirmationBoundary';

let renderer: TestRenderer.ReactTestRenderer;
let cleanup: ReturnType<typeof useDoneCleanup>;
let dependencies: Omit<DoneCleanupDependencies, 'confirm' | 'report'>;
const cancelFocus = vi.fn();
const primaryFocus = vi.fn();
const root = {
  isConnected: true, hidden: false, parentElement: null, getAttribute: () => null,
  contains: (node: unknown) => node === root,
  querySelector: (selector: string) => ({ focus: selector.includes('data-confirm-cancel') ? cancelFocus : primaryFocus }),
};
function Owner({ selection = 'one' }: { selection?: string }) {
  void selection;
  cleanup = useDoneCleanup(dependencies);
  return cleanup.dialogs;
}
const event = (key = 'Enter') => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() });
const buttons = () => renderer.root.findAllByType('button');
const text = () => JSON.stringify(renderer.toJSON());
async function start() { let run!: Promise<void>; await act(async () => { run = cleanup.cleanUpDone(); }); return { run }; }
async function cancel() { await act(async () => { buttons()[0].props.onClick(); }); }
async function accept() {
  act(() => { vi.advanceTimersByTime(2000); });
  await act(async () => { renderer.root.findByType('form').props.onSubmit(event()); });
}
async function dismiss() { await act(async () => { buttons()[0].props.onClick(); }); }
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', { querySelectorAll: (selector: string) => {
    if (selector !== '[data-confirmation-boundary]') return [];
    try { return renderer.root.findAllByProps({ 'data-confirmation-boundary': true }).length ? [root] : []; }
    catch { return []; }
  } });
  vi.stubGlobal('getComputedStyle', () => ({ display: 'block' }));
  cancelFocus.mockClear(); primaryFocus.mockClear();
  dependencies = {
    preview: vi.fn().mockResolvedValue({ candidates: [{ id: 'local:1', done_entered_at: 123 }], pending_artifacts: 2 }),
    execute: vi.fn().mockResolvedValue({ deleted: 1, skipped: 2, failed: 3, removed_ids: ['local:1'], details: ['first detail', 'second detail'] }),
    retireLocalState: vi.fn(),
  };
  act(() => { renderer = TestRenderer.create(<Owner />, { createNodeMock: (element) => (element.props as Record<string, unknown>)['data-confirmation-boundary'] ? root : null }); });
});
afterEach(() => { act(() => renderer.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('uses one in-app confirmation with shared focus/countdown guards and an undelayed multiline report', async () => {
  const { run } = await start();
  expect(hasActiveConfirmation()).toBe(true);
  expect(cancelFocus).toHaveBeenCalledOnce();
  expect(buttons()[1].children.join('')).toBe('Delete local copies (2)');
  expect(buttons()[1].props.disabled).toBe(true);
  expect(text()).toContain('Permanently delete 1 eligible local card copies across all projects?');
  expect(text()).toContain('Also retry 2 pending local file cleanup(s).');
  renderer.root.findByType('form').props.onSubmit(event());
  expect(dependencies.execute).not.toHaveBeenCalled();
  act(() => renderer.update(<Owner selection="another project" />));
  expect(cleanup.dialogOpen).toBe(true);
  await cleanup.cleanUpDone();
  expect(dependencies.preview).toHaveBeenCalledOnce();
  await accept();
  expect(primaryFocus).toHaveBeenCalledOnce();
  expect(dependencies.execute).toHaveBeenCalledOnce();
  expect(dependencies.retireLocalState).toHaveBeenCalledWith(['local:1']);
  expect(hasActiveConfirmation()).toBe(false);
  expect(renderer.root.findByType('p').children.join('')).toBe('Done cleanup across all projects: 1 deleted, 2 skipped, 3 failed.\n\nfirst detail\nsecond detail');
  expect(buttons()).toHaveLength(1);
  expect(buttons()[0].children).toEqual(['OK']);
  expect(buttons()[0].props.disabled).toBeUndefined();
  await cleanup.cleanUpDone();
  expect(dependencies.preview).toHaveBeenCalledOnce();
  await dismiss();
  await run;
  expect(cleanup.dialogOpen).toBe(false);
  const next = await start();
  expect(dependencies.preview).toHaveBeenCalledTimes(2);
  await cancel(); await next.run;
});

it.each(['cancel', 'escape', 'backdrop', 'unmount'])('settles %s without deleting', async (method) => {
  const { run } = await start();
  await act(async () => {
    if (method === 'cancel') buttons()[0].props.onClick();
    if (method === 'escape') renderer.root.findByType('form').props.onKeyDown(event('Escape'));
    if (method === 'backdrop') renderer.root.findByProps({ className: 'modalBackdrop' }).props.onMouseDown();
    if (method === 'unmount') renderer.unmount();
  });
  await run;
  expect(dependencies.execute).not.toHaveBeenCalled();
  expect(dependencies.retireLocalState).not.toHaveBeenCalled();
});

it('reports no eligible cards in-app without confirmation, and settles Escape dismissal', async () => {
  vi.mocked(dependencies.preview).mockResolvedValue({ candidates: [], pending_artifacts: 0 });
  const { run } = await start();
  expect(text()).toContain('No Done cards completed more than 7 days ago across all projects.');
  expect(hasActiveConfirmation()).toBe(false);
  await act(async () => { renderer.root.findByProps({ role: 'dialog' }).props.onKeyDown(event('Escape')); });
  await run;
  expect(dependencies.execute).not.toHaveBeenCalled();
});

it('confirms pending-file retry even with zero candidates and shows errors in-app', async () => {
  vi.mocked(dependencies.preview).mockResolvedValue({ candidates: [], pending_artifacts: 2 });
  vi.mocked(dependencies.execute).mockRejectedValue(new Error('permission denied\nfile details'));
  const { run } = await start();
  expect(text()).toContain('Permanently delete 0 eligible local card copies');
  await accept();
  expect(dependencies.execute).toHaveBeenCalledWith([]);
  expect(renderer.root.findByType('p').children.join('')).toBe('Done cleanup failed: Error: permission denied\nfile details');
  await dismiss(); await run;
});

it('settles an open report on unmount', async () => {
  vi.mocked(dependencies.preview).mockRejectedValue(new Error('preview failed'));
  const { run } = await start();
  expect(text()).toContain('preview failed');
  act(() => renderer.unmount());
  await run;
});

it('keeps execution guarded and retires local state even if the owner unmounts before completion', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof dependencies.execute>>) => void;
  vi.mocked(dependencies.execute).mockImplementation(() => new Promise((done) => { resolve = done; }));
  const { run } = await start();
  await accept();
  await cleanup.cleanUpDone();
  expect(dependencies.preview).toHaveBeenCalledOnce();
  act(() => renderer.unmount());
  resolve({ deleted: 1, skipped: 0, failed: 0, removed_ids: ['local:1'], details: [] });
  await run;
  expect(dependencies.retireLocalState).toHaveBeenCalledWith(['local:1']);
});

it('does not open late dialogs after unmount during preview', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof dependencies.preview>>) => void;
  vi.mocked(dependencies.preview).mockImplementation(() => new Promise((done) => { resolve = done; }));
  const { run } = await start();
  act(() => renderer.unmount());
  resolve({ candidates: [{ id: 'local:1', done_entered_at: 123 }], pending_artifacts: 0 });
  await run;
  expect(dependencies.execute).not.toHaveBeenCalled();
  await cleanup.cleanUpDone();
  expect(dependencies.preview).toHaveBeenCalledOnce();
});
