import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn() }));
import { PiMarkdown } from './PiMarkdown';

function render(source: string) {
  return renderToStaticMarkup(<div className="piMarkdown"><PiMarkdown>{source}</PiMarkdown></div>);
}

describe('PiMarkdown', () => {
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
    expect(markup).toContain('<a>unsafe</a>');
    expect(markup).toContain('<a>data</a>');
    expect(markup).toContain('<a href="https://example.com/path" title="Safe">safe</a>');
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

  it('supports safe relative, web, and email links', () => {
    const markup = render('[relative](/docs) <a href="mailto:test@example.com">email</a> <a href="http://example.com">web</a>');

    expect(markup).toContain('href="/docs"');
    expect(markup).toContain('href="mailto:test@example.com"');
    expect(markup).toContain('href="http://example.com"');
  });
});
