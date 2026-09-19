import { invoke } from '@tauri-apps/api/core';
import type { CreateSuperthreadCardRequest, SuperthreadBoard, SuperthreadBoardsResponse, SuperthreadCard, SuperthreadList, SuperthreadMappingDraft, SuperthreadMappingTestResult } from './types';

export function fetchSuperthreadBoards(spaces: string, refresh = false, apiTokenEnvVar = 'ST_TOKEN') {
  return invoke<SuperthreadBoardsResponse>('superthread_boards', { spaces: parseSuperthreadSpaces(spaces), refresh, apiTokenEnvVar });
}

export function fetchSuperthreadLists(boardId: string, apiTokenEnvVar = 'ST_TOKEN') {
  return invoke<SuperthreadList[]>('superthread_board_lists', { boardId, apiTokenEnvVar });
}

export function fetchSuperthreadCards(boardId: string, workspaceSlug: string, apiTokenEnvVar = 'ST_TOKEN') {
  return invoke<SuperthreadCard[]>('superthread_board_cards', { boardId, workspaceSlug: workspaceSlug || null, apiTokenEnvVar });
}

export function fetchSuperthreadCard(cardId: string, workspaceSlug: string, apiTokenEnvVar = 'ST_TOKEN') {
  return invoke<SuperthreadCard>('superthread_card', { cardId, workspaceSlug: workspaceSlug || null, apiTokenEnvVar });
}

export function createSuperthreadCard(request: CreateSuperthreadCardRequest) {
  return invoke<SuperthreadCard>('superthread_create_card', {
    boardId: request.boardId,
    listId: request.listId,
    workspaceSlug: request.workspaceSlug || null,
    title: request.title,
    content: request.content,
    apiTokenEnvVar: request.apiTokenEnvVar,
  });
}

export function testSuperthreadMapping(configuration: SuperthreadMappingDraft) {
  return invoke<SuperthreadMappingTestResult>('superthread_test_mapping', { configuration });
}

export function parseSuperthreadSpaces(value: string) {
  return [...new Set(value.split(',').map((space) => space.trim()).filter(Boolean))];
}

export function emptyBoard(board: Pick<SuperthreadBoard, 'id' | 'title'>): SuperthreadBoard {
  return { ...board, lists: [], cards: [] };
}
