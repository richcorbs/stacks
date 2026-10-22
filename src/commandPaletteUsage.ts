export type CommandUsageCounts = Record<string, number>;

export const DEFAULT_COMMAND_USAGE: CommandUsageCounts = {
  'direct-project-work': 3,
  'new-card': 2,
  'release-project': 1,
};

/** Null/missing means no history; an existing empty or malformed map must not reseed. */
export function normalizeCommandUsage(value: unknown): CommandUsageCounts {
  if (value == null) return { ...DEFAULT_COMMAND_USAGE };
  if (typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([id, count]) => [id,
    typeof count === 'number' && Number.isFinite(count) && count >= 0
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(count)) : 0,
  ]));
}

export function incrementCommandUsage(counts: CommandUsageCounts, id: string): CommandUsageCounts {
  const normalized = normalizeCommandUsage(counts);
  const count = Object.hasOwn(normalized, id) ? normalized[id] : 0;
  return { ...normalized, [id]: Math.min(Number.MAX_SAFE_INTEGER, count + 1) };
}

/** Only rank currently available commands; never mutate their search source order. */
export function rankEmptyQueryCommands<T extends { id: string; title: string }>(items: T[], usage: CommandUsageCounts): T[] {
  const counts = normalizeCommandUsage(usage);
  const count = (id: string) => Object.hasOwn(counts, id) ? counts[id] : 0;
  const alphabetical = (a: T, b: T) => a.title.localeCompare(b.title);
  const top = [...items].sort((a, b) => count(b.id) - count(a.id) || alphabetical(a, b)).slice(0, 3);
  const topIds = new Set(top.map((item) => item.id));
  return [...top, ...items.filter((item) => !topIds.has(item.id)).sort(alphabetical)];
}
