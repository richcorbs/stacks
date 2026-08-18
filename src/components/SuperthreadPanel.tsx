import { useState } from 'react';
import { SuperthreadCardDialog } from './SuperthreadCardDialog';
import { SuperthreadProjectDialog } from './SuperthreadProjectDialog';
import { SuperthreadTree } from './SuperthreadTree';
import { useSuperthreadCache } from '../superthread/useSuperthreadCache';
import type { Project } from '../types';
import type { SuperthreadCard } from '../superthread/types';

export function SuperthreadPanel({ visible, projects, spaces, workspaceSlug, onStartWork }: {
  visible: boolean;
  projects: Project[];
  spaces: string;
  workspaceSlug: string;
  onStartWork: (projectId: string, cardNumber: string, cardTitle: string) => Promise<boolean>;
}) {
  const superthread = useSuperthreadCache(workspaceSlug, spaces);
  const [pendingWorkCard, setPendingWorkCard] = useState<SuperthreadCard | null>(null);
  const selectedCardStatus = superthread.selectedCard
    ? superthread.boards
      .find((board) => board.id === superthread.selectedCard?.board_id)
      ?.lists.find((list) => list.id === superthread.selectedCard?.list_id)
      ?.behavior
    : undefined;

  return (
    <aside className={`superthreadPanel${visible ? '' : ' superthreadPanelHidden'}`} aria-label="Superthread">
      <header className="superthreadHeader">
        <div className="superthreadHeaderTitle">
          <strong>Superthread</strong>
          <span>{superthread.boards.length ? `${superthread.boards.length} board${superthread.boards.length === 1 ? '' : 's'}` : 'Boards'}</span>
        </div>
        <button
          type="button"
          title="Refresh Superthread"
          aria-label="Refresh Superthread"
          disabled={superthread.loading}
          onClick={() => superthread.loadBoards(true).catch(console.error)}
        >
          ↻
        </button>
      </header>

      <div className="superthreadTree">
        {superthread.loading && superthread.boards.length === 0 && <div className="superthreadState">Loading boards…</div>}
        {superthread.error && <div className="superthreadState superthreadError">{superthread.error}</div>}
        {superthread.warnings.length > 0 && (
          <div
            className="superthreadState superthreadWarning"
            title={superthread.warnings.map((warning) => `${warning.scope}: ${warning.message}`).join('\n')}
          >
            {superthread.warnings.length} inaccessible {superthread.warnings.length === 1 ? 'scope was' : 'scopes were'} skipped.
          </div>
        )}
        {!superthread.loading && !superthread.error && superthread.boards.length === 0 && <div className="superthreadState">No boards found.</div>}
        <SuperthreadTree
          boards={superthread.boards}
          collapsedIds={superthread.collapsedIds}
          loadedCardBoardIds={superthread.loadedCardBoardIds}
          loadingTreeIds={superthread.loadingTreeIds}
          disabled={superthread.loading}
          onToggleBoard={(board) => superthread.toggleBoard(board).catch(console.error)}
          onToggleList={(board, list) => superthread.toggleList(board, list).catch(console.error)}
          onOpenCard={(card) => superthread.openCard(card).catch(console.error)}
        />
      </div>

      {superthread.selectedCard && (
        <SuperthreadCardDialog
          card={superthread.selectedCard}
          status={selectedCardStatus}
          loading={superthread.cardLoading}
          error={superthread.cardError}
          onRequestStartWork={(card) => {
            superthread.closeCard();
            setPendingWorkCard(card);
          }}
          onClose={superthread.closeCard}
        />
      )}

      {pendingWorkCard && (
        <SuperthreadProjectDialog
          card={pendingWorkCard}
          projects={projects}
          onCancel={() => setPendingWorkCard(null)}
          onStart={onStartWork}
        />
      )}
    </aside>
  );
}
