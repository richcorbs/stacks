import { describe, expect, it } from 'vitest';
import {
  applySlashCommand,
  boundaryForUnmovedHistoryArrow,
  fuzzyCommandScore,
  GUI_BUILTIN_COMMANDS,
  isGuiBuiltinCommand,
  matchingSlashCommands,
  shouldCycleCommandHistory,
  slashCommandQuery,
} from './commands';
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

  describe('prompt history arrows', () => {
    it('only cycles single-line history at the absolute boundary', () => {
      const value = 'single line';
      expect(shouldCycleCommandHistory(value, -1, 0, 0)).toBe(true);
      expect(shouldCycleCommandHistory(value, -1, 4, 4)).toBe(false);
      expect(shouldCycleCommandHistory(value, -1, value.length, value.length)).toBe(false);
      expect(shouldCycleCommandHistory(value, 1, 0, 0)).toBe(false);
      expect(shouldCycleCommandHistory(value, 1, 4, 4)).toBe(false);
      expect(shouldCycleCommandHistory(value, 1, value.length, value.length)).toBe(true);
    });

    it('only cycles multiline history at the absolute boundary', () => {
      const value = 'first\nsecond';
      expect(shouldCycleCommandHistory(value, -1, 0, 0)).toBe(true);
      expect(shouldCycleCommandHistory(value, -1, 3, 3)).toBe(false);
      expect(shouldCycleCommandHistory(value, -1, value.length, value.length)).toBe(false);
      expect(shouldCycleCommandHistory(value, 1, 0, 0)).toBe(false);
      expect(shouldCycleCommandHistory(value, 1, 7, 7)).toBe(false);
      expect(shouldCycleCommandHistory(value, 1, value.length, value.length)).toBe(true);
    });

    it('does not cycle history when text is selected', () => {
      const value = 'first\nsecond';
      expect(shouldCycleCommandHistory(value, -1, 0, 5)).toBe(false);
      expect(shouldCycleCommandHistory(value, 1, 6, value.length)).toBe(false);
    });

    it('moves an unchanged collapsed caret to the relevant field boundary', () => {
      const value = 'text that may be visually wrapped';
      expect(boundaryForUnmovedHistoryArrow(value, -1, 4, 4, 4, 4)).toBe(0);
      expect(boundaryForUnmovedHistoryArrow(value, 1, 4, 4, 4, 4)).toBe(value.length);
    });

    it('leaves native caret movement and selections unchanged', () => {
      const value = 'first\nsecond';
      expect(boundaryForUnmovedHistoryArrow(value, -1, 9, 9, 3, 3)).toBeNull();
      expect(boundaryForUnmovedHistoryArrow(value, 1, 3, 3, 9, 9)).toBeNull();
      expect(boundaryForUnmovedHistoryArrow(value, -1, 2, 5, 2, 5)).toBeNull();
      expect(boundaryForUnmovedHistoryArrow(value, 1, 4, 4, 4, 7)).toBeNull();
    });

    it('does not reapply a boundary when the caret is already there', () => {
      const value = 'single line';
      expect(boundaryForUnmovedHistoryArrow(value, -1, 0, 0, 0, 0)).toBeNull();
      expect(boundaryForUnmovedHistoryArrow(value, 1, value.length, value.length, value.length, value.length)).toBeNull();
    });
  });
});
