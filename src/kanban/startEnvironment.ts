import type { EnvironmentStartPreflight } from './api';

export type KanbanEnvironmentSetupResult = { cwd: string; output: string };

type StartKanbanEnvironmentOptions<T> = {
  cardId: string;
  expectedWorkflowRevision: number;
  runSetup: () => Promise<KanbanEnvironmentSetupResult>;
  preflight: (cardId: string, expectedWorkflowRevision: number) => Promise<EnvironmentStartPreflight>;
  createEnvironment: (
    cardId: string,
    worktreePath: string,
    preflight: EnvironmentStartPreflight,
    expectedWorkflowRevision: number,
  ) => Promise<T>;
};

/**
 * Validates the target before setup, then refreshes that snapshot immediately
 * before registration so setup commands may legitimately update the target.
 */
export async function startKanbanEnvironment<T>({
  cardId,
  expectedWorkflowRevision,
  runSetup,
  preflight,
  createEnvironment,
}: StartKanbanEnvironmentOptions<T>): Promise<{ created: T; setup: KanbanEnvironmentSetupResult }> {
  await preflight(cardId, expectedWorkflowRevision);
  const setup = await runSetup();

  try {
    const refreshedPreflight = await preflight(cardId, expectedWorkflowRevision);
    const created = await createEnvironment(cardId, setup.cwd, refreshedPreflight, expectedWorkflowRevision);
    return { created, setup };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\nSetup result: ${setup.cwd}\nSetup output:\n${setup.output.trim() || '(no output)'}`);
  }
}
