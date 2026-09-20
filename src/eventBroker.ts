export type EventBroker<Events extends object> = {
  publish<Key extends keyof Events>(key: Key, payload: Events[Key]): void;
  subscribe<Key extends keyof Events>(key: Key, subscriber: (payload: Events[Key]) => void): () => void;
};

export function createEventBroker<Events extends object>(): EventBroker<Events> {
  type Entry = { active: boolean; subscriber: (payload: unknown) => void };
  const subscribers = new Map<keyof Events, Entry[]>();
  return {
    publish(key, payload) {
      // Snapshot preserves registration order. Checking active makes removal during delivery immediate.
      for (const entry of [...(subscribers.get(key) ?? [])]) {
        if (entry.active) entry.subscriber(payload);
      }
    },
    subscribe(key, subscriber) {
      const entry: Entry = { active: true, subscriber: subscriber as (payload: unknown) => void };
      const entries = subscribers.get(key) ?? [];
      entries.push(entry);
      subscribers.set(key, entries);
      return () => {
        if (!entry.active) return;
        entry.active = false;
        const current = subscribers.get(key);
        if (!current) return;
        const index = current.indexOf(entry);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) subscribers.delete(key);
      };
    },
  };
}
