import { useEffect } from 'react';
import { applicationEvents } from '../applicationEvents';
import type { CardTerminalCommand } from '../cardTerminalCommands';
import type { WorkspaceShellController } from '../workspaceShellController';

/** Subscribe without tying cached sessions or processes to a React mount. */
export function useWorkspaceShellShortcuts(controller: WorkspaceShellController, active: boolean) {
  useEffect(() => {
    const unsubscribes = [
      applicationEvents.subscribe('card-terminal-split', (detail: { direction?: 'row' | 'column'; pane?: string }) => {
        if (active && detail.direction) void controller.split(detail.direction, detail.pane);
      }),
      applicationEvents.subscribe('card-terminal-close', (detail?: { pane?: string }) => {
        if (active) controller.requestClose(detail?.pane);
      }),
      applicationEvents.subscribe('card-terminal-command', (command: CardTerminalCommand) => controller.handleCommand(controller.ownerId, active, command)),
    ];
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [active, controller]);
}
