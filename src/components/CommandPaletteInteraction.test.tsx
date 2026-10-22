import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TestRenderer, { act } from 'react-test-renderer';
import { CommandPalette, type PaletteItem } from './CommandPalette';

const command: PaletteItem = { id: 'settings', title: 'Settings', action: vi.fn() };

function card(action: () => void): PaletteItem {
  return { id: 'card:89', kind: 'card', cardNumber: '89', title: '#89 Search cards', searchText: '89 Search cards', action };
}

describe('CommandPalette card activation', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(['Enter', 'click'])('closes and runs a selected card with %s', (method) => {
    const onClose = vi.fn();
    const action = vi.fn();
    const onSelectCommand = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<CommandPalette open items={[command]} cardItems={[card(action)]} onClose={onClose} onSelectCommand={onSelectCommand} />);
    });
    const input = renderer.root.findByType('input');
    act(() => input.props.onChange({ target: { value: '89' } }));

    act(() => {
      if (method === 'Enter') input.props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() });
      else renderer.root.findByType('button').props.onClick();
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
    expect(onSelectCommand).not.toHaveBeenCalled();
  });

  it.each(['Enter', 'click'])('records exactly once before command action with %s, including typed searches and cancelled follow-ups', (method) => {
    const order: string[] = [];
    const onSelectCommand = vi.fn((id: string) => order.push(id));
    const onRunItem = vi.fn(() => order.push('close'));
    // No completion signal: a follow-up dialog may be cancelled after activation.
    const action = vi.fn(() => order.push('open-dialog'));
    const items = [{ id: 'new-card', title: 'New card', action }];
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<CommandPalette open items={items} onClose={vi.fn()} onRunItem={onRunItem} onSelectCommand={onSelectCommand} />); });
    const input = renderer.root.findByType('input');
    act(() => input.props.onChange({ target: { value: 'new' } }));
    expect(onSelectCommand).not.toHaveBeenCalled();
    act(() => {
      if (method === 'Enter') input.props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() });
      else renderer.root.findByType('button').props.onClick();
    });
    expect(onSelectCommand).toHaveBeenCalledExactlyOnceWith('new-card');
    expect(action).toHaveBeenCalledOnce();
    expect(onRunItem).toHaveBeenCalledOnce();
    expect(order).toEqual(['new-card', 'close', 'open-dialog']);
    act(() => renderer.unmount());
  });

  it('does not count navigation or dismissal and retains keyboard selection behavior', () => {
    const onSelectCommand = vi.fn();
    const onClose = vi.fn();
    const action = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<CommandPalette open items={[{ id: 'a', title: 'A', action }, { id: 'b', title: 'B', action }]} onClose={onClose} onSelectCommand={onSelectCommand} />); });
    const input = renderer.root.findByType('input');
    const key = (value: string) => act(() => input.props.onKeyDown({ key: value, preventDefault: vi.fn() }));
    key('ArrowDown');
    expect(renderer.root.findAllByType('button')[1].props.className).toContain('selected');
    key('ArrowUp');
    key('Escape');
    act(() => renderer.root.findByProps({ className: 'paletteBackdrop' }).props.onMouseDown());
    expect(onSelectCommand).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    key('Enter');
    expect(onSelectCommand).toHaveBeenCalledExactlyOnceWith('a');
    expect(action).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });
});
