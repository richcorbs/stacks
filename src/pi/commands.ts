import type { PiCommand } from './types';

export function slashCommandQuery(value: string): string | null {
  if (!value.startsWith('/') || /\s/.test(value)) return null;
  return value.slice(1).toLowerCase();
}

export function matchingSlashCommands(commands: PiCommand[], value: string, limit = 12): PiCommand[] {
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
