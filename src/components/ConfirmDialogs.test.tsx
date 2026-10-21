import { StrictMode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, useConfirmation } from './ConfirmDialogs';
import { ConfirmationBoundary } from './ConfirmationBoundary';
import { handleDialogShortcut } from './dialogShortcut';

let renderer: TestRenderer.ReactTestRenderer | undefined;
const cancelFocus = vi.fn();
const primaryFocus = vi.fn();
let visible = true;
let connected = true;
let topDialog: unknown = null;
let eligible = true;
const root = {
  get isConnected() { return connected; },
  get hidden() { return !visible; },
  parentElement: null,
  getAttribute: () => null,
  contains: (node: unknown) => node === root,
  querySelector: (selector: string) => selector.includes('data-confirm-cancel') ? { focus: cancelFocus }
    : eligible ? { focus: primaryFocus } : null,
};
const nodeMock = (element: { props: unknown }) => (element.props as Record<string, unknown>)['data-confirmation-boundary'] ? root : null;
const event = (key = 'Enter', metaKey = false) => ({ key, metaKey, ctrlKey: false, altKey: false, shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() });
function buttons() { return renderer!.root.findAllByType('button'); }
function advance(ms: number) { act(() => { vi.advanceTimersByTime(ms); }); }
function label(index = 1) { return buttons()[index].children.join(''); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', { querySelectorAll: () => topDialog ? [topDialog] : [] });
  vi.stubGlobal('getComputedStyle', () => ({ display: 'block' }));
  visible = connected = eligible = true;
  topDialog = null;
  cancelFocus.mockClear(); primaryFocus.mockClear();
});
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('shared confirmation gate', () => {
  it('counts down without auto-execution, focuses Cancel then primary, and does not reset on rerender', () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    const dialog = () => <ConfirmDialog title="Test" cancelLabel="Cancel" onCancel={cancel} onConfirm={confirm}><p>Detail</p></ConfirmDialog>;
    act(() => { renderer = TestRenderer.create(dialog(), { createNodeMock: nodeMock }); });
    expect(label()).toBe('Yes (2)');
    expect(cancelFocus).toHaveBeenCalledOnce();
    expect(primaryFocus).not.toHaveBeenCalled();
    expect(buttons()[1].props.disabled).toBe(true);
    const staleSubmit = renderer!.root.findByType('form').props.onSubmit;
    staleSubmit(event());
    buttons()[1].props.onClick(event(' ')); // Mouse/Space share the guarded click callback.
    expect(confirm).not.toHaveBeenCalled();
    advance(1000);
    expect(label()).toBe('Yes (1)');
    act(() => { renderer!.update(dialog()); });
    expect(label()).toBe('Yes (1)');
    advance(999);
    staleSubmit(event('Enter', true));
    expect(confirm).not.toHaveBeenCalled();
    advance(1);
    expect(label()).toBe('Yes');
    expect(buttons()[1].props.disabled).toBe(false);
    expect(primaryFocus).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    renderer!.root.findByType('form').props.onSubmit(event());
    expect(confirm).toHaveBeenCalledOnce();
    buttons()[0].props.onClick();
    renderer!.root.findByType('form').props.onKeyDown(event('Escape'));
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('consumes Enter/Cmd-Enter through enabled buttons only (meta=%s)', (metaKey) => {
    const confirm = vi.fn();
    act(() => { renderer = TestRenderer.create(<ConfirmDialog title="Test" onCancel={() => {}} onConfirm={confirm}>Detail</ConfirmDialog>); });
    const click = vi.fn(() => renderer!.root.findByType('form').props.onSubmit(event()));
    const target = {
      querySelectorAll: () => [{ disabled: buttons()[1].props.disabled, closest: () => target, getClientRects: () => [1], click }],
    };
    const press = () => {
      const e = { ...event('Enter', metaKey), currentTarget: target };
      handleDialogShortcut(e as never, true);
      expect(e.preventDefault).toHaveBeenCalled();
    };
    press();
    expect(click).not.toHaveBeenCalled();
    advance(2000);
    expect(confirm).not.toHaveBeenCalled();
    press();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('gates every non-cancel action and preserves eligibility/busy conditions', () => {
    const save = vi.fn(); const discard = vi.fn();
    const dialog = (disabled: boolean) => <ConfirmationBoundary><div><button>Cancel</button><button disabled={disabled} onClick={discard}>Discard</button><button className="primaryAction" disabled={disabled} onClick={save}>Save</button></div></ConfirmationBoundary>;
    eligible = false;
    act(() => { renderer = TestRenderer.create(dialog(true), { createNodeMock: nodeMock }); });
    expect(buttons().map((b) => b.props.disabled)).toEqual([undefined, true, true]);
    buttons()[1].props.onClick(); buttons()[2].props.onClick();
    expect(save).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled();
    advance(2000);
    expect(label(1)).toBe('Discard'); expect(label(2)).toBe('Save');
    expect(buttons()[2].props.disabled).toBe(true);
    expect(primaryFocus).not.toHaveBeenCalled();
    buttons()[2].props.onClick();
    expect(save).not.toHaveBeenCalled();
    eligible = true;
    act(() => { renderer!.update(dialog(false)); });
    buttons()[1].props.onClick(); buttons()[2].props.onClick();
    expect(save).toHaveBeenCalledOnce(); expect(discard).toHaveBeenCalledOnce();
    act(() => { renderer!.update(dialog(true)); });
    buttons()[2].props.onClick();
    expect(save).toHaveBeenCalledOnce();
  });

  it.each(['hidden', 'background', 'disconnected'])('does not focus a %s dialog at expiry', (state) => {
    act(() => { renderer = TestRenderer.create(<ConfirmDialog title="Test" onCancel={() => {}} onConfirm={() => {}}>Detail</ConfirmDialog>, { createNodeMock: nodeMock }); });
    if (state === 'hidden') visible = false;
    if (state === 'disconnected') connected = false;
    if (state === 'background') topDialog = { ...root, contains: () => false };
    advance(2000);
    expect(primaryFocus).not.toHaveBeenCalled();
  });

  it('clears timers and guards stale callbacks after unmount; reopening and StrictMode replay start fresh', () => {
    const confirm = vi.fn();
    const dialog = <StrictMode><ConfirmDialog title="Test" onCancel={() => {}} onConfirm={confirm}>Detail</ConfirmDialog></StrictMode>;
    act(() => { renderer = TestRenderer.create(dialog, { createNodeMock: nodeMock }); });
    advance(1000);
    const staleSubmit = renderer!.root.findByType('form').props.onSubmit;
    act(() => { renderer!.unmount(); });
    expect(vi.getTimerCount()).toBe(0);
    advance(3000); staleSubmit(event());
    expect(confirm).not.toHaveBeenCalled(); expect(primaryFocus).not.toHaveBeenCalled();
    act(() => { renderer = TestRenderer.create(dialog, { createNodeMock: nodeMock }); });
    expect(label()).toBe('Yes (2)');
    advance(2000);
    expect(label()).toBe('Yes');
  });
});

let confirmation: ReturnType<typeof useConfirmation>;
function Owner({ id }: { id: string }) { confirmation = useConfirmation(id); return confirmation.dialog; }

describe('awaited confirmation requests', () => {
  it('resolves accept/cancel, rejects duplicates and starts a fresh delay per request', async () => {
    act(() => { renderer = TestRenderer.create(<Owner id="one" />); });
    let first!: Promise<boolean>;
    act(() => { first = confirmation.confirm('Discard edits?', 'Unsaved text', 'Discard'); });
    await expect(confirmation.confirm('Duplicate')).resolves.toBe(false);
    expect(label()).toBe('Discard (2)');
    renderer!.root.findByType('form').props.onSubmit(event());
    advance(2000);
    act(() => { renderer!.root.findByType('form').props.onSubmit(event()); });
    await expect(first).resolves.toBe(true);
    act(() => { first = confirmation.confirm('Again'); });
    expect(label()).toBe('Confirm (2)');
    act(() => { buttons()[0].props.onClick(); });
    await expect(first).resolves.toBe(false);
  });

  it.each(['change', 'unmount'])('safely cancels a pending request on owner %s', async (operation) => {
    act(() => { renderer = TestRenderer.create(<Owner id="one" />); });
    let pending!: Promise<boolean>;
    act(() => { pending = confirmation.confirm('Delete?'); });
    if (operation === 'change') act(() => { renderer!.update(<Owner id="two" />); });
    else act(() => { renderer!.unmount(); });
    await expect(pending).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
