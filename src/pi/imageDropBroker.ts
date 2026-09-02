type Subscriber = (paths: string[]) => void;
const subscribers = new Map<string, Subscriber>();
let listening = false;

function ensureListener() {
  if (listening) return;
  listening = true;
  window.addEventListener('pi-image-drop', (event) => {
    const detail = (event as CustomEvent<{ paneId?: string; paths?: string[] }>).detail;
    if (detail?.paneId && Array.isArray(detail.paths)) subscribers.get(detail.paneId)?.(detail.paths);
  });
}

export function subscribePiImageDrops(paneId: string, subscriber: Subscriber) {
  ensureListener();
  subscribers.set(paneId, subscriber);
  return () => {
    if (subscribers.get(paneId) === subscriber) subscribers.delete(paneId);
  };
}
