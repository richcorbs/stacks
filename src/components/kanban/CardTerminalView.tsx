import { invoke } from '@tauri-apps/api/core';
import type { Project } from '../../types';
import type { KanbanCard } from '../../kanban/types';
import type { useCardTerminalWorkspace } from '../../kanban/useCardTerminalWorkspace';
import { cardWorkspaceId } from '../../kanban/cardWorkspace';
import { SplitView } from '../WorkspaceTerminalTree';

const encoder = new TextEncoder();
type TerminalController = ReturnType<typeof useCardTerminalWorkspace>;

export function CardTerminalView({ active, card, project, cardPath, controller, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect }: {
  active: boolean; card: KanbanCard; project: Project | undefined; cardPath: string | null; controller: TerminalController;
  terminalFontSize: number; terminalFontFamily: string; terminalScrollback: number; copyOnSelect: boolean;
}) {
  if (!project || !cardPath) return <section className={`cardTerminalView cardView${active ? ' active' : ''}`} />;
  const { shellTree, shellTerminals, shellTerminalIds, focusedShellPane, maximizedShellPane, searchShellRequest, restartShellRequest } = controller;
  return <section className={`cardTerminalView cardView${active ? ' active' : ''}`}><div className={`cardTerminalPane${shellTerminalIds.length > 1 ? ' multiple' : ''}`}>
    {shellTree.kind === 'empty' ? <div className="kanbanEmpty">Terminal closed. Reopen the card to start a new terminal.</div> : <SplitView
      node={shellTree} terminalsById={shellTerminals} workspace={{ id: cardWorkspaceId(card.id), name: `Card #${card.external_id}`, cwd: cardPath }} project={project} visible={active}
      canEditTerminal={false} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect}
      activeTerminalId={focusedShellPane} displayedMaximizedTerminalId={maximizedShellPane} searchTerminalRequest={searchShellRequest} restartTerminalRequest={restartShellRequest} path=""
      onResizeSplit={controller.setSplitRatio} onFocus={controller.focusShellPane} onClose={controller.setPendingCloseShellPane}
      onSplitTerminal={controller.splitTerminal} onEditTerminal={() => {}}
      onInput={(terminalId, data) => invoke('write_pty', { terminalId, data: Array.from(encoder.encode(data)) }).catch(console.error)}
      canToggleMaximize={shellTerminalIds.length > 1} onToggleMaximize={controller.toggleMaximize} />}
  </div></section>;
}
