import { describe, expect, it } from 'vitest';
import { buildSuperthreadWorkspaceInput } from './startWork';
import type { Store } from '../types';

const store: Store = {
  projects: [{ id: 'arcasa-project', name: 'Arcasa', path: '/code/arcasa', workspaces: [] }],
};
const templates = { command: 'stwork {card_number}', workspaceName: '{card_number} {card_title}' };

describe('buildSuperthreadWorkspaceInput', () => {
  it('creates a focused-workspace input with a one-time stwork command', () => {
    expect(buildSuperthreadWorkspaceInput(store, 'arcasa-project', '1234', 'Fix checkout', templates)).toEqual({
      projectId: 'arcasa-project',
      name: '1234 Fix checkout',
      oneTimeStartupCommand: 'stwork 1234',
    });
  });

  it('rejects unsafe card numbers', () => {
    expect(() => buildSuperthreadWorkspaceInput(store, 'arcasa-project', '1234; false', 'Bad', templates)).toThrow('Invalid card number');
  });

  it('requires the selected project', () => {
    expect(() => buildSuperthreadWorkspaceInput({ projects: [] }, 'missing', '1234', 'Missing', templates)).toThrow('Selected project not found');
  });

  it('normalizes whitespace in card titles', () => {
    expect(buildSuperthreadWorkspaceInput(store, 'arcasa-project', '1234', ' Fix\n  checkout ', templates).name).toBe('1234 Fix checkout');
  });

  it('applies configurable templates and shell-escapes titles used in commands', () => {
    const input = buildSuperthreadWorkspaceInput(store, 'arcasa-project', '1234', "Fix user's checkout", {
      command: 'work --card {card_number} --title {card_title}',
      workspaceName: 'Card {card_number}: {card_title}',
    });
    expect(input.name).toBe("Card 1234: Fix user's checkout");
    expect(input.oneTimeStartupCommand).toBe("work --card 1234 --title 'Fix user'\"'\"'s checkout'");
  });
});
