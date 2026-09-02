const PI_EDITOR_TEXT_EVENT = 'stacks:pi-editor-text';
const DELIVERY_TIMEOUT_MS = 2_000;

type PiEditorTextRequest = {
  terminalId: string;
  text: string;
  acknowledge: () => void;
};

type PendingDelivery = {
  request: PiEditorTextRequest;
  finish: (delivered: boolean) => void;
};

const pendingDeliveries = new Map<string, PendingDelivery>();

export function sendTextToPiEditor(terminalId: string, text: string) {
  pendingDeliveries.get(terminalId)?.finish(false);
  return new Promise<boolean>((resolve) => {
    let finished = false;
    const finish = (delivered: boolean) => {
      if (finished) return;
      finished = true;
      const pending = pendingDeliveries.get(terminalId);
      if (pending?.request === request) pendingDeliveries.delete(terminalId);
      window.clearTimeout(timer);
      resolve(delivered);
    };
    const request: PiEditorTextRequest = { terminalId, text, acknowledge: () => finish(true) };
    const timer = window.setTimeout(() => finish(false), DELIVERY_TIMEOUT_MS);
    pendingDeliveries.set(terminalId, { request, finish });
    dispatchRequest(request);
  });
}

export function listenForPiEditorText(listener: (request: PiEditorTextRequest) => void) {
  let listening = true;
  const handleEvent = (event: Event) => listener((event as CustomEvent<PiEditorTextRequest>).detail);
  window.addEventListener(PI_EDITOR_TEXT_EVENT, handleEvent);
  queueMicrotask(() => {
    if (!listening) return;
    for (const { request } of pendingDeliveries.values()) listener(request);
  });
  return () => {
    listening = false;
    window.removeEventListener(PI_EDITOR_TEXT_EVENT, handleEvent);
  };
}

function dispatchRequest(request: PiEditorTextRequest) {
  window.dispatchEvent(new CustomEvent<PiEditorTextRequest>(PI_EDITOR_TEXT_EVENT, { detail: request }));
}
