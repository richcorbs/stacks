import { describe, expect, it } from 'vitest';
import { scorePaletteItem, type PaletteItem } from './CommandPalette';

const item: PaletteItem = {
  id: 'terminal-1',
  title: 'Kenna',
  subtitle: 'Stacks - Tauri',
  keywords: 'terminal project /Users/rich/Code/stacks-tauri cmd 1',
  action: () => {},
};

describe('scorePaletteItem', () => {
  it('matches title text', () => {
    expect(scorePaletteItem(item, 'ken')).toBeGreaterThan(0);
  });

  it('matches subtitle/project text', () => {
    expect(scorePaletteItem(item, 'tauri')).toBeGreaterThan(0);
  });

  it('matches fuzzy text in order', () => {
    expect(scorePaletteItem(item, 'kn')).toBeGreaterThan(0);
  });

  it('rejects fuzzy text out of order', () => {
    expect(scorePaletteItem(item, 'zk')).toBe(0);
  });
});
