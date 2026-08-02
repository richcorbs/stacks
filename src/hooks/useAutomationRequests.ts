import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { CreateWorkspace, RollbackWorkspace } from '../workspace/createWorkspace';
import type { AutomationRequest } from '../workspace/automation';
import { waitForTerminalStartup } from '../terminalStartup';
import { prepareRunOnceCommand } from '../terminalAutomation';
import { processAutomationRequest } from '../workspace/processAutomationRequest';

type AutomationRequestOptions = {
  loaded: boolean;
  activeProjectId: string | null;
  createWorkspace: CreateWorkspace;
  rollbackWorkspace: RollbackWorkspace;
};

export function useAutomationRequests(options: AutomationRequestOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const inFlightRequestIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!options.loaded) return;
    let disposed = false;

    const processRequest = async (request: AutomationRequest) => {
      const inFlight = inFlightRequestIdsRef.current;
      if (disposed || inFlight.has(request.requestId)) return;
      inFlight.add(request.requestId);

      const current = optionsRef.current;
      const response = await processAutomationRequest(request, current.activeProjectId, {
        createWorkspace: current.createWorkspace,
        rollbackWorkspace: current.rollbackWorkspace,
        waitForTerminalStartup,
        prepareRunOnceCommand,
      });

      try {
        await invoke('complete_automation_request', { requestId: request.requestId, response });
      } catch (error) {
        console.error(error);
      } finally {
        inFlight.delete(request.requestId);
      }
    };

    const unlistenPromise = getCurrentWindow().listen<AutomationRequest>('automation-request', (event) => {
      void processRequest(event.payload);
    });
    unlistenPromise
      .then(() => invoke<AutomationRequest[]>('drain_automation_requests'))
      .then((requests) => requests.forEach((request) => void processRequest(request)))
      .catch(console.error);

    return () => {
      disposed = true;
      unlistenPromise.then((unlisten) => unlisten()).catch(console.error);
    };
  }, [options.loaded]);
}
