import { lazy, Suspense } from 'react';
import type { Project } from '../../types';
import type { KanbanCard } from '../../kanban/types';
import { cardChatPrompt, cardPaneId, cardWorkspaceId, type CardChatThread } from '../../kanban/cardWorkspace';

const PiGuiView = lazy(() => import('../PiGuiView').then((module) => ({ default: module.PiGuiView })));

export function CardChatView({ card, project, cardPath, thread, active, deploymentOutput }: {
  card: KanbanCard; project: Project; cardPath: string | null; thread: CardChatThread; active: boolean; deploymentOutput: string;
}) {
  return <section className={`cardChatView cardView${active ? ' active' : ''}`} aria-label="Card chat"><div className="cardChat">
    {deploymentOutput && <details className="scriptedDeliveryOutput"><summary>Deployment output (current session)</summary><pre>{deploymentOutput}</pre></details>}
    <Suspense fallback={<div className="kanbanEmpty">Opening card chat…</div>}>
      <PiGuiView key={thread} terminal={{ id: cardPaneId(card.id, thread), workspaceId: cardWorkspaceId(card.id), kind: 'pi' }}
        workspace={{ id: cardWorkspaceId(card.id), name: `Card #${card.external_id}`, cwd: thread === 'work' ? cardPath! : project.path }}
        project={project} active={active} visible={active} maximized={false} canToggleMaximize={false} restartRequestNonce={0}
        initialPrompt={thread === 'planning' ? cardChatPrompt(card, thread) : undefined} fontSize={13}
        onFocus={() => {}} onClose={() => {}} onSplitTerminal={() => {}} onEditTerminal={() => {}} onToggleMaximize={() => {}} />
    </Suspense>
  </div></section>;
}
