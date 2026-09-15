export const CARD_TERMINAL_COMMAND_EVENT = 'stacks:card-terminal-command';
export const CARD_TERMINAL_CONTEXT_EVENT = 'stacks:card-terminal-context';

export type CardTerminalCommand =
  | { type: 'split'; direction: 'row' | 'column' }
  | { type: 'search' }
  | { type: 'clear' }
  | { type: 'restart' }
  | { type: 'stop' }
  | { type: 'close' }
  | { type: 'focus'; paneId: string }
  | { type: 'toggle-maximize' }
  | { type: 'run-one-time'; command: string };

export type CardTerminalContext = {
  cardId: string;
  active: boolean;
  focusedPaneId: string | null;
  paneIds: string[];
  cwd: string | null;
  maximized: boolean;
};

export function dispatchCardTerminalCommand(command: CardTerminalCommand) {
  window.dispatchEvent(new CustomEvent<CardTerminalCommand>(CARD_TERMINAL_COMMAND_EVENT, { detail: command }));
}

export function publishCardTerminalContext(context: CardTerminalContext | null) {
  window.dispatchEvent(new CustomEvent<CardTerminalContext | null>(CARD_TERMINAL_CONTEXT_EVENT, { detail: context }));
}
