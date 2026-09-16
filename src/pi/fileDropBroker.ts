export type PiFileDropSubscriber = (paths: string[]) => void;

const subscribers = new Map<string, PiFileDropSubscriber>();

export function subscribePiFileDrops(paneId: string, subscriber: PiFileDropSubscriber) {
  subscribers.set(paneId, subscriber);
  return () => {
    if (subscribers.get(paneId) === subscriber) subscribers.delete(paneId);
  };
}

export function deliverPiFileDrop(paneId: string, paths: string[]): boolean {
  const subscriber = subscribers.get(paneId);
  if (!subscriber) return false;
  subscriber(paths);
  return true;
}
