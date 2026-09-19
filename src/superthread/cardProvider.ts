import type { KanbanSyncCard, SuperthreadIntegration, SuperthreadParentHydration, SuperthreadSnapshot } from '../kanban/types';
import { createSuperthreadCard, fetchSuperthreadBoards, fetchSuperthreadCard, fetchSuperthreadCards, fetchSuperthreadLists } from './api';

export type SuperthreadConfiguration = {
  ownerProjectId: string;
  spaces: string;
  workspaceSlug?: string;
  boardId: string;
  boardName: string;
  incomingColumnIds: string[];
  defaultIncomingColumnId: string;
  apiTokenEnvVar?: string;
};

const HIERARCHY_CONCURRENCY = 4;

export function superthreadIntegration(configuration: SuperthreadConfiguration): SuperthreadIntegration {
  const { ownerProjectId, spaces, workspaceSlug = '', boardId, boardName, incomingColumnIds, defaultIncomingColumnId, apiTokenEnvVar = 'ST_TOKEN' } = configuration;
  const incomingIds = new Set(incomingColumnIds);
  return {
    kind: 'superthread',
    ownerProjectId,
    async create(title, content) {
      const card = await createSuperthreadCard({ boardId, listId: defaultIncomingColumnId, workspaceSlug, apiTokenEnvVar, title, content });
      return mapCard(card, { id: boardId, title: boardName }, card.list_title, true, true);
    },
    async load(card) {
      const detail = await fetchSuperthreadCard(card.external_id, workspaceSlug, apiTokenEnvVar);
      return mapCard(detail, { id: card.board_id, title: card.board_title }, card.list_title, true, true);
    },
    async sync(refresh = false, knownParentIds = []): Promise<SuperthreadSnapshot> {
      let discovery;
      try {
        discovery = await fetchSuperthreadBoards(spaces, refresh, apiTokenEnvVar);
      } catch (error) {
        const message = errorMessage(error);
        return { cards: [], parent_hydrations: [], successful_scope_ids: [], successful_board_ids: [], failed_scopes: [{ scope: 'spaces', message }], warnings: [message], complete: false };
      }
      const failedScopes = [...discovery.warnings];
      const successfulBoardIds: string[] = [];
      const cards: KanbanSyncCard[] = [];
      const listedChildCounts = new Map<string, number>();
      const discoveredBoard = discovery.boards.find((board) => board.id === boardId);
      if (!discoveredBoard) failedScopes.push({ scope: `board:${boardId}`, message: `Configured Superthread board ${boardName || boardId} was not found or is inaccessible` });
      const boards = discoveredBoard ? [discoveredBoard] : [];
      await Promise.all(boards.map(async (board) => {
        const [listsResult, cardsResult] = await Promise.allSettled([
          fetchSuperthreadLists(board.id, apiTokenEnvVar),
          fetchSuperthreadCards(board.id, workspaceSlug, apiTokenEnvVar),
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
          if (card.total_task_children !== undefined) listedChildCounts.set(card.id, card.total_task_children);
          const discoveredTitle = listById.get(card.list_id)?.title;
          const listTitle = discoveredTitle ?? card.list_title;
          const scope = listsResult.status === 'fulfilled' && card.list_id.trim() && (discoveredTitle || card.list_title.trim())
            ? incomingIds.has(card.list_id)
            : null;
          cards.push(mapCard(card, board, listTitle, scope, false));
        }
      }));

      const parentIds = new Set(knownParentIds.map(normalizeExternalId).filter(Boolean));
      for (const card of cards) if ((card.total_task_children ?? 0) > 0) parentIds.add(card.id);
      const hierarchyResults = await mapWithConcurrency([...parentIds].sort(compareIds), HIERARCHY_CONCURRENCY, async (parentId) => {
        try {
          const detail = await fetchSuperthreadCard(parentId, workspaceSlug, apiTokenEnvVar);
          if (detail.id.trim() !== parentId) throw new Error(`Superthread returned card ${detail.id || '(missing ID)'} instead`);
          if (!detail.title.trim()) throw new Error('the parent title was not included');
          const expectedCount = listedChildCounts.get(parentId) ?? detail.total_task_children;
          if (!Array.isArray(detail.task_children) && expectedCount !== 0) throw new Error('the child relationship collection was not included');
          const children = (detail.task_children ?? []).map((child) => ({ id: child.task_id?.trim(), title: child.title?.trim(), status: child.status ?? '' }));
          if (children.some((child) => !child.id || !child.title)) throw new Error('the child relationship collection was incomplete');
          if (new Set(children.map((child) => child.id)).size !== children.length) throw new Error('the child relationship collection contained duplicate IDs');
          if (expectedCount !== undefined && expectedCount !== children.length) {
            throw new Error(`expected ${expectedCount} children but received ${children.length}`);
          }
          return { parent_id: parentId, parent_title: detail.title.trim(), children } satisfies SuperthreadParentHydration;
        } catch (error) {
          failedScopes.push({ scope: `parent:${parentId}:hierarchy`, message: `Could not hydrate parent ${parentId}: ${errorMessage(error)}` });
          return null;
        }
      });

      const parentHydrations = hierarchyResults.filter((result): result is SuperthreadParentHydration => result !== null);
      const claims = new Map<string, string[]>();
      for (const hydration of parentHydrations) for (const child of hydration.children) {
        const parents = claims.get(child.id) ?? [];
        parents.push(hydration.parent_id);
        claims.set(child.id, parents);
      }
      const conflictingParents = new Set<string>();
      for (const [childId, parents] of claims) if (parents.length > 1) {
        for (const parentId of parents) conflictingParents.add(parentId);
        for (const parentId of parents) failedScopes.push({
          scope: `parent:${parentId}:hierarchy`,
          message: `Could not hydrate parent ${parentId}: child ${childId} was also claimed by ${parents.filter((id) => id !== parentId).join(', ')}`,
        });
      }
      const authoritativeHydrations = parentHydrations.filter((hydration) => !conflictingParents.has(hydration.parent_id));
      const warnings = failedScopes.map((failure) => failure.message);
      return {
        cards,
        parent_hydrations: authoritativeHydrations,
        successful_scope_ids: discovery.successful_space_ids,
        successful_board_ids: successfulBoardIds,
        failed_scopes: failedScopes,
        warnings,
        complete: discovery.complete && failedScopes.length === 0 && successfulBoardIds.length === boards.length,
      };
    },
  };
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index]);
    }
  }));
  return results;
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
    task_parent_id: card.task_parent?.id.trim() || null,
    task_parent_title: card.task_parent?.title.trim() || null,
    parent_relationship_hydrated: parentRelationshipHydrated,
    total_task_children: card.total_task_children ?? 0,
    in_scope: inScope,
  };
}

function normalizeExternalId(id: string) {
  return id.trim().replace(/^superthread:/, '');
}

function compareIds(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
