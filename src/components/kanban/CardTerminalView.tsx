import type { Project } from '../../types';
import type { KanbanCard } from '../../kanban/types';
import type { useCardTerminalWorkspace } from '../../kanban/useCardTerminalWorkspace';
import { cardWorkspaceId } from '../../kanban/cardWorkspace';
import { WorkspaceShellView } from '../WorkspaceShellView';

type TerminalController = ReturnType<typeof useCardTerminalWorkspace>;

export function CardTerminalView({ active, card, project, cardPath, controller, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect }: {
  active: boolean; card: KanbanCard; project: Project | undefined; cardPath: string | null; controller: TerminalController;
  terminalFontSize: number; terminalFontFamily: string; terminalScrollback: number; copyOnSelect: boolean;
}) {
  return <section className={`cardTerminalView cardView${active ? ' active' : ''}`}>
    {project && cardPath && <WorkspaceShellView
      controller={controller.controller}
      workspace={{ id: cardWorkspaceId(card.id), name: `Card #${card.external_id}`, cwd: cardPath }}
      project={project}
      visible={active}
      terminalFontSize={terminalFontSize}
      terminalFontFamily={terminalFontFamily}
      terminalScrollback={terminalScrollback}
      copyOnSelect={copyOnSelect}
    />}
  </section>;
}
