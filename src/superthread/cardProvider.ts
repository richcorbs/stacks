import type { KanbanSyncCard, SuperthreadIntegration, SuperthreadSnapshot } from '../kanban/types';
import { isManagedSuperthreadList } from '../kanban/workflow';
import { createSuperthreadCard, fetchSuperthreadBoards, fetchSuperthreadCard, fetchSuperthreadCards, fetchSuperthreadLists } from './api';

export type SuperthreadConfiguration = {
  ownerProjectId: string;
  spaces: string;
  workspaceSlug?: string;
};

export function superthreadIntegration(configuration: SuperthreadConfiguration): SuperthreadIntegration {
  const { ownerProjectId, spaces, workspaceSlug = '' } = configuration;
  return {
    kind: 'superthread',
    ownerProjectId,
    async create(title, content) {
      const card = await createSuperthreadCard({ spaces, workspaceSlug, title, content });
      return mapCard(card, {
        id: card.board_id,
        title: card.board_title,
      }, card.list_title, true, true);
    },
    async load(card) {
      const detail = await fetchSuperthreadCard(card.external_id, workspaceSlug);
      return mapCard(detail, { id: card.board_id, title: card.board_title }, card.list_title, true, true);
    },
    async sync(refresh = false): Promise<SuperthreadSnapshot> {
      let discovery;
      try {
        discovery = await fetchSuperthreadBoards(spaces, refresh);
      } catch (error) {
        const message = errorMessage(error);
        return { cards: [], successful_scope_ids: [], successful_board_ids: [], failed_scopes: [{ scope: 'spaces', message }], warnings: [message], complete: false };
      }
      const failedScopes = [...discovery.warnings];
      const successfulBoardIds: string[] = [];
      const cards: KanbanSyncCard[] = [];
      await Promise.all(discovery.boards.map(async (board) => {
        const [listsResult, cardsResult] = await Promise.allSettled([
          fetchSuperthreadLists(board.id),
          fetchSuperthreadCards(board.id, workspaceSlug),
        ]);
        if (listsResult.status === 'rejected') failedScopes.push({ scope: `board:${board.id}:lists`, message: errorMessage(listsResult.reason) });
        if (cardsResult.status === 'rejected') failedScopes.push({ scope: `board:${board.id}:cards`, message: errorMessage(cardsResult.reason) });
        if (listsResult.status === 'fulfilled' && cardsResult.status === 'fulfilled') successfulBoardIds.push(board.id);
        if (cardsResult.status !== 'fulfilled') return;
        const listById = new Map((listsResult.status === 'fulfilled' ? listsResult.value : []).map((list) => [list.id, list]));
        for (const card of cardsResult.value) {
          if (!card.id.trim() || !card.title.trim()) {
            failedScopes.push({ scope: `board:${board.id}:card`, message: 'Superthread returned a card without an ID or title' });
            continue;
          }
          if (!card.list_id.trim()) failedScopes.push({ scope: `board:${board.id}:card:${card.id}`, message: `Superthread card ${card.id} did not include its current list` });
          const discoveredTitle = listById.get(card.list_id)?.title;
          const listTitle = discoveredTitle ?? card.list_title;
          const scope = card.list_id.trim() && (discoveredTitle || card.list_title.trim())
            ? isManagedSuperthreadList(board.title, listTitle)
            : null;
          cards.push(mapCard(card, board, listTitle, scope, false));
        }
      }));
      const warnings = failedScopes.map((failure) => failure.message);
      return {
        cards,
        successful_scope_ids: discovery.successful_space_ids,
        successful_board_ids: successfulBoardIds,
        failed_scopes: failedScopes,
        warnings,
        complete: discovery.complete && failedScopes.length === 0 && successfulBoardIds.length === discovery.boards.length,
      };
    },
  };
}

function mapCard(
  card: Awaited<ReturnType<typeof fetchSuperthreadCard>>,
  board: { id: string; title: string },
  listTitle: string,
  inScope: boolean | null,
  parentRelationshipHydrated: boolean,
): KanbanSyncCard {
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
    task_parent_id: card.task_parent?.id ?? null,
    task_parent_title: card.task_parent?.title ?? null,
    parent_relationship_hydrated: parentRelationshipHydrated,
    total_task_children: card.total_task_children ?? 0,
    in_scope: inScope,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
