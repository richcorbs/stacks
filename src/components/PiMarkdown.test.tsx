// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { applicationEvents } from '../applicationEvents';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn() }));
import { PiMarkdown, chatMarkdownPolicy } from './PiMarkdown';

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
    ['internal newlines and other content', 'echo first\r\necho second\n  echo third  \n\n', 'echo first\necho second\n  echo third  '],
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

  it('documents the exact chat sanitisation allowlist', () => {
    expect([...chatMarkdownPolicy.tagNames]).toEqual([
      'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'hr', 'i', 'input', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'small', 'span', 'strong', 'sub',
      'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
    ]);
    expect(chatMarkdownPolicy.attributes).toEqual({
      a: ['href', 'title'],
      code: ['class'],
      input: ['type', 'checked', 'disabled'],
      li: ['class'],
      ol: ['start'],
      table: ['class'],
      td: ['align'],
      th: ['align'],
      ul: ['class'],
    });
    expect([...chatMarkdownPolicy.strip]).toEqual([
      'audio', 'canvas', 'embed', 'iframe', 'img', 'math', 'object', 'picture', 'script', 'source',
      'style', 'svg', 'video',
    ]);
    expect([...chatMarkdownPolicy.protocols]).toEqual(['http', 'https', 'mailto']);
  });

  it('renders GFM tables, task lists, strikethrough, and autolinks', () => {
    const markup = render([
      '| Left | Center | Right |',
      '| :--- | :----: | ----: |',
      '| a | b | c |',
      '',
      '- [ ] todo',
      '- [x] done',
      '',
      '~~gone~~ <https://example.com/path>',
    ].join('\n'));

    expect(markup).toContain('<table>');
    expect(markup).toContain('<th style="text-align:left">Left</th>');
    expect(markup).toContain('<th style="text-align:center">Center</th>');
    expect(markup).toContain('<th style="text-align:right">Right</th>');
    expect(markup).toContain('<td style="text-align:left">a</td>');
    expect(markup).toContain('<ul class="contains-task-list">');
    expect(markup).toContain('<li class="task-list-item"><input type="checkbox" disabled=""/> todo</li>');
    expect(markup).toContain('<li class="task-list-item"><input type="checkbox" disabled="" checked=""/> done</li>');
    expect(markup).toContain('<del>gone</del>');
    expect(markup).toContain('href="https://example.com/path"');
  });

  it('preserves every allowed tag and attribute while dropping extra classes', () => {
    const markup = render([
      '<a href="https://example.com/a" title="Safe">link</a>',
      '<code class="language-js javascript">x</code>',
      '<input type="checkbox" checked disabled>',
      '<ul class="contains-task-list extra"><li class="task-list-item other">item</li></ul>',
      '<ol start="3"><li>three</li></ol>',
      '<table class="contains-task-list extra"><tbody><tr><td align="right">r</td><th align="center">c</th></tr></tbody></table>',
      '<div><span><mark>m</mark> <kbd>K</kbd> <sub>s</sub> <sup>s</sup> <small>s</small> <u>u</u> <s>s</s> <i>i</i> <b>b</b></span></div>',
      '<blockquote><p>quote</p></blockquote><hr><br>',
      '<h1>h1</h1><h2>h2</h2><h3>h3</h3><h4>h4</h4><h5>h5</h5><h6>h6</h6>',
    ].join('\n'));

    expect(markup).toContain('href="https://example.com/a"');
    expect(markup).toContain('title="Safe"');
    expect(markup).toContain('<code class="language-js">x</code>');
    expect(markup).not.toContain('javascript');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('checked=""');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('<ul class="contains-task-list">');
    expect(markup).toContain('<li class="task-list-item">item</li>');
    expect(markup).toContain('<ol start="3">');
    expect(markup).toContain('<table class="contains-task-list">');
    expect(markup).toContain('<td style="text-align:right">r</td>');
    expect(markup).toContain('<th style="text-align:center">c</th>');
    for (const tag of ['mark', 'kbd', 'sub', 'sup', 'small', 'u', 's', 'i', 'b', 'blockquote', 'hr', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      expect(markup).toContain(`<${tag}`);
    }
    expect(markup).not.toContain('extra');
    expect(markup).not.toContain('other');
  });

  it('strips the documented dangerous tags, attributes, and protocols', () => {
    const markup = render([
      '<script>script text</script>',
      '<style>style text</style>',
      '<iframe src="https://example.com">iframe text</iframe>',
      '<img src="https://example.com/tracker.png" onerror="img text">',
      '<svg onload="svg text"><text>svg child</text></svg>',
      '<math><mtext>math child</mtext></math>',
      '<object data="x">object text</object>',
      '<embed src="x">embed text</embed>',
      '<video>video text</video>',
      '<audio>audio text</audio>',
      '<picture>picture text</picture>',
      '<source src="x">source text</source>',
      '<canvas>canvas text</canvas>',
      '<a href="javascript:alert(1)">js</a>',
      '<a href="data:text/html,bad">data</a>',
      '<a href="vbscript:msgbox(1)">vb</a>',
      '<a href="https://safe.example/path" onclick="bad()" style="color:red">safe</a>',
      '<div onmouseover="bad()" style="color:red">div text</div>',
      '<section>unknown tag text</section>',
    ].join('\n'));

    expect(markup).not.toMatch(/script|style=|onerror|onload|onclick|onmouseover|javascript:|data:text|vbscript:/i);
    for (const removed of ['script text', 'style text', 'iframe text', 'svg child', 'math child', 'object text', 'video text', 'audio text', 'picture text', 'canvas text']) {
      expect(markup).not.toContain(removed);
    }
    expect(markup).toContain('>js</a>');
    expect(markup).toContain('>data</a>');
    expect(markup).toContain('>vb</a>');
    expect(markup).toContain('href="https://safe.example/path"');
    expect(markup).toContain('div text');
    // Unknown block tags are removed but their safe children are retained.
    expect(markup).toContain('unknown tag text');
  });

  it('sanitizes inline HTML inside a Markdown paragraph', () => {
    const markup = render('Before <span onclick="bad()" class="evil">inside <strong>bold</strong></span> after <a href="javascript:alert(1)">bad</a>.');

    expect(markup).toContain('<p>Before <span>inside <strong>bold</strong></span> after <a role="link" tabindex="0">bad</a>.</p>');
    expect(markup).not.toMatch(/onclick|class="evil"|javascript:/);
  });

  it('bounds deeply nested hostile markup without crashing', () => {
    const safeNesting = `${'<div>'.repeat(50)}deep-safe${'</div>'.repeat(50)}`;
    expect(render(safeNesting)).toContain('deep-safe');
    expect(() => render(`${'<div>'.repeat(500)}too-deep${'</div>'.repeat(500)}`)).not.toThrow();
  });

  describe('real Pi transcript fixtures', () => {
    const fixtures = [
      'refined-card-audit.md',
      'feature-environment-spec.md',
      'ruby-architecture.md',
      'changes-summary.md',
      'encompass-research.md',
    ];
    const sources = fixtures.map((name) => readFileSync(`tests/fixtures/pi-markdown/${name}`, 'utf8'));

    it.each(fixtures)('renders %s without catastrophic content loss', (name) => {
      const source = sources[fixtures.indexOf(name)];
      const markup = render(source);
      expect(markup.length).toBeGreaterThan(source.length / 2);
      expect(markup).not.toContain('<script');
    });

    it('keeps the GFM and code-block behaviour used by real transcripts', () => {
      const markup = render(sources.join('\n\n'));
      expect(markup).toContain('<table>');
      expect(markup).toContain('class="contains-task-list"');
      expect(markup).toContain('class="task-list-item"');
      expect(markup).toContain('class="piCodeBlock"');
      expect(markup).toContain('class="language-ruby"');
      expect(markup).toContain('<blockquote>');
      expect(markup).toContain('<del>');
    });
  });
});
