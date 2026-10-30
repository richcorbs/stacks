import type { Project } from '../../types';
import type { KanbanCard } from '../../kanban/types';
import { cardTerminalId, cardWorkspaceId, type CardServiceMode } from '../../kanban/cardWorkspace';
import { WorkServiceTerminal } from '../WorkServiceTerminal';

export function CardServiceTerminal({ card, cardPath, ...props }: {
  mode: CardServiceMode; command: string; enabled: boolean; active: boolean; background?: boolean;
  restartRequestNonce: number; card: Pick<KanbanCard, 'id' | 'external_id'>; project: Project; cardPath: string;
  terminalFontSize: number; terminalFontFamily: string; terminalScrollback: number; copyOnSelect: boolean;
}) {
  return <WorkServiceTerminal {...props} terminalId={cardTerminalId(card.id, props.mode)}
    workspace={{ id: cardWorkspaceId(card.id), name: `Card #${card.external_id}`, cwd: cardPath }} />;
}
