export type ActivePathToken = {
  start: number;
  end: number;
  query: string;
  quoted: boolean;
};

export type TextEdit = { value: string; cursor: number };

const SAFE_PATH = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Finds the @path token containing the caret. Tokens begin at whitespace/start. */
export function activePathToken(value: string, cursor: number): ActivePathToken | null {
  const caret = Math.max(0, Math.min(cursor, value.length));
  for (let start = caret; start >= 0; start -= 1) {
    if (value[start] !== '@' || (start > 0 && !/\s/.test(value[start - 1]))) continue;
    const quoted = value[start + 1] === '"';
    if (quoted) {
      let escaped = false;
      let closing = -1;
      for (let index = start + 2; index < value.length; index += 1) {
        const character = value[index];
        if (character === '"' && !escaped) { closing = index; break; }
        escaped = character === '\\' && !escaped;
        if (character !== '\\') escaped = false;
      }
      const end = closing >= 0 ? closing + 1 : value.length;
      if (caret >= start + 2 && caret <= end) {
        return { start, end, query: unescapeQuotedPath(value.slice(start + 2, closing >= 0 ? closing : end)), quoted: true };
      }
      continue;
    }

    let end = start + 1;
    while (end < value.length && !/\s/.test(value[end])) end += 1;
    if (caret >= start + 1 && caret <= end) return { start, end, query: value.slice(start + 1, end), quoted: false };
  }
  return null;
}

export function quotePiPath(path: string): string {
  if (path && SAFE_PATH.test(path)) return path;
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function formatPathReference(path: string): string {
  return `@${quotePiPath(path)}`;
}

/** Formats a dropped absolute path relative to cwd when it is truly inside cwd. */
export function formatDroppedPathReference(path: string, cwd: string): string {
  const normalizedPath = trimTrailingSeparators(path);
  const normalizedCwd = trimTrailingSeparators(cwd);
  const inside = normalizedPath === normalizedCwd || normalizedPath.startsWith(`${normalizedCwd}/`);
  const display = inside ? (normalizedPath.slice(normalizedCwd.length + (normalizedPath === normalizedCwd ? 0 : 1)) || '.') : normalizedPath;
  return formatPathReference(display);
}

export function applyPathCompletion(value: string, token: ActivePathToken, path: string, directory: boolean): TextEdit {
  const reference = formatPathReference(directory ? `${path}/` : path);
  const suffix = directory || /\s/.test(value[token.end] ?? '') ? '' : ' ';
  const next = `${value.slice(0, token.start)}${reference}${suffix}${value.slice(token.end)}`;
  // Keep the caret inside a directory's closing quote so typing continues the path.
  const cursor = token.start + reference.length + suffix.length - (directory && reference.endsWith('"') ? 1 : 0);
  return { value: next, cursor };
}

export function insertPathReferences(value: string, start: number, end: number, references: string[]): TextEdit {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  const insertion = references.join(' ');
  const prefixSpace = insertion && from > 0 && !/\s/.test(value[from - 1]) ? ' ' : '';
  const suffixSpace = insertion && (to === value.length || !/\s/.test(value[to])) ? ' ' : '';
  const inserted = `${prefixSpace}${insertion}${suffixSpace}`;
  return { value: `${value.slice(0, from)}${inserted}${value.slice(to)}`, cursor: from + inserted.length };
}

function unescapeQuotedPath(value: string) {
  return value.replace(/\\([\\"])/g, '$1');
}

function trimTrailingSeparators(path: string) {
  if (path === '/') return path;
  return path.replace(/\/+$/, '');
}
