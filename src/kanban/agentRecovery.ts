import type { Project } from '../types';
import type { PiModel } from '../pi/types';
import { getPiSessionController, type PiSessionConfig } from '../pi/sessionController';
import { buildCardSetupCommand } from '../superthread/startWork';
import { recordKanbanAgentRetry, startKanbanEnvironment } from './api';
import { AGENT_RETRY_MAX_ATTEMPTS, retryDelaySeconds } from './agentFailure';
import { cardPaneId, cardWorkspaceId } from './cardWorkspace';
import type { CardAgentRetry, KanbanCardDetail } from './types';

export function cardAgentThread(card: KanbanCardDetail): 'planning' | 'work' {
  return card.environment ? 'work' : 'planning';
}

export function cardAgentConfig(card: KanbanCardDetail, project: Project): PiSessionConfig {
  const thread = cardAgentThread(card);
  return {
    paneId: cardPaneId(card.id, thread),
    cwd: thread === 'work' ? card.environment?.worktree_path || project.path : project.path,
    workspaceId: cardWorkspaceId(card.id),
    projectId: project.id,
    projectPath: project.path,
  };
}

export function cardAgentController(card: KanbanCardDetail, project: Project) {
  return getPiSessionController(cardAgentConfig(card, project));
}

async function ensureAgentStarted(controller: ReturnType<typeof cardAgentController>) {
  await controller.initializeAndHydrate();
  const snapshot = controller.getSnapshot();
  if (snapshot.stopped || snapshot.error) await controller.restart();
}

export async function continueCardAgent(card: KanbanCardDetail, project: Project, note = 'continue') {
  const controller = cardAgentController(card, project);
  await ensureAgentStarted(controller);
  const text = note.trim() || 'continue';
  if (controller.getSnapshot().isStreaming) await controller.followUp(text);
  else await controller.prompt(text);
}

export async function restartCardAgent(card: KanbanCardDetail, project: Project) {
  const controller = cardAgentController(card, project);
  try { await controller.initializeAndHydrate(); } catch { /* restart below owns recovery */ }
  await controller.restart();
  if (!controller.getSnapshot().isStreaming) await controller.prompt('continue');
}

export async function chooseCardModel(card: KanbanCardDetail, project: Project, model: PiModel) {
  const controller = cardAgentController(card, project);
  await ensureAgentStarted(controller);
  await controller.selectModel(model);
  await controller.prompt('continue');
}

export async function retryCardSetup(card: KanbanCardDetail, project: Project) {
  const setup = buildCardSetupCommand(card, project);
  if (!setup) throw new Error('Start-work setup command is empty');
  return startKanbanEnvironment(
    card.id,
    card.workflow_revision,
    setup,
    card.provider === 'superthread' || Boolean(project.start_work_command?.trim()),
    true,
  );
}

export function scheduleCardRetry(card: KanbanCardDetail, delaySeconds = retryDelaySeconds(1)) {
  const nextRetryAt = Math.floor(Date.now() / 1000) + delaySeconds;
  return recordKanbanAgentRetry(card.id, 'agent_retry_scheduled', 1, AGENT_RETRY_MAX_ATTEMPTS, nextRetryAt);
}

export function scheduleNextCardRetry(card: KanbanCardDetail, retry: CardAgentRetry) {
  const attempt = retry.attempt + 1;
  if (attempt > retry.max_attempts) return Promise.resolve(null);
  const nextRetryAt = Math.floor(Date.now() / 1000) + retryDelaySeconds(attempt);
  return recordKanbanAgentRetry(card.id, 'agent_retry_scheduled', attempt, retry.max_attempts, nextRetryAt);
}

export function cancelCardRetry(card: KanbanCardDetail, retry: CardAgentRetry) {
  return recordKanbanAgentRetry(card.id, 'agent_retry_cancelled', retry.attempt, retry.max_attempts, null);
}

export async function claimCardRetry(card: KanbanCardDetail, retry: CardAgentRetry) {
  const snapshot = await recordKanbanAgentRetry(card.id, 'agent_retry_attempted', retry.attempt, retry.max_attempts, null);
  return snapshot;
}
