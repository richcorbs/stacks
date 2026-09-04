const PI_PROMPT_EVENT = 'stacks:pi-prompt';
const PI_AGENT_SETTLED_EVENT = 'stacks:pi-agent-settled';
const PI_PROMPT_FAILED_EVENT = 'stacks:pi-prompt-failed';
const DELIVERY_TIMEOUT_MS = 30 * 60 * 1_000;

export type PiPromptRequest = {
  terminalId: string;
  text: string;
  claim: () => boolean;
  accepted: () => void;
  failed: () => void;
};

type PendingDelivery = {
  request: PiPromptRequest;
  state: 'queued' | 'claimed' | 'accepted';
  settled: boolean;
  finish: (delivered: boolean) => void;
};

const pendingDeliveries = new Map<string, PendingDelivery>();

export function sendPromptToPiAndWait(terminalId: string, text: string) {
  pendingDeliveries.get(terminalId)?.finish(false);
  return new Promise<boolean>((resolve) => {
    let finished = false;
    const finish = (delivered: boolean) => {
      if (finished) return;
      finished = true;
      const pending = pendingDeliveries.get(terminalId);
      if (pending === delivery) pendingDeliveries.delete(terminalId);
      window.clearTimeout(timer);
      window.removeEventListener(PI_AGENT_SETTLED_EVENT, handleSettled);
      window.removeEventListener(PI_PROMPT_FAILED_EVENT, handleFailed);
      resolve(delivered);
    };
    const request: PiPromptRequest = {
      terminalId,
      text,
      claim: () => {
        if (delivery.state !== 'queued') return false;
        delivery.state = 'claimed';
        return true;
      },
      accepted: () => {
        if (delivery.state !== 'claimed') return;
        delivery.state = 'accepted';
        if (delivery.settled) finish(true);
      },
      failed: () => finish(false),
    };
    const delivery: PendingDelivery = { request, state: 'queued', settled: false, finish };
    const handleSettled = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId?: string }>).detail;
      if (detail?.terminalId !== terminalId || delivery.state === 'queued') return;
      if (delivery.state === 'accepted') finish(true);
      else delivery.settled = true;
    };
    const handleFailed = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId?: string }>).detail;
      if (detail?.terminalId === terminalId && delivery.state !== 'queued') finish(false);
    };
    const timer = window.setTimeout(() => finish(false), DELIVERY_TIMEOUT_MS);
    window.addEventListener(PI_AGENT_SETTLED_EVENT, handleSettled);
    window.addEventListener(PI_PROMPT_FAILED_EVENT, handleFailed);
    pendingDeliveries.set(terminalId, delivery);
    dispatchRequest(request);
  });
}

export function listenForPiPrompt(listener: (request: PiPromptRequest) => void) {
  let listening = true;
  const handleEvent = (event: Event) => listener((event as CustomEvent<PiPromptRequest>).detail);
  window.addEventListener(PI_PROMPT_EVENT, handleEvent);
  queueMicrotask(() => {
    if (!listening) return;
    for (const { request, state } of pendingDeliveries.values()) {
      if (state === 'queued') listener(request);
    }
  });
  return () => {
    listening = false;
    window.removeEventListener(PI_PROMPT_EVENT, handleEvent);
  };
}

export function notifyPiAgentSettled(terminalId: string) {
  window.dispatchEvent(new CustomEvent(PI_AGENT_SETTLED_EVENT, { detail: { terminalId } }));
}

export function notifyPiPromptFailed(terminalId: string) {
  window.dispatchEvent(new CustomEvent(PI_PROMPT_FAILED_EVENT, { detail: { terminalId } }));
}

function dispatchRequest(request: PiPromptRequest) {
  window.dispatchEvent(new CustomEvent<PiPromptRequest>(PI_PROMPT_EVENT, { detail: request }));
}
