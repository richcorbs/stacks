import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ExternalHtmlLinks } from './ExternalLink';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('sanitized provider HTML links', () => {
  beforeEach(() => { vi.mocked(invoke).mockReset().mockResolvedValue(undefined); });

  it.each(['https://example.com/card', '/relative', 'mailto:test@example.com', 'javascript:bad()'])('delegates nested anchor activations safely: %s', async (href) => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<ExternalHtmlLinks html={`<a href="${href}" title="Card"><strong>Card</strong></a>`} />); });
    const div = renderer.root.findByType('div');
    const anchor = { getAttribute: () => href };
    const event = {
      target: { closest: () => anchor }, currentTarget: { contains: () => true },
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
    };
    for (const [handler, fields] of [['onClick', { button: 0, metaKey: true }], ['onAuxClick', { button: 1 }], ['onKeyDown', { key: 'Enter' }]] as const) {
      vi.mocked(invoke).mockClear();
      event.preventDefault.mockClear();
      await act(async () => div.props[handler]({ ...event, ...fields }));
      expect(event.preventDefault).toHaveBeenCalledOnce();
      if (href.startsWith('https://')) expect(invoke).toHaveBeenCalledExactlyOnceWith('open_url', { url: href });
      else expect(invoke).not.toHaveBeenCalled();
    }
    act(() => renderer.unmount());
  });

  it('does not intercept non-link content', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<ExternalHtmlLinks html="<p>Text</p>" />); });
    const event = { target: { closest: () => null }, preventDefault: vi.fn() };
    renderer.root.findByType('div').props.onClick(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
