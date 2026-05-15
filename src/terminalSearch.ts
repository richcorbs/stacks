import type { Terminal } from '@xterm/xterm';

export function countSearchMatchesInLines(lines: string[], query: string) {
  if (!query) return 0;
  const needle = query.toLowerCase();
  let count = 0;
  for (const rawLine of lines) {
    const line = rawLine.toLowerCase();
    let index = line.indexOf(needle);
    while (index >= 0) {
      count += 1;
      index = line.indexOf(needle, index + Math.max(1, needle.length));
    }
  }
  return count;
}

export function countSearchMatches(term: Terminal, query: string) {
  const lines: string[] = [];
  for (let i = 0; i < term.buffer.active.length; i += 1) {
    lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? '');
  }
  return countSearchMatchesInLines(lines, query);
}
