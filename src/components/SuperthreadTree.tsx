import type { SuperthreadBoard, SuperthreadCard, SuperthreadList } from '../superthread/types';

export function SuperthreadTree({
  boards,
  collapsedIds,
  loadedCardBoardIds,
  loadingTreeIds,
  disabled,
  onToggleBoard,
  onToggleList,
  onOpenCard,
}: {
  boards: SuperthreadBoard[];
  collapsedIds: Set<string>;
  loadedCardBoardIds: Set<string>;
  loadingTreeIds: Set<string>;
  disabled: boolean;
  onToggleBoard: (board: SuperthreadBoard) => void;
  onToggleList: (board: SuperthreadBoard, list: SuperthreadList) => void;
  onOpenCard: (card: SuperthreadCard) => void;
}) {
  return boards.map((board) => {
    const boardKey = `board:${board.id}`;
    const boardCollapsed = collapsedIds.has(boardKey);
    return (
      <section className="superthreadBoard" key={board.id}>
        <button className="superthreadTreeRow superthreadBoardRow" type="button" disabled={disabled || loadingTreeIds.has(boardKey)} onClick={() => onToggleBoard(board)}>
          <span className={`superthreadDisclosure${boardCollapsed ? '' : ' expanded'}`} />
          <span className="superthreadRowText"><strong>{board.title}</strong></span>
          {loadingTreeIds.has(boardKey) && <span className="superthreadCount">…</span>}
        </button>
        {!boardCollapsed && board.lists.map((list) => {
          const listKey = `list:${board.id}:${list.id}`;
          const listCollapsed = collapsedIds.has(listKey);
          const cards = board.cards.filter((card) => card.list_id === list.id);
          return (
            <div className="superthreadList" key={list.id}>
              <button className="superthreadTreeRow superthreadListRow" type="button" disabled={disabled || loadingTreeIds.has(listKey)} onClick={() => onToggleList(board, list)}>
                <span className={`superthreadDisclosure${listCollapsed ? '' : ' expanded'}`} />
                <span className="superthreadRowText"><strong>{list.title}</strong></span>
                <span className="superthreadCount">{loadingTreeIds.has(listKey) ? '…' : loadedCardBoardIds.has(board.id) ? cards.length : ''}</span>
              </button>
              {!listCollapsed && cards.map((card) => (
                <button className="superthreadTreeRow superthreadCardRow" type="button" key={card.id} disabled={disabled} onClick={() => onOpenCard(card)}>
                  <span className="superthreadRowText"><strong>{card.id} - {card.title}</strong></span>
                </button>
              ))}
            </div>
          );
        })}
      </section>
    );
  });
}
