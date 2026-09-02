import { describe, expect, it, vi } from 'vitest';
import type { AutomationRequestDependencies } from './processAutomationRequest';
import { processAutomationRequest } from './processAutomationRequest';
import type { WorkspaceCreation } from './createWorkspace';

const creation: WorkspaceCreation = {
  store: { projects: [] },
  projectId: 'project-1',
  workspace: {
    id: 'workspace-1',
    name: 'Tests',
    command: null,
    cwd: '/repo',
    splits: { kind: 'leaf', terminalId: 'workspace-1:0' },
  },
  terminals: [{ id: 'workspace-1:0', workspaceId: 'workspace-1', command: null }],
  root: { kind: 'leaf', terminalId: 'workspace-1:0' },
  focusedTerminalId: 'workspace-1:0',
};

function dependencies(overrides: Partial<AutomationRequestDependencies> = {}): AutomationRequestDependencies {
  return {
    createWorkspace: vi.fn().mockResolvedValue(creation),
    rollbackWorkspace: vi.fn().mockResolvedValue(undefined),
    waitForTerminalStartup: vi.fn().mockResolvedValue(undefined),
    prepareRunOnceCommand: vi.fn().mockReturnValue({
      startupCommand: 'wrapped command',
      completion: Promise.resolve({ terminalId: 'workspace-1:0', exitCode: 0 }),
      cancel: vi.fn(),
    }),
    ...overrides,
  };
}

describe('processAutomationRequest', () => {
  it('completes persisted startup workspace creation', async () => {
    const deps = dependencies();
    const response = await processAutomationRequest({
      requestId: 'request-1',
      action: 'createWorkspace',
      name: 'Dev',
      startupCommand: 'npm run dev',
    }, 'project-1', deps);

    expect(deps.createWorkspace).toHaveBeenCalledWith({
      projectId: 'project-1',
      name: 'Dev',
      command: 'npm run dev',
      oneTimeStartupCommand: undefined,
      rows: 1,
      columns: 1,
    });
    expect(deps.waitForTerminalStartup).toHaveBeenCalledWith('workspace-1:0');
    expect(response.ok).toBe(true);
  });

  it('waits for shell readiness and returns the run-once exit status', async () => {
    const deps = dependencies({
      prepareRunOnceCommand: vi.fn().mockReturnValue({
        startupCommand: 'wrapped npm test',
        completion: Promise.resolve({ terminalId: 'workspace-1:0', exitCode: 7 }),
        cancel: vi.fn(),
      }),
    });
    const response = await processAutomationRequest({
      requestId: 'request-1',
      action: 'createWorkspace',
      name: 'Tests',
      runOnce: 'npm test',
    }, 'project-1', deps);

    expect(deps.prepareRunOnceCommand).toHaveBeenCalledWith('npm test');
    expect(deps.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      command: undefined,
      oneTimeStartupCommand: 'wrapped npm test',
    }));
    expect(response).toMatchObject({ ok: false, exitCode: 7, workspaceId: 'workspace-1' });
    expect(deps.rollbackWorkspace).not.toHaveBeenCalled();
  });

  it('rolls back when terminal startup fails', async () => {
    const deps = dependencies({
      waitForTerminalStartup: vi.fn().mockRejectedValue(new Error('spawn failed')),
    });
    const response = await processAutomationRequest({
      requestId: 'request-1',
      action: 'createWorkspace',
      name: 'Broken',
    }, 'project-1', deps);

    expect(deps.rollbackWorkspace).toHaveBeenCalledWith(creation);
    expect(response).toMatchObject({ ok: false, workspaceId: null });
    expect(response.message).toContain('rolled back');
  });

  it('rejects a request without an active project before creating anything', async () => {
    const deps = dependencies();
    const response = await processAutomationRequest({
      requestId: 'request-1',
      action: 'createWorkspace',
      name: 'No project',
    }, null, deps);

    expect(response.ok).toBe(false);
    expect(deps.createWorkspace).not.toHaveBeenCalled();
  });
});
