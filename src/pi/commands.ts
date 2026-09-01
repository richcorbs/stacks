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
    .filter((command) => !query || command.name.toLowerCase().includes(query))
    .sort((left, right) => {
      const leftStarts = left.name.toLowerCase().startsWith(query);
      const rightStarts = right.name.toLowerCase().startsWith(query);
      if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
    .slice(0, limit);
}

export function applySlashCommand(command: PiCommand): string {
  return `/${command.name} `;
}
