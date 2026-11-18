import { showAppToast } from '../applicationEvents';
import { createElement, Fragment, memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import createDOMPurify, { type Config, type DOMPurify, type WindowLike } from 'dompurify';
import { Marked, type Token } from 'marked';
import { ExternalLink } from './ExternalLink';
import { normalizeClipboardText } from '../clipboard';

// The chat renderer parses model/Superthread output, so its allowlist is deliberately
// independent from the separate Superthread HTML path in CardOverview.
const chatTagNames = [
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'input', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'small', 'span', 'strong', 'sub',
  'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
] as const;

const chatStrippedTagNames = [
  'audio', 'canvas', 'embed', 'iframe', 'img', 'math', 'object', 'picture', 'script', 'source',
  'style', 'svg', 'video',
] as const;

/** Attribute allowlist, mirroring the old rehype-sanitize schema exactly. */
const chatAttributes: Record<string, readonly string[]> = {
  a: ['href', 'title'],
  code: ['class'],
  input: ['type', 'checked', 'disabled'],
  li: ['class'],
  ol: ['start'],
  table: ['class'],
  td: ['align'],
  th: ['align'],
  ul: ['class'],
};

/** The single source of truth for chat Markdown sanitisation parity tests. */
export const chatMarkdownPolicy = {
  tagNames: chatTagNames,
  attributes: chatAttributes,
  strip: chatStrippedTagNames,
  protocols: ['http', 'https', 'mailto'],
} as const;

const chatAllowedAttributes = [...new Set(Object.values(chatAttributes).flat())];
const chatAllowedTags = new Set<string>(chatTagNames);
const chatStrippedTags = new Set<string>(chatStrippedTagNames);
const chatClassNames: Record<string, (value: string) => boolean> = {
  code: (value) => /^language-[A-Za-z0-9_+.-]+$/.test(value),
  li: (value) => value === 'task-list-item',
  table: (value) => value === 'contains-task-list',
  ul: (value) => value === 'contains-task-list',
};
const textAlignments = new Set(['left', 'right', 'center', 'justify']);
const maxMarkdownDepth = 100;
const codeLanguage = /^[A-Za-z0-9_+.-]+$/;

const markdownParser = new Marked({ gfm: true });

type MarkdownToken = Token & {
  checked?: boolean;
  depth?: number;
  href?: string;
  lang?: string;
  ordered?: boolean;
  start?: number | '';
  text?: string;
  title?: string | null;
  tokens?: Token[];
  items?: MarkdownToken[];
  header?: Array<{ align?: string | null; text: string; tokens: Token[] }>;
  rows?: Array<Array<{ align?: string | null; text: string; tokens: Token[] }>>;
  task?: boolean;
};

function enforceChatAttributes(element: Element) {
  const tag = element.tagName.toLowerCase();
  const allowed = chatAttributes[tag];
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (!allowed?.includes(name)) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (name === 'class') {
      const className = chatClassNames[tag];
      const values = attribute.value.split(/\s+/).filter((value) => value && className?.(value));
      if (values.length) element.setAttribute('class', values.join(' '));
      else element.removeAttribute('class');
    } else if (name === 'type' && tag === 'input' && attribute.value.toLowerCase() !== 'checkbox') {
      element.removeAttribute(attribute.name);
    } else if (name === 'href' && !/^(?:https?|mailto):/i.test(attribute.value)) {
      element.removeAttribute(attribute.name);
    } else if (name === 'align' && !textAlignments.has(attribute.value.toLowerCase())) {
      element.removeAttribute(attribute.name);
    }
  }
}

function createChatPurifier(root?: WindowLike): DOMPurify {
  const instance = root ? createDOMPurify(root) : createDOMPurify();
  if (typeof instance.sanitize === 'function') {
    instance.addHook('afterSanitizeAttributes', enforceChatAttributes);
  }
  return instance;
}

// Create the purifier when the module loads, while the app/test DOM is still the
// real document. Some tests replace the global window with a partial stub later.
let purifier: DOMPurify | null = typeof window === 'undefined' ? null : createChatPurifier(window as unknown as WindowLike);

function getPurifier(): DOMPurify {
  if (!purifier) purifier = createChatPurifier(typeof window === 'undefined' ? undefined : window as unknown as WindowLike);
  if (typeof purifier.sanitize !== 'function') {
    throw new Error('PiMarkdown requires a DOM-capable environment to sanitize raw HTML.');
  }
  return purifier;
}

/** Sanitize a raw HTML fragment before it is converted to React elements. */
function sanitizeHtml(html: string): DocumentFragment {
  return getPurifier().sanitize(html, {
    ALLOWED_TAGS: [...chatTagNames],
    ALLOWED_ATTR: chatAllowedAttributes,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    // DOMPurify applies this to every attribute, so keep its permissive non-URI
    // branch and restrict actual URL protocols in the per-tag hook above.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
    FORBID_TAGS: [...chatStrippedTagNames],
    ADD_FORBID_CONTENTS: [...chatStrippedTagNames],
    RETURN_DOM_FRAGMENT: true,
  } satisfies Config);
}

function attribute(element: Element, name: string): string | null {
  return element.getAttribute(name);
}

function hasClass(element: Element, name: string): boolean {
  return (attribute(element, 'class') ?? '').split(/\s+/).includes(name);
}

function taskItem(element: Element): boolean {
  return hasClass(element, 'task-list-item')
    || Array.from(element.children).some((child) => child.tagName === 'INPUT'
      && attribute(child, 'type')?.toLowerCase() === 'checkbox');
}

function taskList(element: Element): boolean {
  return hasClass(element, 'contains-task-list')
    || Array.from(element.children).some((child) => child.tagName === 'LI' && taskItem(child));
}

function elementProps(element: Element, tag: string): Record<string, unknown> {
  switch (tag) {
    case 'a': {
      const props: Record<string, unknown> = {};
      const href = attribute(element, 'href');
      const title = attribute(element, 'title');
      if (href !== null) props.href = href;
      if (title !== null) props.title = title;
      return props;
    }
    case 'code': {
      const language = (attribute(element, 'class') ?? '').split(/\s+/).find((value) => value.startsWith('language-'));
      return language ? { className: language } : {};
    }
    case 'input': {
      const props: Record<string, unknown> = {};
      if (attribute(element, 'type')?.toLowerCase() === 'checkbox') props.type = 'checkbox';
      if (element.hasAttribute('checked')) props.checked = true;
      if (element.hasAttribute('disabled')) props.disabled = true;
      return props;
    }
    case 'li':
      return taskItem(element) ? { className: 'task-list-item' } : {};
    case 'ul':
      return taskList(element) ? { className: 'contains-task-list' } : {};
    case 'table':
      return hasClass(element, 'contains-task-list') ? { className: 'contains-task-list' } : {};
    case 'ol': {
      const start = attribute(element, 'start');
      return start && /^\d+$/.test(start) ? { start: Number(start) } : {};
    }
    case 'td':
    case 'th': {
      const align = attribute(element, 'align')?.toLowerCase();
      return align && textAlignments.has(align) ? { style: { textAlign: align } } : {};
    }
    default:
      return {};
  }
}

function convertChildren(parent: Node, path: string, depth: number): ReactNode[] {
  return Array.from(parent.childNodes).flatMap((node, index) => {
    const child = convertNode(node, `${path}.${index}`, depth);
    return child === null ? [] : [child];
  });
}

/** Convert an already-sanitized HTML fragment into React elements. */
function convertNode(node: Node, path: string, depth: number): ReactNode {
  if (node.nodeType === 3) return node.nodeValue;
  if (node.nodeType !== 1 || depth > maxMarkdownDepth) return null;
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  // Defensive parity with the sanitizer: never construct an element outside the list.
  if (!chatAllowedTags.has(tag) || chatStrippedTags.has(tag)) return null;
  const children = convertChildren(element, path, depth + 1);
  if (tag === 'a') return <ExternalLink key={path} {...elementProps(element, tag)}>{children}</ExternalLink>;
  if (tag === 'pre') return <MarkdownCodeBlock key={path}>{children}</MarkdownCodeBlock>;
  return createElement(tag, { key: path, ...elementProps(element, tag) }, ...children);
}

function sanitizedNodes(html: string, path: string): ReactNode[] {
  return convertChildren(sanitizeHtml(html), path, 0);
}

function containsHtml(tokens: Token[]): boolean {
  return tokens.some((token) => {
    if (token.type === 'html' || token.type === 'tag') return true;
    const nested = (token as { tokens?: Token[] }).tokens;
    return Array.isArray(nested) && containsHtml(nested);
  });
}

function inlineFallback(raw: string, path: string): ReactNode[] {
  return sanitizedNodes(markdownParser.parseInline(raw, { async: false }), path);
}

/** Render inline tokens. Most chat output stays on the React path; raw HTML takes the
 * sanitizer fallback for that inline run only, so streaming never sanitizes the whole
 * growing document. */
function renderInline(tokens: Token[] | undefined, raw: string, path: string): ReactNode[] {
  const inline = tokens ?? [];
  if (containsHtml(inline)) return [<Fragment key={path}>{inlineFallback(raw, path)}</Fragment>];
  return inline.flatMap((token, index) => {
    const child = renderInlineToken(token as MarkdownToken, `${path}.${index}`);
    return child === null ? [] : [child];
  });
}

function inlineChildren(token: MarkdownToken, path: string): ReactNode[] {
  return renderInline(token.tokens, token.text ?? token.raw ?? '', path);
}

function renderInlineToken(token: MarkdownToken, path: string): ReactNode {
  switch (token.type) {
    case 'text':
      if (token.tokens) return <Fragment key={path}>{inlineChildren(token, path)}</Fragment>;
      return token.text ?? '';
    case 'escape':
      return token.text ?? '';
    case 'strong':
      return <strong key={path}>{inlineChildren(token, path)}</strong>;
    case 'em':
      return <em key={path}>{inlineChildren(token, path)}</em>;
    case 'del':
      return <del key={path}>{inlineChildren(token, path)}</del>;
    case 'codespan':
      return <code key={path}>{token.text ?? ''}</code>;
    case 'br':
      return <br key={path} />;
    case 'link':
      return <ExternalLink key={path} href={token.href} title={token.title ?? undefined}>{inlineChildren(token, path)}</ExternalLink>;
    case 'image':
      return null;
    case 'html':
    case 'tag':
      // containsHtml() should have routed this inline run through the sanitizer.
      return <Fragment key={path}>{sanitizedNodes(token.text ?? token.raw, path)}</Fragment>;
    default:
      return token.text ?? null;
  }
}

function renderList(token: MarkdownToken, path: string): ReactNode {
  const items = token.items ?? [];
  const isTaskList = items.some((item) => item.task);
  const listProps: Record<string, unknown> = { key: path };
  if (isTaskList) listProps.className = 'contains-task-list';
  if (token.ordered && typeof token.start === 'number' && token.start !== 1) listProps.start = token.start;
  const children = items.map((item, index) => {
    const itemPath = `${path}.${index}`;
    const itemProps: Record<string, unknown> = { key: itemPath };
    if (item.task) itemProps.className = 'task-list-item';
    const itemChildren = renderBlocks(item.tokens ?? [], itemPath);
    if (item.task) {
      itemChildren.unshift(<input key={`${itemPath}.checkbox`} type="checkbox" disabled checked={item.checked ? true : undefined} />);
      itemChildren.splice(1, 0, ' ');
    }
    return createElement('li', itemProps, ...itemChildren);
  });
  return createElement(token.ordered ? 'ol' : 'ul', listProps, ...children);
}

function renderTable(token: MarkdownToken, path: string): ReactNode {
  const cell = (value: { align?: string | null; text: string; tokens: Token[] }, cellPath: string, heading: boolean) => {
    const props: Record<string, unknown> = { key: cellPath };
    if (value.align && textAlignments.has(value.align)) props.style = { textAlign: value.align };
    return createElement(heading ? 'th' : 'td', props, ...renderInline(value.tokens, value.text, cellPath));
  };
  const header = (token.header ?? []).map((value, index) => cell(value, `${path}.h.${index}`, true));
  const rows = (token.rows ?? []).map((row, rowIndex) => createElement(
    'tr',
    { key: `${path}.r.${rowIndex}` },
    ...row.map((value, cellIndex) => cell(value, `${path}.r.${rowIndex}.${cellIndex}`, false)),
  ));
  return <table key={path}>
    <thead><tr>{header}</tr></thead>
    <tbody>{rows}</tbody>
  </table>;
}

function renderBlock(token: MarkdownToken, path: string): ReactNode {
  switch (token.type) {
    case 'heading': {
      const depth = Math.min(6, Math.max(1, token.depth ?? 1));
      return createElement(`h${depth}`, { key: path }, ...inlineChildren(token, path));
    }
    case 'paragraph':
      return <p key={path}>{inlineChildren(token, path)}</p>;
    case 'blockquote':
      return <blockquote key={path}>{renderBlocks(token.tokens ?? [], path)}</blockquote>;
    case 'list':
      return renderList(token, path);
    case 'table':
      return renderTable(token, path);
    case 'hr':
      return <hr key={path} />;
    case 'code': {
      const language = token.lang?.split(/\s+/)[0];
      const className = language && codeLanguage.test(language) ? `language-${language}` : undefined;
      const text = token.text ?? '';
      // react-markdown's code element included the fence's trailing newline.
      const codeText = text && !text.endsWith('\n') ? `${text}\n` : text;
      return <MarkdownCodeBlock key={path}>
        <code className={className}>{codeText}</code>
      </MarkdownCodeBlock>;
    }
    case 'html':
      return <Fragment key={path}>{sanitizedNodes(token.text || token.raw, path)}</Fragment>;
    case 'text':
      return <Fragment key={path}>{inlineChildren(token, path)}</Fragment>;
    case 'space':
    case 'def':
      return null;
    default:
      return null;
  }
}

function renderBlocks(tokens: Token[], path: string): ReactNode[] {
  return tokens.flatMap((token, index) => {
    const block = renderBlock(token as MarkdownToken, `${path}.${index}`);
    return block === null ? [] : [block];
  });
}

export const PiMarkdown = memo(function PiMarkdown({ children }: { children: string }) {
  return <>{renderBlocks(markdownParser.lexer(children), 'markdown')}</>;
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
      await writeText(normalizeClipboardText(code.replace(/(?:\r?\n)+$/, '')));
      setCopied(true);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
      showAppToast('Code copied to clipboard');
    } catch (error) {
      showAppToast(`Could not copy: ${String(error)}`);
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
