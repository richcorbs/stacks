import type { Project } from '../types';
import { deletePiSessionController, getPiSessionController, type PiSessionConfig } from '../pi/sessionController';
import { fetchKanbanCard, recordKanbanRefinementLaunchFailure, startKanbanRefinementLaunch } from './api';
import { cardChatPrompt, cardPaneId, cardWorkspaceId } from './cardWorkspace';
import type { CardSnapshot, KanbanCard, KanbanCardSummary } from './types';

export type PlanningLaunchDependencies = {
  latestCard: (cardId: string) => Promise<KanbanCard | null>;
  beginRefinement: (card: KanbanCard) => Promise<CardSnapshot>;
  submit: (config: PiSessionConfig, prompt: string, stillEligible: () => Promise<boolean>) => Promise<boolean>;
  recordFailure: (card: KanbanCard, message: string) => Promise<CardSnapshot>;
  releaseController: (paneId: string) => void;
  applyCard: (card: KanbanCardSummary, boardRevision?: number) => void;
};

function defaultDependencies(applyCard: PlanningLaunchDependencies['applyCard']): PlanningLaunchDependencies {
  return {
    latestCard: async (cardId) => {
      try { return (await fetchKanbanCard(cardId)).card; }
      catch (error) {
        if (String(error).toLowerCase().includes('not found')) return null;
        throw error;
      }
    },
    beginRefinement: (card) => startKanbanRefinementLaunch(card.id, card.workflow_revision, card.project_id!),
    submit: (config, prompt, stillEligible) => getPiSessionController(config).submitWorkLaunch(prompt, stillEligible),
    recordFailure: (card, message) => recordKanbanRefinementLaunchFailure(card.id, card.workflow_revision, card.project_id!, message),
    releaseController: deletePiSessionController,
    applyCard,
  };
}

const launches = new Map<string, Promise<boolean>>();

/** Starts a planning conversation without requiring the card-detail UI to exist. */
export function launchPlanningAgent(
  cardId: string,
  projects: Project[],
  applyCard: PlanningLaunchDependencies['applyCard'],
  dependencies: PlanningLaunchDependencies = defaultDependencies(applyCard),
) {
  const existing = launches.get(cardId);
  if (existing) return existing;
  const launch = runPlanningLaunch(cardId, projects, dependencies);
  launches.set(cardId, launch);
  launch.finally(() => { if (launches.get(cardId) === launch) launches.delete(cardId); }).catch(() => {});
  return launch;
}

export async function runPlanningLaunch(cardId: string, projects: Project[], dependencies: PlanningLaunchDependencies) {
  const initial = await dependencies.latestCard(cardId);
  const eligibility = eligiblePlanningLaunch(initial, projects, ['needs_refinement']);
  if (!eligibility) return false;

  const started = await dependencies.beginRefinement(initial!);
  dependencies.applyCard(started.card, started.board_revision);
  let launchCard = started.card;
  const paneId = cardPaneId(cardId, 'planning');
  const config: PiSessionConfig = {
    paneId,
    cwd: eligibility.project.path,
    workspaceId: cardWorkspaceId(cardId),
    projectId: eligibility.project.id,
    projectPath: eligibility.project.path,
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const accepted = await dependencies.submit(config, cardChatPrompt(launchCard, 'planning'), async () => {
        const latest = await dependencies.latestCard(cardId);
        const current = eligiblePlanningLaunch(latest, projects, ['refining']);
        if (current && latest!.project_id === eligibility.project.id) launchCard = latest!;
        return Boolean(current && latest!.project_id === eligibility.project.id);
      });
      if (!accepted) return false;
      return true;
    } catch (error) {
      lastError = error;
      dependencies.releaseController(paneId);
      if (attempt === 0) {
        const latest = await dependencies.latestCard(cardId);
        const current = eligiblePlanningLaunch(latest, projects, ['refining', 'needs_refinement_input']);
        if (!current || latest!.project_id !== eligibility.project.id) return false;
        if (latest!.status === 'needs_refinement_input') {
          const restarted = await dependencies.beginRefinement(latest!);
          dependencies.applyCard(restarted.card, restarted.board_revision);
          launchCard = restarted.card;
        } else launchCard = latest!;
      }
    }
  }

  const message = errorMessage(lastError);
  try {
    const failed = await dependencies.recordFailure(launchCard, message);
    dependencies.applyCard(failed.card, failed.board_revision);
  } catch { /* A deleted, reassigned, or advanced card must remain untouched. */ }
  throw new Error(`Refinement could not be started: ${message}`);
}

function eligiblePlanningLaunch(card: KanbanCard | null, projects: Project[], statuses: KanbanCard['status'][]) {
  if (!card?.project_id || !statuses.includes(card.status)) return null;
  const project = projects.find((candidate) => candidate.id === card.project_id);
  return project ? { project } : null;
}

export function resetPlanningLaunchesForTests() { launches.clear(); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
