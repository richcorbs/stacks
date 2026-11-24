import type { Project } from '../../types';
import type { KanbanCard } from '../../kanban/types';
import { cardPaneId, cardWorkspaceId, type CardChatThread } from '../../kanban/cardWorkspace';
import { WorkAgentView } from '../WorkAgentView';
import type { PasteIntoTerminal } from '../PiMarkdown';

export function CardChatView({ card, project, cardPath, thread, active, deploymentOutput, onPasteIntoTerminal }: {
  card: KanbanCard; project: Project; cardPath: string | null; thread: CardChatThread; active: boolean; deploymentOutput: string;
  onPasteIntoTerminal?: PasteIntoTerminal;
}) {
  return <WorkAgentView terminal={{ id: cardPaneId(card.id, thread), workspaceId: cardWorkspaceId(card.id), kind: 'pi' }}
    workspace={{ id: cardWorkspaceId(card.id), name: `Card #${card.external_id}`, cwd: thread === 'work' ? cardPath! : project.path }}
    composerDraftKey={cardPaneId(card.id, thread)}
    project={project} active={active} label="Card chat" openingMessage="Opening card chat…" onPasteIntoTerminal={onPasteIntoTerminal}>
    {deploymentOutput && <details className="scriptedDeliveryOutput"><summary>Deployment output (current session)</summary><pre>{deploymentOutput}</pre></details>}
  </WorkAgentView>;
}
