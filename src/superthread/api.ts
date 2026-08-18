import { invoke } from '@tauri-apps/api/core';
import type { SuperthreadBoard, SuperthreadBoardsResponse, SuperthreadCard, SuperthreadList } from './types';

export function fetchSuperthreadBoards(spaces: string, refresh = false) {
  return invoke<SuperthreadBoardsResponse>('superthread_boards', { spaces: parseSuperthreadSpaces(spaces), refresh });
}

export function fetchSuperthreadLists(boardId: string) {
  return invoke<SuperthreadList[]>('superthread_board_lists', { boardId });
}

export function fetchSuperthreadCards(boardId: string, workspaceSlug: string) {
  return invoke<SuperthreadCard[]>('superthread_board_cards', { boardId, workspaceSlug: workspaceSlug || null });
}

export function fetchSuperthreadCard(cardId: string, workspaceSlug: string) {
  return invoke<SuperthreadCard>('superthread_card', { cardId, workspaceSlug: workspaceSlug || null });
}

export function parseSuperthreadSpaces(value: string) {
  return [...new Set(value.split(',').map((space) => space.trim()).filter(Boolean))];
}

export function emptyBoard(board: Pick<SuperthreadBoard, 'id' | 'title'>): SuperthreadBoard {
  return { ...board, lists: [], cards: [] };
}
