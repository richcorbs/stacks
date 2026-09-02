import { describe, expect, it } from 'vitest';
import { applySlashCommand, fuzzyCommandScore, GUI_BUILTIN_COMMANDS, isGuiBuiltinCommand, matchingSlashCommands, shouldCycleCommandHistory, slashCommandQuery } from './commands';
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
    expect(matchingSlashCommands(commands, '/re').map((command) => command.name)).toEqual(['release-notes', 'review', 'skill:grill-me']);
    expect(matchingSlashCommands(commands, '/grill').map((command) => command.name)).toEqual(['skill:grill-me']);
  });

  it('fuzzy-matches command names with characters in order', () => {
    expect(matchingSlashCommands(commands, '/sgr').map((command) => command.name)).toEqual(['skill:grill-me']);
    expect(matchingSlashCommands(commands, '/rvw').map((command) => command.name)).toEqual(['review']);
    expect(matchingSlashCommands(commands, '/xyz')).toEqual([]);
    expect(fuzzyCommandScore('Review', 'RVW')).not.toBeNull();
  });

  it('ranks prefixes, substrings, and fuzzy matches in that order', () => {
    const ranked: PiCommand[] = [
      { name: 'skill:review', source: 'skill' },
      { name: 'preview', source: 'prompt' },
      { name: 'review', source: 'prompt' },
    ];
    expect(matchingSlashCommands(ranked, '/rev').map((command) => command.name)).toEqual(['review', 'preview', 'skill:review']);
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

  it('cycles history only when the composer has one line', () => {
    expect(shouldCycleCommandHistory('single line')).toBe(true);
    expect(shouldCycleCommandHistory('first\nsecond')).toBe(false);
    expect(shouldCycleCommandHistory('visually wrapped input', true)).toBe(false);
  });
});
