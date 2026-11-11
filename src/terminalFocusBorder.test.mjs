import { declarationsFor as cssDeclarations } from './test/cssParser.mjs';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('split terminal focus border', () => {
  it('keeps the same border width on active and inactive split panes', () => {
    expect(cssDeclarations(css, '.cardTerminalPane.multiple .terminal')).toContain('border: 1px solid transparent !important');
    expect(cssDeclarations(css, '.cardTerminalPane.multiple .terminal.active')).toContain('border-color: var(--focused-terminal-border, #3b82f6) !important');
    expect(cssDeclarations(css, '.cardTerminalPane.multiple .terminal.active.maximized')).toContain('border-color: var(--maximized-terminal-border, #84cc16) !important');
  });
});
