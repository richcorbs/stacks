import { showAppToast } from '../applicationEvents';
import { invoke } from '@tauri-apps/api/core';
import type { Project } from '../types';
import { getPiSessionController, type PiSessionConfig } from '../pi/sessionController';
import { fetchKanbanCard } from './api';
import { cardPaneId, cardWorkspaceId, type CardChatThread } from './cardWorkspace';
import type { KanbanCardSummary, KanbanStatus } from './types';
import { launchWorkAgent } from './workAgentLauncher';

export type LaunchRecoveryItem = {
  cardId: string;
  title: string;
  externalId: string;
  expectedStatus: Extract<KanbanStatus, 'agent_working' | 'refining'>;
  thread: CardChatThread;
};

export type LaunchRecoveryFailure = {
  item: LaunchRecoveryItem;
  error: string;
};

export type LaunchRecoveryDependencies = {
  latestCard: (cardId: string) => Promise<KanbanCardSummary | null>;
  hasPersistedSession: (paneId: string) => Promise<boolean>;
  submitContinue: (config: PiSessionConfig, stillEligible: () => Promise<boolean>) => Promise<boolean>;
  launchWork: (cardId: string, projects: Project[]) => Promise<boolean>;
};

export function startupCardRecoveryAllowed() {
  return invoke<boolean>('startup_card_recovery_allowed');
}

const defaultDependencies: LaunchRecoveryDependencies = {
  latestCard: async (cardId) => {
    try { return (await fetchKanbanCard(cardId)).card; }
    catch (error) {
      if (String(error).toLowerCase().includes('not found')) return null;
      throw error;
    }
  },
  hasPersistedSession: (paneId) => invoke<boolean>('pi_session_exists', { paneId }),
  submitContinue: (config, stillEligible) => getPiSessionController(config).submitLaunchContinue(stillEligible),
  launchWork: launchWorkAgent,
};

/** Work cards lead; filtering preserves the canonical lane/card order in each group. */
export function launchRecoveryItems(cards: KanbanCardSummary[]): LaunchRecoveryItem[] {
  const items = (status: LaunchRecoveryItem['expectedStatus'], thread: CardChatThread) => cards
    .filter((card) => card.status === status)
    .map((card) => ({ cardId: card.id, title: card.title, externalId: card.external_id, expectedStatus: status, thread }));
  return [...items('agent_working', 'work'), ...items('refining', 'planning')];
}

export async function runLaunchCardRecovery(
  initialCards: KanbanCardSummary[],
  projects: Project[],
  dependencies: LaunchRecoveryDependencies = defaultDependencies,
): Promise<LaunchRecoveryFailure[]> {
  const failures: LaunchRecoveryFailure[] = [];
  for (const item of launchRecoveryItems(initialCards)) {
    try {
      // This authoritative read happens immediately before any process work.
      const card = await dependencies.latestCard(item.cardId);
      if (!card || card.status !== item.expectedStatus) continue;
      const project = projects.find((candidate) => candidate.id === card.project_id);
      if (!project) throw new Error('owning project is missing');
      if (item.thread === 'work') {
        if (!await dependencies.launchWork(card.id, projects)) throw new Error('card changed before recovery could launch');
        continue;
      }
      const paneId = cardPaneId(card.id, item.thread);
      if (!await dependencies.hasPersistedSession(paneId)) throw new Error('existing Pi conversation is missing');
      await dependencies.submitContinue({
        paneId,
        cwd: project.path,
        workspaceId: cardWorkspaceId(card.id),
        projectId: project.id,
        projectPath: project.path,
      }, async () => (await dependencies.latestCard(item.cardId))?.status === item.expectedStatus);
    } catch (error) {
      failures.push({ item, error: errorMessage(error) });
    }
  }
  return failures;
}

let launchRecovery: Promise<LaunchRecoveryFailure[]> | null = null;

/** Process-lifetime gate: React remounts and Strict Mode cannot launch a second queue. */
export function startLaunchCardRecovery(
  cards: KanbanCardSummary[],
  projects: Project[],
  dependencies: LaunchRecoveryDependencies = defaultDependencies,
  notify: (failures: LaunchRecoveryFailure[]) => void = notifyLaunchRecoveryFailures,
) {
  if (!launchRecovery) {
    launchRecovery = runLaunchCardRecovery(cards, projects, dependencies);
    launchRecovery.then(notify);
  }
  return launchRecovery;
}

function notifyLaunchRecoveryFailures(failures: LaunchRecoveryFailure[]) {
  const message = launchRecoveryToast(failures);
  if (!message) return;
  console.warn('Automatic card recovery failures', failures);
  showAppToast(message);
}

export function launchRecoveryToast(failures: LaunchRecoveryFailure[]) {
  if (!failures.length) return null;
  const labels = failures.slice(0, 3).map(({ item }) => `#${item.externalId} ${item.title}`);
  const extra = failures.length - labels.length;
  return `Could not automatically continue ${failures.length} ${failures.length === 1 ? 'card' : 'cards'}: ${labels.join(', ')}${extra > 0 ? `, and ${extra} more` : ''}`;
}

/** Test-only process boundary reset. */
export function resetLaunchCardRecoveryForTests() {
  launchRecovery = null;
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
