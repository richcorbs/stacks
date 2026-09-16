import { describe, expect, it } from 'vitest';
import { filterPaletteItems, scorePaletteItem, type PaletteItem } from './CommandPalette';

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

  it('matches settings keywords', () => {
    expect(scorePaletteItem({ id: 'settings', title: 'Settings', keywords: 'preferences config', action: () => {} }, 'pref')).toBeGreaterThan(0);
  });

  it('keeps an empty query command-only and restores it after clearing', () => {
    const commands = [item];
    const cards: PaletteItem[] = [{ id: 'card:89', kind: 'card', cardNumber: '89', title: '#89 Palette search', searchText: '89 Palette search', action: () => {} }];
    expect(filterPaletteItems(commands, cards, '')).toEqual(commands);
    expect(filterPaletteItems(commands, cards, '89')).toEqual(cards);
    expect(filterPaletteItems(commands, cards, '   ')).toEqual(commands);
  });

  it('ranks exact card numbers first and caps combined results at 12', () => {
    const commands = Array.from({ length: 12 }, (_, index): PaletteItem => ({ id: `command-${index}`, title: `Command 89 ${index}`, action: () => {} }));
    const exact: PaletteItem = { id: 'card:89', kind: 'card', cardNumber: '89', title: '#89 Search cards', searchText: '89 Search cards', action: () => {} };
    const results = filterPaletteItems(commands, [exact], '89');
    expect(results[0]).toBe(exact);
    expect(results).toHaveLength(12);
  });
});
