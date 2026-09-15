import { describe, expect, it, vi } from 'vitest';
import type { EnvironmentStartPreflight } from './api';
import { startKanbanEnvironment } from './startEnvironment';

const originalPreflight: EnvironmentStartPreflight = {
  repository_id: 'repo-1',
  target_checkout_path: '/code/project',
  target_branch: 'main',
  target_revision: 'revision-before-setup',
};
const refreshedPreflight: EnvironmentStartPreflight = {
  ...originalPreflight,
  target_revision: 'revision-after-setup',
};

function dependencies(preflights: EnvironmentStartPreflight[]) {
  return {
    preflight: vi.fn()
      .mockResolvedValueOnce(preflights[0])
      .mockResolvedValueOnce(preflights[1]),
    runSetup: vi.fn().mockResolvedValue({ cwd: '/code/project-card-38', output: 'created worktree' }),
    createEnvironment: vi.fn().mockResolvedValue({ id: 'environment-38' }),
  };
}

describe('startKanbanEnvironment', () => {
  it('registers a normal local setup after matching preflights', async () => {
    const deps = dependencies([originalPreflight, originalPreflight]);

    const result = await startKanbanEnvironment({
      cardId: 'local:38',
      expectedWorkflowRevision: 7,
      ...deps,
    });

    expect(result).toEqual({
      created: { id: 'environment-38' },
      setup: { cwd: '/code/project-card-38', output: 'created worktree' },
    });
    expect(deps.preflight).toHaveBeenCalledTimes(2);
    expect(deps.runSetup).toHaveBeenCalledOnce();
    expect(deps.createEnvironment).toHaveBeenCalledWith('local:38', '/code/project-card-38', originalPreflight, 7);
    expect(deps.preflight.mock.invocationCallOrder[0]).toBeLessThan(deps.runSetup.mock.invocationCallOrder[0]);
    expect(deps.runSetup.mock.invocationCallOrder[0]).toBeLessThan(deps.preflight.mock.invocationCallOrder[1]);
    expect(deps.preflight.mock.invocationCallOrder[1]).toBeLessThan(deps.createEnvironment.mock.invocationCallOrder[0]);
  });

  it('does not run setup when the initial preflight fails', async () => {
    const deps = dependencies([originalPreflight, refreshedPreflight]);
    deps.preflight.mockReset().mockRejectedValueOnce(new Error('Target checkout is dirty'));

    await expect(startKanbanEnvironment({
      cardId: 'local:38',
      expectedWorkflowRevision: 9,
      ...deps,
    })).rejects.toThrow('Target checkout is dirty');
    expect(deps.runSetup).not.toHaveBeenCalled();
    expect(deps.createEnvironment).not.toHaveBeenCalled();
  });

  it('registers a custom setup with the refreshed target revision', async () => {
    const deps = dependencies([originalPreflight, refreshedPreflight]);

    await startKanbanEnvironment({
      cardId: 'superthread:38',
      expectedWorkflowRevision: 11,
      ...deps,
    });

    expect(deps.createEnvironment).toHaveBeenCalledWith(
      'superthread:38',
      '/code/project-card-38',
      refreshedPreflight,
      11,
    );
  });

  it('does not register when the second preflight fails', async () => {
    const deps = dependencies([originalPreflight, refreshedPreflight]);
    deps.preflight.mockReset()
      .mockResolvedValueOnce(originalPreflight)
      .mockRejectedValueOnce(new Error('Target checkout is dirty'));

    await expect(startKanbanEnvironment({
      cardId: 'superthread:38',
      expectedWorkflowRevision: 13,
      ...deps,
    })).rejects.toThrow('Target checkout is dirty\nSetup result: /code/project-card-38\nSetup output:\ncreated worktree');
    expect(deps.createEnvironment).not.toHaveBeenCalled();
  });

  it('uses the same expected workflow revision for both preflights and creation', async () => {
    const deps = dependencies([originalPreflight, refreshedPreflight]);

    await startKanbanEnvironment({
      cardId: 'superthread:38',
      expectedWorkflowRevision: 17,
      ...deps,
    });

    expect(deps.preflight.mock.calls).toEqual([
      ['superthread:38', 17],
      ['superthread:38', 17],
    ]);
    expect(deps.createEnvironment).toHaveBeenCalledWith(
      'superthread:38',
      '/code/project-card-38',
      refreshedPreflight,
      17,
    );
  });
});
