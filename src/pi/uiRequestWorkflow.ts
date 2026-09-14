export type PiUiRequestWorkflowHandler = {
  received: (paneId: string, requestId: string, viewOpen: boolean) => void | Promise<void>;
  beforeResponse: (paneId: string, requestId: string) => void | Promise<void>;
  dismissed: (paneId: string, requestId: string, restoreWorking: boolean) => void | Promise<void>;
};

let handler: PiUiRequestWorkflowHandler | null = null;

export function setPiUiRequestWorkflowHandler(next: PiUiRequestWorkflowHandler | null) {
  handler = next;
  return () => { if (handler === next) handler = null; };
}

export function notifyPiUiRequestReceived(paneId: string, requestId: string, viewOpen: boolean) {
  return Promise.resolve(handler?.received(paneId, requestId, viewOpen)).catch((error) => {
    console.error('Could not update card for Pi request', error);
  });
}

export function preparePiUiRequestResponse(paneId: string, requestId: string) {
  return Promise.resolve(handler?.beforeResponse(paneId, requestId));
}

export function notifyPiUiRequestDismissed(paneId: string, requestId: string, restoreWorking = true) {
  return Promise.resolve(handler?.dismissed(paneId, requestId, restoreWorking)).catch((error) => {
    console.error('Could not reconcile card after Pi request', error);
  });
}
