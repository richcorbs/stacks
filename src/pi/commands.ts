import type { PiCommand } from './types';

export const GUI_BUILTIN_COMMANDS: PiCommand[] = [
  { name: 'new', source: 'builtin', description: 'Start a new Pi session' },
  { name: 'compact', source: 'builtin', description: 'Compact the current context; optional instructions may follow' },
];

export function isGuiBuiltinCommand(name: string) {
  return GUI_BUILTIN_COMMANDS.some((command) => command.name === name);
}

export function slashCommandQuery(value: string): string | null {
  if (!value.startsWith('/') || /\s/.test(value)) return null;
  return value.slice(1).toLowerCase();
}

export function matchingSlashCommands(commands: PiCommand[], value: string, limit = commands.length): PiCommand[] {
  const query = slashCommandQuery(value);
  if (query === null) return [];
  return commands
    .flatMap((command) => {
      const score = fuzzyCommandScore(command.name, query);
      return score === null ? [] : [{ command, score }];
    })
    .sort((left, right) => left.score - right.score || left.command.name.localeCompare(right.command.name))
    .slice(0, limit)
    .map(({ command }) => command);
}

export function fuzzyCommandScore(name: string, query: string): number | null {
  if (!query) return 0;
  const candidate = name.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  if (candidate.startsWith(normalizedQuery)) return 0;
  const substringIndex = candidate.indexOf(normalizedQuery);
  if (substringIndex >= 0) return 100 + substringIndex;

  let previousIndex = -1;
  let gapScore = 0;
  for (const character of normalizedQuery) {
    const index = candidate.indexOf(character, previousIndex + 1);
    if (index < 0) return null;
    gapScore += previousIndex < 0 ? index : index - previousIndex - 1;
    previousIndex = index;
  }
  return 1_000 + gapScore;
}

export function applySlashCommand(command: PiCommand): string {
  return `/${command.name} `;
}

export function shouldCycleCommandHistory(
  value: string,
  cursor: number,
  direction: -1 | 1,
  browsingHistory: boolean,
) {
  if (browsingHistory) return true;
  if (!value.includes('\n')) return true;
  if (direction === -1) return cursor <= value.indexOf('\n');
  return cursor > value.lastIndexOf('\n');
}
