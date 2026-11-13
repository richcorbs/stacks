import { describe, expect, it } from 'vitest';
import { nativeRequestForGlobalCommand, nativeRequestForTerminalAction } from './nativeGlobalTerminal';
import type { GlobalTerminalCommand } from './globalTerminalState';

describe('native global terminal command mapping', () => {
  it('maps the shared global terminal commands onto host commands', () => {
    const cases: Array<[GlobalTerminalCommand, { command: string; index?: number }]> = [
      [{ type: 'new-tab' }, { command: 'new-tab' }],
      [{ type: 'select-tab', number: 3 }, { command: 'select-tab', index: 3 }],
      [{ type: 'navigate-tab', direction: -1 }, { command: 'previous-tab' }],
      [{ type: 'navigate-tab', direction: 1 }, { command: 'next-tab' }],
      [{ type: 'navigate-pane', direction: -1 }, { command: 'previous-pane' }],
      [{ type: 'navigate-pane', direction: 1 }, { command: 'next-pane' }],
      [{ type: 'split', direction: 'row' }, { command: 'split-right' }],
      [{ type: 'split', direction: 'column' }, { command: 'split-down' }],
      [{ type: 'toggle-maximize' }, { command: 'maximize' }],
      [{ type: 'close' }, { command: 'close' }],
      [{ type: 'clear' }, { command: 'clear' }],
      [{ type: 'search' }, { command: 'search' }],
    ];
    for (const [input, expected] of cases) {
      expect(nativeRequestForGlobalCommand(input)).toEqual(expected);
    }
  });

  it('maps window shortcut actions onto the same host vocabulary', () => {
    expect(nativeRequestForTerminalAction('split-right')).toEqual({ command: 'split-right' });
    expect(nativeRequestForTerminalAction('split-down')).toEqual({ command: 'split-down' });
    expect(nativeRequestForTerminalAction('toggle-maximize')).toEqual({ command: 'maximize' });
    expect(nativeRequestForTerminalAction('previous-pane')).toEqual({ command: 'previous-pane' });
    expect(nativeRequestForTerminalAction('next-pane')).toEqual({ command: 'next-pane' });
    expect(nativeRequestForTerminalAction('close')).toEqual({ command: 'close' });
    expect(nativeRequestForTerminalAction('clear')).toEqual({ command: 'clear' });
    expect(nativeRequestForTerminalAction('search')).toEqual({ command: 'search' });
  });
});
