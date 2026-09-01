import { describe, expect, it } from 'vitest';
import { applySlashCommand, GUI_BUILTIN_COMMANDS, isGuiBuiltinCommand, matchingSlashCommands, slashCommandQuery } from './commands';
import type { PiCommand } from './types';

const commands: PiCommand[] = [
  { name: 'skill:grill-me', source: 'skill', description: 'Stress-test a plan' },
  { name: 'review', source: 'prompt', description: 'Review changes' },
  { name: 'release-notes', source: 'extension' },
];

describe('Pi slash commands', () => {
  it('only completes a command token at the start of the composer', () => {
    expect(slashCommandQuery('/skill')).toBe('skill');
    expect(slashCommandQuery('/skill:grill-me args')).toBeNull();
    expect(slashCommandQuery('please /review')).toBeNull();
  });

  it('ranks prefix matches before substring matches', () => {
    expect(matchingSlashCommands(commands, '/re').map((command) => command.name)).toEqual(['release-notes', 'review']);
    expect(matchingSlashCommands(commands, '/grill').map((command) => command.name)).toEqual(['skill:grill-me']);
  });

  it('keeps a large project prompt list discoverable', () => {
    const projectPrompts = Array.from({ length: 20 }, (_, index) => ({ name: `prompt-${index}`, source: 'prompt' as const }));
    expect(matchingSlashCommands(projectPrompts, '/')).toHaveLength(20);
  });

  it('offers GUI-supported built-in commands', () => {
    expect(GUI_BUILTIN_COMMANDS.map((command) => command.name)).toEqual(['new', 'compact']);
    expect(isGuiBuiltinCommand('compact')).toBe(true);
    expect(isGuiBuiltinCommand('settings')).toBe(false);
  });

  it('inserts the RPC command with room for arguments', () => {
    expect(applySlashCommand(commands[0])).toBe('/skill:grill-me ');
  });
});
