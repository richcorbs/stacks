import { applicationEvents } from '../applicationEvents';

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
      unsubscribeSettled();
      unsubscribeFailed();
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
    const handleSettled = (detail: { terminalId: string }) => {
      if (detail.terminalId !== terminalId || delivery.state === 'queued') return;
      if (delivery.state === 'accepted') finish(true);
      else delivery.settled = true;
    };
    const handleFailed = (detail: { terminalId: string }) => {
      if (detail.terminalId === terminalId && delivery.state !== 'queued') finish(false);
    };
    const timer = window.setTimeout(() => finish(false), DELIVERY_TIMEOUT_MS);
    const unsubscribeSettled = applicationEvents.subscribe('pi-agent-settled', handleSettled);
    const unsubscribeFailed = applicationEvents.subscribe('pi-prompt-failed', handleFailed);
    pendingDeliveries.set(terminalId, delivery);
    dispatchRequest(request);
  });
}

export function listenForPiPrompt(listener: (request: PiPromptRequest) => void) {
  let listening = true;
  const unsubscribe = applicationEvents.subscribe('pi-prompt', listener);
  queueMicrotask(() => {
    if (!listening) return;
    for (const { request, state } of pendingDeliveries.values()) {
      if (state === 'queued') listener(request);
    }
  });
  return () => {
    listening = false;
    unsubscribe();
  };
}

export function notifyPiAgentSettled(terminalId: string) {
  applicationEvents.publish('pi-agent-settled', { terminalId });
}

export function notifyPiPromptFailed(terminalId: string) {
  applicationEvents.publish('pi-prompt-failed', { terminalId });
}

function dispatchRequest(request: PiPromptRequest) {
  applicationEvents.publish('pi-prompt', request);
}
