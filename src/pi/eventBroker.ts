import { listen } from '@tauri-apps/api/event';
import type { PiRpcEnvelope } from './types';

type Subscriber = (envelope: PiRpcEnvelope) => void;
const subscribers = new Map<string, Set<Subscriber>>();
let listenerReady: Promise<void> | null = null;

function ensureListener() {
  if (!listenerReady) {
    listenerReady = listen<PiRpcEnvelope>('pi-rpc-event', ({ payload }) => {
      subscribers.get(payload.pane_id)?.forEach((subscriber) => subscriber(payload));
    }).then(() => undefined);
  }
  return listenerReady;
}

export async function subscribePiEvents(paneId: string, subscriber: Subscriber) {
  let paneSubscribers = subscribers.get(paneId);
  if (!paneSubscribers) {
    paneSubscribers = new Set();
    subscribers.set(paneId, paneSubscribers);
  }
  paneSubscribers.add(subscriber);
  try {
    await ensureListener();
  } catch (error) {
    paneSubscribers.delete(subscriber);
    if (paneSubscribers.size === 0) subscribers.delete(paneId);
    listenerReady = null;
    throw error;
  }
  return () => {
    const current = subscribers.get(paneId);
    current?.delete(subscriber);
    if (current?.size === 0) subscribers.delete(paneId);
  };
}
