import type { CardProviderAdapter, KanbanSyncCard } from '../kanban/types';
import { isManagedSuperthreadList } from '../kanban/workflow';
import { createSuperthreadCard, fetchSuperthreadBoards, fetchSuperthreadCard, fetchSuperthreadCards, fetchSuperthreadLists } from './api';

export function superthreadCardProvider(spaces: string, workspaceSlug: string): CardProviderAdapter {
  return {
    kind: 'superthread',
    async create(title, content) {
      const card = await createSuperthreadCard({ spaces, workspaceSlug, title, content });
      return {
        id: card.id,
        title: card.title,
        content: card.content,
        board_id: card.board_id,
        board_title: card.board_title,
        list_id: card.list_id,
        list_title: card.list_title,
        card_url: card.card_url,
        assignee_names: card.assignee_names,
        in_scope: true,
      };
    },
    async load(card) {
      const detail = await fetchSuperthreadCard(card.external_id, workspaceSlug);
      return {
        id: detail.id, title: detail.title, content: detail.content,
        board_id: card.board_id, board_title: card.board_title,
        list_id: card.list_id, list_title: card.list_title,
        card_url: detail.card_url, assignee_names: detail.assignee_names, in_scope: true,
      };
    },
    async sync(refresh = false) {
      const response = await fetchSuperthreadBoards(spaces, refresh);
      const cards = (await Promise.all(response.boards.map(async (board) => {
        const lists = await fetchSuperthreadLists(board.id);
        const listById = new Map(lists.map((list) => [list.id, list]));
        const boardCards = await fetchSuperthreadCards(board.id, workspaceSlug);
        return boardCards.map((card): KanbanSyncCard => {
          const listTitle = listById.get(card.list_id)?.title ?? card.list_title;
          return {
            id: card.id,
            title: card.title,
            content: card.content,
            board_id: board.id,
            board_title: board.title,
            list_id: card.list_id,
            list_title: listTitle,
            card_url: card.card_url,
            assignee_names: card.assignee_names,
            in_scope: isManagedSuperthreadList(board.title, listTitle),
          };
        });
      }))).flat();
      return { cards, warnings: response.warnings.map((warning) => warning.message) };
    },
  };
}
