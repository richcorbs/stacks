import type { Project } from '../types';
import { deletePiSessionController, getPiSessionController, type PiSessionConfig } from '../pi/sessionController';
import { fetchKanbanCard, recordKanbanAgentLaunchFailure } from './api';
import { cardChatPrompt, cardPaneId, cardWorkspaceId } from './cardWorkspace';
import type { KanbanCard } from './types';

export type WorkAgentLaunchDependencies = {
  latestCard: (cardId: string) => Promise<KanbanCard | null>;
  submit: (config: PiSessionConfig, prompt: string, stillEligible: () => Promise<boolean>) => Promise<boolean>;
  recordFailure: (card: KanbanCard, message: string) => Promise<void>;
  releaseController: (paneId: string) => void;
};

const defaultDependencies: WorkAgentLaunchDependencies = {
  latestCard: async (cardId) => {
    try { return (await fetchKanbanCard(cardId)).card; }
    catch (error) {
      if (String(error).toLowerCase().includes('not found')) return null;
      throw error;
    }
  },
  submit: (config, prompt, stillEligible) => getPiSessionController(config).submitWorkLaunch(prompt, stillEligible),
  recordFailure: async (card, message) => {
    await recordKanbanAgentLaunchFailure(card.id, card.workflow_revision, card.project_id!, message);
  },
  releaseController: deletePiSessionController,
};

const launches = new Map<string, Promise<boolean>>();

/** Process-retained, per-card launch gate shared by card views, navigation, and recovery. */
export function launchWorkAgent(cardId: string, projects: Project[], dependencies: WorkAgentLaunchDependencies = defaultDependencies) {
  const existing = launches.get(cardId);
  if (existing) return existing;
  const launch = runWorkAgentLaunch(cardId, projects, dependencies);
  launches.set(cardId, launch);
  launch.finally(() => { if (launches.get(cardId) === launch) launches.delete(cardId); }).catch(() => {});
  return launch;
}

export async function runWorkAgentLaunch(cardId: string, projects: Project[], dependencies: WorkAgentLaunchDependencies = defaultDependencies) {
  let attempted: KanbanCard | null = null;
  let paneId: string | null = null;
  try {
    // Read immediately before configuring or starting a process. This card is
    // also the source of the immutable prompt submitted for this attempt.
    const card = await dependencies.latestCard(cardId);
    const launch = eligibleWorkLaunch(card, projects);
    if (!launch) return false;
    attempted = card!;
    paneId = cardPaneId(cardId, 'work');
    const config: PiSessionConfig = {
      paneId,
      cwd: launch.worktreePath,
      workspaceId: cardWorkspaceId(cardId),
      projectId: launch.project.id,
      projectPath: launch.project.path,
    };
    return await dependencies.submit(config, cardChatPrompt(card!, 'work'), async () => {
      // Hydration can take long enough for deletion, reassignment, cleanup, or
      // another workflow action. Revalidate immediately before prompt submit.
      const latest = await dependencies.latestCard(cardId);
      const current = eligibleWorkLaunch(latest, projects);
      return Boolean(current
        && latest?.project_id === launch.project.id
        && current.worktreePath === launch.worktreePath);
    });
  } catch (error) {
    const message = errorMessage(error);
    if (attempted) {
      try { await dependencies.recordFailure(attempted, message); }
      catch { /* A stale/deleted/reassigned card must not be changed. */ }
    }
    if (paneId) dependencies.releaseController(paneId);
    throw new Error(`Work agent could not be started: ${message}`);
  }
}

function eligibleWorkLaunch(card: KanbanCard | null, projects: Project[]) {
  if (!card || !card.project_id || !['agent_working', 'needs_human'].includes(card.status)) return null;
  const project = projects.find((candidate) => candidate.id === card.project_id);
  const environment = card.environment;
  if (!project || !environment || environment.project_id !== project.id
    || environment.lifecycle_state !== 'ready' || !environment.worktree_path.trim()) return null;
  return { project, worktreePath: environment.worktree_path };
}

export function resetWorkAgentLaunchesForTests() { launches.clear(); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
