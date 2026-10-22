import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMAND_USAGE, incrementCommandUsage, normalizeCommandUsage, rankEmptyQueryCommands } from './commandPaletteUsage';
import { resolveAppSettings, toPersistedAppSettings } from './settingsModel';
import { filterPaletteItems, type PaletteItem } from './components/CommandPalette';

const command = (id: string, title = id): PaletteItem => ({ id, title, action: () => {} });
const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe('command usage history', () => {
  it('seeds only absent history, not existing empty or partial maps', () => {
    expect(resolveAppSettings(null).command_usage_counts).toEqual(DEFAULT_COMMAND_USAGE);
    expect(resolveAppSettings({}).command_usage_counts).toEqual(DEFAULT_COMMAND_USAGE);
    expect(resolveAppSettings({ command_usage_counts: {} }).command_usage_counts).toEqual({});
    expect(normalizeCommandUsage({ custom: 4 })).toEqual({ custom: 4 });
    expect(normalizeCommandUsage([])).toEqual({});
    expect(normalizeCommandUsage('bad')).toEqual({});
  });

  it('normalizes invalid counts and safely increments new and existing IDs', () => {
    expect(normalizeCommandUsage({ a: -1, b: NaN, c: Infinity, d: '4', e: null, f: 3.9, g: 1e30 }))
      .toEqual({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 3, g: Number.MAX_SAFE_INTEGER });
    const original = { unavailable: 8 };
    const next = incrementCommandUsage(incrementCommandUsage(original, 'new'), 'new');
    expect(next).toEqual({ unavailable: 8, new: 2 });
    expect(original).toEqual({ unavailable: 8 });
    expect(incrementCommandUsage({}, 'constructor')).toEqual({ constructor: 1 });
    expect(incrementCommandUsage({ max: Number.MAX_SAFE_INTEGER }, 'max').max).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('round-trips history without reseeding or losing unavailable commands or unrelated settings', () => {
    for (const counts of [{}, { unavailable: 12, 'pane:abc': 3 }, DEFAULT_COMMAND_USAGE]) {
      const settings = resolveAppSettings({ command_usage_counts: counts, editor_app: 'custom' });
      const restored = resolveAppSettings(JSON.parse(JSON.stringify(toPersistedAppSettings(settings))));
      expect(restored.command_usage_counts).toEqual(counts);
      expect(restored.editor_app).toBe('custom');
    }
  });
});

describe('empty-query command ranking', () => {
  it('puts the seeded commands first and the remainder alphabetically', () => {
    const items = [command('z'), command('release-project', 'Open Release'), command('a'), command('new-card', 'New card'), command('direct-project-work', 'Open Project Workspace')];
    expect(ids(rankEmptyQueryCommands(items, DEFAULT_COMMAND_USAGE))).toEqual(['direct-project-work', 'new-card', 'release-project', 'a', 'z']);
    expect(items[0].id).toBe('z');
  });

  it('breaks frequency ties by displayed title, replaces the top three, and sorts the remainder alphabetically', () => {
    const items = [command('z'), command('a'), command('b'), command('d'), command('c'), command('e')];
    expect(ids(rankEmptyQueryCommands(items, { z: 9, d: 4, c: 4, e: 1, unavailable: 100 })))
      .toEqual(['z', 'c', 'd', 'a', 'b', 'e']);
    expect(ids(rankEmptyQueryCommands(items, {}))).toEqual(['a', 'b', 'c', 'd', 'e', 'z']);
    expect(rankEmptyQueryCommands([], {})).toEqual([]);
    expect(ids(rankEmptyQueryCommands([command('new')], { unavailable: 100 }))).toEqual(['new']);
  });

  it('ranks before limiting to 12 and treats whitespace as empty', () => {
    const items = Array.from({ length: 16 }, (_, i) => command(`item-${String(i).padStart(2, '0')}`));
    const history = { 'item-15': 10 };
    const results = filterPaletteItems(items, [], '  ', history);
    expect(results).toHaveLength(12);
    expect(ids(results)).toEqual(['item-15', ...ids(items.slice(0, 11))]);
    expect(new Set(ids(results)).size).toBe(12);
  });

  it('never changes typed-search relevance or source ties and keeps cards unaffected', () => {
    const items = [command('z', 'Search Zebra'), command('a', 'Search Alpha'), command('exact', 'Search')];
    const card: PaletteItem = { ...command('card:89', '#89 Search'), kind: 'card', cardNumber: '89' };
    const history = { a: 1000, z: 1 };
    expect(ids(filterPaletteItems(items, [card], 'Search', history))).toEqual(ids(filterPaletteItems(items, [card], 'Search', {})));
    expect(ids(filterPaletteItems(items, [card], 'Search', history)).slice(0, 3)).toEqual(['z', 'a', 'exact']);
    expect(filterPaletteItems(items, [card], '89', history)[0]).toBe(card);
    expect(filterPaletteItems(items, [card], '', history)).not.toContain(card);
  });
});
