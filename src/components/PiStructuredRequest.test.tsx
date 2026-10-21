import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiUiRequest } from '../pi/types';
import { PiStructuredRequest } from './PiStructuredRequest';

function request(method: 'confirm' | 'select', options: string[] = []): PiUiRequest & { method: 'confirm' | 'select' } {
  return { id: `request-${method}`, method, title: 'Choose wisely', message: 'A little context', prefill: '', options };
}
let renderer: TestRenderer.ReactTestRenderer;
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(() => { act(() => renderer?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('PiStructuredRequest', () => {
  it('delays Yes, leaves No and Escape available, and preserves exact payloads', () => {
    const onRespond = vi.fn();
    act(() => { renderer = TestRenderer.create(<PiStructuredRequest request={request('confirm')} onRespond={onRespond} />); });
    const buttons = () => renderer.root.findAllByType('button');
    expect(buttons()[0].props['aria-label']).toBe('Choose wisely: Yes (2)');
    expect(buttons()[0].props.disabled).toBe(true);
    buttons()[0].props.onClick();
    expect(onRespond).not.toHaveBeenCalled();
    buttons()[1].props.onClick();
    expect(onRespond).toHaveBeenLastCalledWith('request-confirm', { confirmed: false });
    act(() => { vi.advanceTimersByTime(2000); });
    buttons()[0].props.onClick();
    expect(onRespond).toHaveBeenLastCalledWith('request-confirm', { confirmed: true });
    renderer.root.findByType('section').props.onKeyDown({ key: 'Escape', preventDefault: vi.fn() });
    expect(onRespond).toHaveBeenLastCalledWith('request-confirm', { confirmed: false });
    act(() => { renderer.update(<PiStructuredRequest request={{ ...request('confirm'), id: 'new' }} onRespond={onRespond} />); });
    expect(buttons()[0].props.disabled).toBe(true);
  });

  it('does not delay ordinary select options', () => {
    const onRespond = vi.fn();
    act(() => { renderer = TestRenderer.create(<PiStructuredRequest request={request('select', ['Alpha', 'Beta'])} onRespond={onRespond} />); });
    const buttons = renderer.root.findAllByType('button');
    expect(buttons.map((button) => button.props.children)).toEqual(['Alpha', 'Beta']);
    buttons[1].props.onClick();
    expect(onRespond).toHaveBeenCalledWith('request-select', { value: 'Beta' });
  });
});
