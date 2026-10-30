import type { Project } from '../../types';
import type { KanbanCard } from '../../kanban/types';
import { cardPaneId, cardWorkspaceId, type CardChatThread } from '../../kanban/cardWorkspace';
import { WorkAgentView } from '../WorkAgentView';

export function CardChatView({ card, project, cardPath, thread, active, deploymentOutput }: {
  card: KanbanCard; project: Project; cardPath: string | null; thread: CardChatThread; active: boolean; deploymentOutput: string;
}) {
  return <WorkAgentView terminal={{ id: cardPaneId(card.id, thread), workspaceId: cardWorkspaceId(card.id), kind: 'pi' }}
    workspace={{ id: cardWorkspaceId(card.id), name: `Card #${card.external_id}`, cwd: thread === 'work' ? cardPath! : project.path }}
    project={project} active={active} label="Card chat" openingMessage="Opening card chat…">
    {deploymentOutput && <details className="scriptedDeliveryOutput"><summary>Deployment output (current session)</summary><pre>{deploymentOutput}</pre></details>}
  </WorkAgentView>;
}
