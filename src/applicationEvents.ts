import { createContext, useContext } from 'react';
import type { AppAttention, NotificationRoute } from './appAttention';
import type { CardTerminalCommand, CardTerminalContext } from './cardTerminalCommands';
import type { GlobalTerminalCommand } from './globalTerminalState';
import type { WorkView } from './directWork';
import type { PiEditorTextRequest } from './pi/editorTextEvent';
import type { PiPromptRequest } from './pi/promptEvent';
import type { TerminalStartupResult } from './terminalStartup';
import type { ToastDetail } from './types';
import { createEventBroker, type EventBroker } from './eventBroker';

export type { EventBroker } from './eventBroker';

export type AppEventMap = {
  toast: ToastDetail & { duration?: number };
  'new-card': { projectId?: string };
  'open-direct-work': { projectId?: string; view?: WorkView };
  'open-project-switcher': undefined;
  'card-tab-shortcut': { number?: number; direction?: -1 | 1 };
  'card-workflow-action': { cardId?: string; action?: string };
  'card-terminal-split': { direction?: 'row' | 'column'; pane?: string };
  'card-terminal-close': { pane?: string } | undefined;
  'card-terminal-command': CardTerminalCommand;
  'card-terminal-context': CardTerminalContext | null;
  'global-terminal-command': GlobalTerminalCommand;
  'refresh-card-repository-status': undefined;
  'notification-route': NotificationRoute;
  attention: AppAttention;
  'terminal-running-changed': { terminalId: string; generation?: string; running: boolean };
  'terminal-output': { workspaceId: string; terminalId: string };
  'terminal-output-rendered': { terminalId: string };
  'terminal-startup-result': TerminalStartupResult;
  'pane-focus-request': { terminalId?: string };
  'project-notes-save-failed': { projectId: string };
  'pi-prompt': PiPromptRequest;
  'pi-agent-settled': { terminalId: string };
  'pi-prompt-failed': { terminalId: string };
  'pi-editor-text': PiEditorTextRequest;
};

export const applicationEvents = createEventBroker<AppEventMap>();
export const ApplicationEventsContext = createContext<EventBroker<AppEventMap>>(applicationEvents);
export const useApplicationEvents = () => useContext(ApplicationEventsContext);

export function showAppToast(message: string, duration?: number) {
  applicationEvents.publish('toast', { message, duration });
}
