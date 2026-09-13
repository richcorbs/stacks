import { describe, expect, it } from 'vitest';
import { buildLocalWorkspaceInput, buildSuperthreadWorkspaceInput } from './startWork';
import type { Store } from '../types';

const store: Store = {
  projects: [{ id: 'arcasa-project', name: 'Arcasa', path: '/code/arcasa', workspaces: [] }],
};
const templates = { command: 'stwork {card_number}', workspaceName: '{card_number} {card_title}' };

describe('buildLocalWorkspaceInput', () => {
  it('creates a local branch and sibling worktree without Superthread', () => {
    expect(buildLocalWorkspaceInput(store, 'arcasa-project', '1', 'Fix checkout')).toEqual({
      projectId: 'arcasa-project',
      name: '1 Fix checkout',
      setupCommand: "git worktree add -b 'stacks/card-1-fix-checkout' '/code/arcasa-card-1' && cd '/code/arcasa-card-1'",
      firstPaneKind: 'pi',
    });
  });
});

describe('buildSuperthreadWorkspaceInput', () => {
  it('creates a worktree during setup and prepares a Pi environment', () => {
    expect(buildSuperthreadWorkspaceInput(store, 'arcasa-project', '1234', 'Fix checkout', templates)).toEqual({
      projectId: 'arcasa-project',
      name: '1234 Fix checkout',
      setupCommand: 'stwork 1234',
      firstPaneKind: 'pi',
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
    expect(input.setupCommand).toBe("work --card 1234 --title 'Fix user'\"'\"'s checkout'");
    expect(input.firstPaneKind).toBe('pi');
  });
});
