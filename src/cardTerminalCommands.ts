import { applicationEvents } from './applicationEvents';

export type CardTerminalCommand =
  | { type: 'split'; direction: 'row' | 'column' }
  | { type: 'search' }
  | { type: 'clear' }
  | { type: 'restart' }
  | { type: 'stop' }
  | { type: 'close' }
  | { type: 'focus'; paneId: string }
  | { type: 'navigate-pane'; direction: -1 | 1 }
  | { type: 'toggle-maximize' }
  | { type: 'run-one-time'; command: string };

export type TerminalServiceCommand = {
  mode: 'server' | 'console';
  action: 'start' | 'stop' | 'restart';
  ownerId?: string;
};

export type CardTerminalContext = {
  cardId?: string;
  ownerId?: string;
  active: boolean;
  focusedPaneId: string | null;
  paneIds: string[];
  cwd: string | null;
  maximized: boolean;
  services?: Record<'server' | 'console', { configured: boolean; active: boolean }>;
};

export function dispatchCardTerminalCommand(command: CardTerminalCommand) {
  applicationEvents.publish('card-terminal-command', command);
}

export function dispatchTerminalServiceCommand(command: TerminalServiceCommand) {
  applicationEvents.publish('terminal-service-command', command);
}

export function publishCardTerminalContext(context: CardTerminalContext | null) {
  applicationEvents.publish('card-terminal-context', context);
}
