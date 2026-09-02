import type { Terminal } from '@xterm/xterm';
import type { TermSize } from './types';

export function safeTermSize(term: Terminal): TermSize {
  return {
    cols: Math.max(2, (term.cols || 80) - 1),
    rows: Math.max(2, term.rows || 24),
  };
}
