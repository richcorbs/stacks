import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { applicationEvents } from '../applicationEvents';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn() }));
import { PiMarkdown } from './PiMarkdown';

function render(source: string) {
  return renderToStaticMarkup(<div className="piMarkdown"><PiMarkdown>{source}</PiMarkdown></div>);
}

describe('PiMarkdown', () => {
  beforeEach(() => { vi.mocked(invoke).mockReset().mockResolvedValue(undefined); });
  it('renders Markdown, safe HTML, and mixed content together', () => {
    const markup = render('# Markdown\n\n<section><h2>HTML heading</h2><p>A <strong>mixed</strong> paragraph.</p></section>\n\n| A | B |\n| - | - |\n| 1 | 2 |');

    expect(markup).toContain('<h1>Markdown</h1>');
    // Unsupported containers are removed without discarding their safe formatted children.
    expect(markup).not.toContain('<section');
    expect(markup).toContain('<h2>HTML heading</h2>');
    expect(markup).toContain('<p>A <strong>mixed</strong> paragraph.</p>');
    expect(markup).toContain('<table>');
    expect(markup).toContain('<td>1</td>');
  });

  it('removes dangerous elements, attributes, and URL protocols', () => {
    const markup = render([
      '<script>alert("script")</script>',
      '<style>body { display: none }</style>',
      '<img src="https://example.com/tracker.png" alt="tracker">',
      '<iframe src="https://example.com"></iframe>',
      '<p onclick="alert(1)" style="color:red">Safe text</p>',
      '<a href="javascript:alert(1)" onmouseover="alert(2)">unsafe</a>',
      '<a href="data:text/html,bad">data</a>',
      '<a href="https://example.com/path" title="Safe">safe</a>',
    ].join('\n'));

    expect(markup).not.toMatch(/script|style=|onclick|onmouseover|<img|iframe|alert\(|data:text/);
    expect(markup).toContain('<p>Safe text</p>');
    expect(markup).toContain('>unsafe</a>');
    expect(markup).toContain('>data</a>');
    expect(markup).toContain('title="Safe" href="https://example.com/path"');
  });

  it('keeps HTML inside inline and fenced code literal and retains code-block copy UI', () => {
    const markup = render('Inline `<strong>literal</strong>`\n\n```html\n<img src="x" onerror="bad()">\n```');

    expect(markup).toContain('<code>&lt;strong&gt;literal&lt;/strong&gt;</code>');
    expect(markup).toContain('<code class="language-html">&lt;img src=&quot;x&quot; onerror=&quot;bad()&quot;&gt;');
    expect(markup).toContain('class="piCodeCopyButton "');
    expect(markup).toContain('aria-label="Copy code"');
  });

  it.each([
    ['single trailing LF', 'echo hello\n', 'echo hello'],
    ['single trailing CRLF', 'echo hello\r\n', 'echo hello'],
    ['repeated trailing line endings', 'echo hello\n\r\n\n', 'echo hello'],
    ['internal newlines and other content', 'echo first\r\necho second\n  echo third  \n\n', 'echo first\r\necho second\n  echo third  '],
    ['no trailing line ending', 'echo hello  ', 'echo hello  '],
  ])('copies code correctly for %s', async (_case, code, expected) => {
    vi.mocked(writeText).mockResolvedValue(undefined);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<PiMarkdown>{'```sh\necho hello\n```'}</PiMarkdown>, {
        // Supply the actual code element text, including CRLF (Markdown parsers normalize source line endings).
        createNodeMock: (element) => element.type === 'pre'
          ? { querySelector: () => ({ textContent: code }) }
          : null,
      });
    });
    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'Copy code' }).props.onClick();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(expected);
    act(() => renderer.unmount());
    vi.mocked(writeText).mockClear();
  });

  it.each([
    '[link](https://example.com/path "Title")',
    '<https://example.com/path>',
    'https://example.com/path',
    '<a href="https://example.com/path" title="Title" onclick="bad()">link</a>',
  ])('opens supported links externally for every activation: %s', async (source) => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<PiMarkdown>{source}</PiMarkdown>); });
    const link = renderer.root.findByType('a');
    const activations: [string, Record<string, unknown>][] = [
      ['onClick', { button: 0 }],
      ...['metaKey', 'ctrlKey', 'shiftKey', 'altKey'].map((modifier): [string, Record<string, unknown>] => ['onClick', { button: 0, [modifier]: true }]),
      ['onAuxClick', { button: 1 }],
      ['onKeyDown', { key: 'Enter', repeat: false }],
    ];
    for (const [handler, fields] of activations) {
      vi.mocked(invoke).mockClear();
      const event = { ...fields, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      await act(async () => { link.props[handler](event); });
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(invoke).toHaveBeenCalledExactlyOnceWith('open_url', { url: 'https://example.com/path' });
    }
    vi.mocked(invoke).mockClear();
    const event = { button: 1, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    link.props.onMouseDown(event);
    link.props.onClick(event); // Legacy engines may also dispatch click for middle button.
    link.props.onAuxClick(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    link.props.onAuxClick({ ...event, button: 2 });
    link.props.onKeyDown({ ...event, key: 'Enter', repeat: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it.each(['/docs', '#heading', '//example.com', 'mailto:test@example.com', 'javascript:alert(1)', 'data:text/html,bad', 'file:///tmp/test'])('never navigates or launches unsupported links: %s', async (href) => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<PiMarkdown>{`<a href="${href}">text</a>`}</PiMarkdown>); });
    const link = renderer.root.findByType('a');
    expect(link.props.href).toBeUndefined();
    for (const [handler, fields] of [['onClick', { button: 0 }], ['onAuxClick', { button: 1 }], ['onKeyDown', { key: 'Enter' }]] as const) {
      const event = { ...fields, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      await act(async () => { link.props[handler](event); });
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    expect(invoke).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('uses updated streaming destinations and reports launch failures without navigating', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<PiMarkdown>{'[link](https://example.com/old)'}</PiMarkdown>); });
    act(() => renderer.update(<PiMarkdown>{'[link](https://example.com/new)'}</PiMarkdown>));
    vi.mocked(invoke).mockRejectedValueOnce('browser unavailable');
    const toast = vi.fn();
    const unsubscribe = applicationEvents.subscribe('toast', toast);
    const event = { button: 0, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    await act(async () => { renderer.root.findByType('a').props.onClick(event); });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('open_url', { url: 'https://example.com/new' });
    expect(toast).toHaveBeenCalledWith({ message: 'Could not open link: browser unavailable', duration: 5000 });
    expect(renderer.root.findByType('a').children).toEqual(['link']);
    unsubscribe();
    act(() => renderer.unmount());
  });

  it('keeps unsupported link text but removes navigable destinations', () => {
    const markup = render('[relative](/docs) <a href="mailto:test@example.com">email</a> <a href="http://example.com">web</a>');

    expect(markup).not.toContain('href="/docs"');
    expect(markup).not.toContain('href="mailto:test@example.com"');
    expect(markup).toContain('href="http://example.com"');
  });
});
