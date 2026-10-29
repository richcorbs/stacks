import { useSyncExternalStore } from 'react';
import type { PiMessage } from '../src/pi/types';

const listeners = new Set<() => void>();
const noop = async () => {};
const prompt = async (text: string) => {
  updateSession({ messages: [...session.messages, { role: 'user', content: text, timestamp: Date.now() }] });
};
let session = {
  context: { contextPercent: null }, commands: [], messages: [] as PiMessage[], tools: [],
  queuedFollowUps: [], queuedSteering: [], effectiveModels: [], availableThinkingLevels: [],
  starting: false, stopped: false, isStreaming: false, isStreamingText: false, streamingText: '',
  setViewOpen: () => {}, prompt, steer: prompt, followUp: prompt,
  dismissStructuredUiRequest: noop, restart: noop,
};
export function updateSession(patch: Partial<typeof session>) {
  session = { ...session, ...patch };
  listeners.forEach(fn => fn());
}
export function usePiSession() {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => session);
}
