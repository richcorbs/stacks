import { describe, expect, it } from 'vitest';
import { applyTerminalAppearance, terminalAppearanceOptions } from './terminalAppearance';

describe('shell terminal appearance', () => {
  it('retains the exact original inactive theme and default contrast', () => {
    expect(terminalAppearanceOptions(false)).toEqual({
      theme: {
        background: '#0f141b', foreground: '#d6deeb', cursor: '#80cbc4',
        selectionBackground: '#fff7ed', selectionForeground: '#111827', selectionInactiveBackground: '#fed7aa',
      },
      minimumContrastRatio: 1,
    });
  });

  it('changes only text foreground and contrast, not backgrounds, selection or cursor', () => {
    const inactive = terminalAppearanceOptions(false);
    const active = terminalAppearanceOptions(true);
    expect(active.theme).toEqual({ ...inactive.theme, foreground: '#f0f4fc' });
    expect(active.minimumContrastRatio).toBe(7);
  });

  it('reversibly updates existing options without touching font, scrollback or cursor behavior', () => {
    const term = { options: { ...terminalAppearanceOptions(false), fontSize: 14, scrollback: 100, cursorBlink: true } };
    const original = structuredClone(term.options);
    applyTerminalAppearance(term, true);
    expect(term.options).toEqual({ ...original, ...terminalAppearanceOptions(true) });
    const theme = term.options.theme;
    applyTerminalAppearance(term, true);
    expect(term.options.theme).toBe(theme);
    applyTerminalAppearance(term, false);
    expect(term.options).toEqual(original);
  });
});
