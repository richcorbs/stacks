import { useMemo } from 'react';
import { buildCommandPaletteItems, type CommandPaletteItemOptions } from '../commandPaletteItems';
import type { PaletteItem } from '../components/CommandPalette';

export function useCommandPaletteItems(options: CommandPaletteItemOptions) {
  return useMemo<PaletteItem[]>(() => buildCommandPaletteItems(options), [
    options.store,
    options.sidebarWorkspaces,
    options.terminalsByWorkspaceId,
    options.activeProject,
    options.activeWorkspace,
    options.activeWorkspaceId,
    options.activeTerminalId,
    options.activePath,
    options.onNewProject,
    options.onNewWorkspace,
    options.onEditProject,
    options.onEditWorkspace,
    options.onEditTerminal,
    options.onDeleteWorkspace,
    options.onSplitTerminal,
    options.onCycleWorkspace,
    options.onCycleTerminal,
    options.onStopTerminal,
    options.onRestartTerminal,
    options.onCloseTerminal,
    options.onClearTerminal,
    options.onToggleMaximizedTerminal,
    options.onOpenSearch,
    options.onOpenSettings,
    options.onOpenDirectoryInEditor,
    options.onSelectWorkspace,
    options.broadcastEnabled,
    options.onToggleBroadcast,
  ]);
}
