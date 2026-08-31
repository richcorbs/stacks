import { SuperthreadTree } from './SuperthreadTree';
import type { useSuperthreadCache } from '../superthread/useSuperthreadCache';

type SuperthreadModel = ReturnType<typeof useSuperthreadCache>;

export function SuperthreadTab({ superthread }: { superthread: SuperthreadModel }) {
  return <>
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
  </>;
}
