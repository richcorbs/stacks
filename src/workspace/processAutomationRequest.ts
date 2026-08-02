import type { PreparedRunOnceCommand } from '../terminalAutomation';
import type { AutomationRequest, AutomationResponse } from './automation';
import type { CreateWorkspace, RollbackWorkspace, WorkspaceCreation } from './createWorkspace';

export type AutomationRequestDependencies = {
  createWorkspace: CreateWorkspace;
  rollbackWorkspace: RollbackWorkspace;
  waitForTerminalStartup: (terminalId: string) => Promise<void>;
  prepareRunOnceCommand: (command: string) => PreparedRunOnceCommand;
};

export async function processAutomationRequest(
  request: AutomationRequest,
  activeProjectId: string | null,
  dependencies: AutomationRequestDependencies,
): Promise<AutomationResponse> {
  let creation: WorkspaceCreation | null = null;
  let preparedRunOnce: PreparedRunOnceCommand | null = null;
  try {
    if (request.action !== 'createWorkspace') {
      throw new Error(`Unsupported automation action: ${request.action}`);
    }
    if (!activeProjectId) throw new Error('No project is currently selected');
    if (request.startupCommand && request.runOnce) {
      throw new Error('Startup and run-once commands are mutually exclusive');
    }

    const runOnce = request.runOnce?.trim();
    if (runOnce) preparedRunOnce = dependencies.prepareRunOnceCommand(runOnce);
    creation = await dependencies.createWorkspace({
      projectId: activeProjectId,
      name: request.name,
      command: request.startupCommand,
      oneTimeStartupCommand: preparedRunOnce?.startupCommand,
      rows: 1,
      columns: 1,
    });
    await dependencies.waitForTerminalStartup(creation.focusedTerminalId);

    if (preparedRunOnce) {
      const result = await preparedRunOnce.completion;
      if (result.terminalId !== creation.focusedTerminalId) {
        throw new Error('Run-once completion came from an unexpected terminal');
      }
      return {
        ok: result.exitCode === 0,
        message: result.exitCode === 0
          ? `Created workspace "${creation.workspace.name}" and completed run-once command (${creation.workspace.id})`
          : `Run-once command exited with status ${result.exitCode} (${creation.workspace.id})`,
        workspaceId: creation.workspace.id,
        exitCode: result.exitCode,
      };
    }

    return {
      ok: true,
      message: `Created workspace "${creation.workspace.name}" (${creation.workspace.id})`,
      workspaceId: creation.workspace.id,
    };
  } catch (error) {
    preparedRunOnce?.cancel();
    let message = error instanceof Error ? error.message : String(error);
    if (creation) {
      try {
        await dependencies.rollbackWorkspace(creation);
        message = `${message}; automated workspace was rolled back`;
        creation = null;
      } catch (rollbackError) {
        message = `${message}; rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
      }
    }
    return {
      ok: false,
      message,
      workspaceId: creation?.workspace.id ?? null,
    };
  }
}
