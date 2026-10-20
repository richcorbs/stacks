import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupSelections, CleanupPreflightDialog } from './CleanupPreflightDialog';
import type { CleanupPreflight } from '../../kanban/types';

function entry(overrides: Partial<CleanupPreflight> = {}): CleanupPreflight {
  return {
    card_id: 'c1', card_number: '156', card_title: 'Safe cleanup', project_id: 'p1', project_name: 'Secret Project', completion_outcome: 'merged',
    workflow_revision: 2, environment_revision: 3, merged: true, blocked: false, override_available: false, has_resources: true,
    eligible: true, state: 'pending_cleanup', repository_id: '/secret/repo/.git', primary_checkout: '/secret/repo',
    recorded_target_branch: 'master', current_target_branch: 'main', target_revision: 'target-secret', source_path: '/secret/repo-card',
    source_exists: true, source_registered: true, source_branch: 'secret-card-branch', source_clean: true, source_head: 'source-secret',
    source_revision: 'source-secret', source_git_operation: false, merge_proof: 'exact ancestry secret', local_branch_disposition: 'delete exact tip',
    remote_branch_disposition: 'retained', resources: [{ resource_type: 'PTY', id: 'secret-terminal', disposition: 'stop' }],
    metadata: ['secret metadata'], blockers: ['secret blocker detail'], retained: ['secret retained detail'], orphan_warning: 'secret warning', ...overrides,
  };
}

function render(entries: CleanupPreflight[], bulk = false) {
  return renderToStaticMarkup(<CleanupPreflightDialog bulk={bulk} inventory={{ entries, eligible_merged: 0, blocked: 0, closed: 0, completed: 0 }} onCancel={vi.fn()} onConfirm={vi.fn()} />);
}

describe('CleanupPreflightDialog keyboard focus', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  afterEach(() => {
    act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  });

  function mount({ bulk = false, entries = [entry()], onConfirm = vi.fn().mockResolvedValue(undefined) } = {}) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let focusFrame!: FrameRequestCallback;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { focusFrame = callback; return 7; }));
    const cancelFrame = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    const focus = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      renderer = TestRenderer.create(<CleanupPreflightDialog bulk={bulk} inventory={{ entries, eligible_merged: 0, blocked: 0, closed: 0, completed: 0 }} onCancel={onCancel} onConfirm={onConfirm} />, {
        createNodeMock: (element) => ({ focus: () => focus((element.props as { role?: string }).role ?? element.type) }),
      });
    });
    const dialog = renderer!.root.findByProps({ role: 'dialog' });
    const buttons = () => renderer!.root.findAllByType('button');
    const dispatch = (key: string, metaKey = false) => {
      const click = vi.fn(() => { void buttons()[1].props.onClick(); });
      const root = { querySelectorAll: () => [{ disabled: buttons()[1].props.disabled, closest: () => root, getClientRects: () => [1], click, focus: () => focus('control') }] };
      const event = { key, metaKey, ctrlKey: false, altKey: false, shiftKey: false, target: root, currentTarget: root, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      act(() => dialog.props.onKeyDown(event));
      return { event, click };
    };
    return { dialog, buttons, dispatch, focus, runFocus: () => act(() => focusFrame(0)), cancelFrame, onCancel, onConfirm };
  }

  it.each([false, true])('initially focuses the container (bulk=%s) and traps Tab within controls', (bulk) => {
    const { dialog, buttons, focus, runFocus, dispatch, onCancel } = mount({ bulk });
    expect(dialog.props.tabIndex).toBe(-1);
    expect(focus).not.toHaveBeenCalled();
    runFocus();
    expect(focus.mock.calls).toEqual([['dialog']]);
    for (const button of buttons()) {
      expect(button.props.autoFocus).toBeUndefined();
      expect(button.props.tabIndex).toBeUndefined();
      expect(button.props.disabled).toBe(false);
    }
    const { event, click } = dispatch('Tab');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(focus).toHaveBeenLastCalledWith('control');
    expect(click).not.toHaveBeenCalled();
    act(() => buttons()[0].props.onClick());
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('cancels delayed focus on dismissal before the next frame', () => {
    const { focus, runFocus, cancelFrame } = mount();
    act(() => renderer!.unmount());
    expect(cancelFrame).toHaveBeenCalledWith(7);
    runFocus(); // Even a stale callback cannot focus the dismissed dialog.
    expect(focus).not.toHaveBeenCalled();
  });

  it.each([false, true])('dispatches Enter through enabled cleanup (metaKey=%s)', async (metaKey) => {
    const { dispatch, onConfirm } = mount();
    await act(async () => { dispatch('Enter', metaKey); });
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onConfirm.mock.calls[0][0][0].card_id).toBe('c1');
  });

  it.each([false, true])('consumes Enter without cleaning blocked selections (metaKey=%s)', (metaKey) => {
    const { dispatch, onConfirm } = mount({ entries: [entry({ blocked: true, eligible: false })] });
    const { event, click } = dispatch('Enter', metaKey);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cancels on Escape', () => {
    const { dispatch, onCancel } = mount();
    dispatch('Escape');
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('preserves busy and synchronous duplicate-submission guards', async () => {
    let finish!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { buttons, dispatch } = mount({ onConfirm });
    const confirm = buttons()[1].props.onClick;
    let pending!: Promise<void>;
    act(() => { pending = confirm(); void confirm(); });
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(buttons().every((button) => button.props.disabled)).toBe(true);
    expect(dispatch('Enter').click).not.toHaveBeenCalled();
    expect(dispatch('Enter', true).click).not.toHaveBeenCalled();
    await act(async () => { finish(); await pending; });
    expect(buttons().every((button) => !button.props.disabled)).toBe(true);
  });
});

describe('CleanupPreflightDialog', () => {
  it('uses the same compact card row for single and bulk cleanup', () => {
    for (const html of [render([entry()]), render([entry()], true)]) {
      expect(html).toContain('#156 Safe cleanup');
      expect(html).toContain('Merged');
      expect(html).toContain('Not blocked');
      for (const hidden of ['Secret Project', '/secret/', 'target-secret', 'source-secret', 'secret-card-branch', 'secret-terminal', 'secret metadata', 'secret blocker', 'secret warning']) {
        expect(html).not.toContain(hidden);
      }
    }
  });

  it('offers Cleanup anyway only for overridable merged blockers', () => {
    expect(render([entry({ blocked: true, eligible: false, override_available: true })])).toContain('Cleanup anyway');
    expect(render([entry({ merged: false, blocked: true, eligible: false, override_available: false })])).not.toContain('Cleanup anyway');
    expect(render([entry({ blocked: true, eligible: false, override_available: false })])).not.toContain('Cleanup anyway');
  });

  it('shows mixed bulk statuses without implementation evidence', () => {
    const html = render([
      entry(),
      entry({ card_id: 'c2', card_number: '157', card_title: 'Dirty merged', blocked: true, eligible: false, override_available: true }),
      entry({ card_id: 'c3', card_number: '158', card_title: 'Advanced', merged: false, blocked: true, eligible: false }),
    ], true);
    expect(html).toContain('#157 Dirty merged');
    expect(html).toContain('#158 Advanced');
    expect(html).toContain('Not merged');
    expect((html.match(/Cleanup anyway/g) ?? [])).toHaveLength(1);
    expect(html).toContain('Clean up 1');

    const entries = [
      entry(),
      entry({ card_id: 'c2', blocked: true, eligible: false, override_available: true }),
      entry({ card_id: 'c3', blocked: true, eligible: false, override_available: false }),
    ];
    const selected = cleanupSelections(entries, new Set(['c2', 'c3']));
    expect(selected.map(({ card_id }) => card_id)).toEqual(['c1', 'c2']);
    expect(selected.map(({ cleanup_anyway }) => cleanup_anyway)).toEqual([false, true]);
  });
});
