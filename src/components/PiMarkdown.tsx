import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import Markdown, { type Components } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

const chatSanitizationSchema: NonNullable<Parameters<typeof rehypeSanitize>[0]> = {
  tagNames: [
    'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'i', 'input', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'small', 'span', 'strong', 'sub',
    'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
  ],
  attributes: {
    a: ['href', 'title'],
    code: [['className', /^language-/]],
    input: [['type', 'checkbox'], 'checked', 'disabled'],
    li: [['className', 'task-list-item']],
    ol: ['start'],
    table: [['className', 'contains-task-list']],
    td: ['align'],
    th: ['align'],
    ul: [['className', 'contains-task-list']],
  },
  protocols: {
    href: ['http', 'https', 'mailto'],
  },
  strip: ['audio', 'canvas', 'embed', 'iframe', 'img', 'math', 'object', 'picture', 'script', 'source', 'style', 'svg', 'video'],
};

const markdownComponents: Components = {
  pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>,
};

export const PiMarkdown = memo(function PiMarkdown({ children }: { children: string }) {
  return <Markdown
    remarkPlugins={[remarkGfm]}
    rehypePlugins={[rehypeRaw, [rehypeSanitize, chatSanitizationSchema]]}
    components={markdownComponents}
  >{children}</Markdown>;
});

function MarkdownCodeBlock({ children }: { children: ReactNode }) {
  const preRef = useRef<HTMLPreElement | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);

  async function copyCode() {
    const code = preRef.current?.querySelector('code')?.textContent ?? preRef.current?.textContent ?? '';
    try {
      await writeText(code);
      setCopied(true);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: 'Code copied to clipboard' } }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: `Could not copy: ${String(error)}` } }));
    }
  }

  return <div className="piCodeBlock">
    <pre ref={preRef}>{children}</pre>
    <button
      className={`piCodeCopyButton ${copied ? 'copied' : ''}`}
      type="button"
      aria-label={copied ? 'Code copied' : 'Copy code'}
      title={copied ? 'Copied' : 'Copy code'}
      onClick={() => copyCode().catch(console.error)}
    >
      {copied
        ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
        : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></svg>}
    </button>
  </div>;
}
