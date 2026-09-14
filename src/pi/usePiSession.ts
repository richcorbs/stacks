import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { getPiSessionController } from './sessionController';

/**
 * Reactive view of a pane-owned controller. Unmounting this hook only removes
 * the React subscriber; it does not unsubscribe from Pi or stop the process.
 */
export function usePiSession(paneId: string, cwd: string, workspaceId: string, projectId: string, projectPath: string) {
  const controller = useMemo(() => getPiSessionController({ paneId, cwd, workspaceId, projectId, projectPath }), [paneId, cwd, workspaceId, projectId, projectPath]);
  useEffect(() => controller.initialize(), [controller]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return {
    ...snapshot,
    prompt: controller.prompt,
    runBuiltinCommand: controller.runBuiltinCommand,
    steer: controller.steer,
    followUp: controller.followUp,
    abort: controller.abort,
    selectModel: controller.selectModel,
    selectThinkingLevel: controller.selectThinkingLevel,
    restart: controller.restart,
    respondToUiRequest: controller.respondToUiRequest,
    setViewOpen: controller.setViewOpen,
  };
}
