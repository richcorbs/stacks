import { workAgentId, workOwnerId, workTerminalId } from '../directWork';
import { statusLabel as childStatusLabel } from './hierarchy';
import type { KanbanCard } from './types';

export type CardChatThread = 'planning' | 'work';
export type CardServiceMode = 'server' | 'console';

export function cardWorkspaceId(cardId: string) {
  return workOwnerId({ kind: 'card', cardId });
}

export function cardPaneId(cardId: string, thread: CardChatThread) {
  return workAgentId({ kind: 'card', cardId }, thread);
}

export function cardTerminalId(cardId: string, mode: string) {
  return workTerminalId({ kind: 'card', cardId }, mode);
}

export function cardChatPrompt(card: KanbanCard, thread: CardChatThread) {
  const description = card.content.trim().slice(0, 12_000) || '(No description was provided.)';
  const cardReference = card.provider === 'local' ? `local card #${card.external_id}` : `Superthread card #${card.external_id}`;
  if (thread === 'work') {
    return `Implement ${cardReference}: ${card.title} in its dedicated worktree and branch. Inspect the repository and card details, make the required changes, validate them, and report relevant progress or decisions. Ask when human input is required.\n\nDescription:\n${description}`;
  }
  const existingChildren = card.children.length > 0
    ? ` Existing linked draft children (preserve every one in an approved breakdown): ${card.children.map((child) => `${child.id} (#${child.external_id} ${child.title}, ${childStatusLabel(child.status)})`).join('; ')}.`
    : '';
  const localBreakdown = card.provider === 'local'
    ? ' When useful, propose self-contained, independently deployable child cards, but do not split work unnecessarily.'
    : '';
  return `This is the planning conversation for ${cardReference}: ${card.title}. Do not implement or modify files. Inspect the primary checkout as needed, ask focused questions one at a time, and produce a concise, self-contained brief covering the desired outcome, acceptance criteria, technical approach, risks or open questions, and validation plan. Do not finish refinement until I explicitly approve the final brief or breakdown.${localBreakdown}${existingChildren}\n\nDescription:\n${description}`;
}
