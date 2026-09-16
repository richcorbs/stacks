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
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<CommandPalette open items={[command]} cardItems={[card(action)]} onClose={onClose} />);
    });
    const input = renderer.root.findByType('input');
    act(() => input.props.onChange({ target: { value: '89' } }));

    act(() => {
      if (method === 'Enter') input.props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() });
      else renderer.root.findByType('button').props.onClick();
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
  });
});
