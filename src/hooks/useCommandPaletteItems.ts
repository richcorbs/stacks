import { useMemo } from 'react';
import { buildCommandPaletteItems, type CommandPaletteItemOptions } from '../commandPaletteItems';
import type { PaletteItem } from '../components/CommandPalette';

export function useCommandPaletteItems(options: CommandPaletteItemOptions) {
  return useMemo<PaletteItem[]>(() => buildCommandPaletteItems(options), [
    options.store,
    options.sidebarTerminals,
    options.panesByTerminalId,
    options.activeProject,
    options.activeTerminal,
    options.activeTerminalId,
    options.activePaneId,
    options.activePath,
    options.onNewProject,
    options.onNewTerminal,
    options.onEditProject,
    options.onEditTerminal,
    options.onDeleteWorkspace,
    options.onSplitPane,
    options.onCycleTerminal,
    options.onCyclePane,
    options.onStopPane,
    options.onRestartPane,
    options.onClosePane,
    options.onClearPane,
    options.onToggleMaximizedTerminal,
    options.onOpenSearch,
    options.onOpenSettings,
    options.onOpenDirectoryInEditor,
    options.onSelectTerminal,
  ]);
}
