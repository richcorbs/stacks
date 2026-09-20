import { applicationEvents } from './applicationEvents';

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
  applicationEvents.publish('card-terminal-command', command);
}

export function publishCardTerminalContext(context: CardTerminalContext | null) {
  applicationEvents.publish('card-terminal-context', context);
}
