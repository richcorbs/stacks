import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ToastState } from './types';

export const LOADING_BLOCK_MS = 10_000;

export type LoadingOperation = Readonly<{
  key: string;
  message: string;
  priority: number;
  startedAt: number;
  token: number;
}>;

export type LoadingSnapshot = Readonly<{
  operation: LoadingOperation | null;
  interactionBlocked: boolean;
}>;

type LoadingCoordinatorOptions = {
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

/** Owns keyed, persistent page-level loading operations independently of transient toasts. */
export class LoadingCoordinator {
  private operations = new Map<string, LoadingOperation>();
  private listeners = new Set<() => void>();
  private sequence = 0;
  private startupToken: number | null = null;
  private startupSettled = { projects: false, cards: false };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private snapshot: LoadingSnapshot = Object.freeze({ operation: null, interactionBlocked: false });
  private readonly now: () => number;
  private readonly setTimer: NonNullable<LoadingCoordinatorOptions['setTimer']>;
  private readonly clearTimer: NonNullable<LoadingCoordinatorOptions['clearTimer']>;

  constructor(options: LoadingCoordinatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  begin(key: string, message: string, priority = 0) {
    const token = ++this.sequence;
    this.operations.set(key, Object.freeze({ key, message, priority, startedAt: this.now(), token }));
    this.publish();
    return token;
  }

  complete(key: string, token: number) {
    if (this.operations.get(key)?.token !== token) return false;
    this.operations.delete(key);
    this.publish();
    return true;
  }

  beginStartup() {
    if (this.startupToken === null) this.startupToken = this.begin('startup', 'Loading work…', 0);
    return this.startupToken;
  }

  settleStartup(part: 'projects' | 'cards') {
    this.startupSettled[part] = true;
    if (this.startupSettled.projects && this.startupSettled.cards && this.startupToken !== null) {
      this.complete('startup', this.startupToken);
      this.startupToken = null;
    }
  }

  remove(key: string) {
    const removed = this.operations.delete(key);
    if (removed) this.publish();
    return removed;
  }

  isInteractionBlocked = () => this.snapshot.interactionBlocked;

  dispose() {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.operations.clear();
    this.startupToken = null;
    this.listeners.clear();
  }

  private publish() {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    const now = this.now();
    const operations = [...this.operations.values()];
    const operation = operations.sort((left, right) => right.priority - left.priority || right.startedAt - left.startedAt || right.token - left.token)[0] ?? null;
    const blockingDeadlines = operations.map((entry) => entry.startedAt + LOADING_BLOCK_MS).filter((deadline) => deadline > now);
    const interactionBlocked = blockingDeadlines.length > 0;
    this.snapshot = Object.freeze({ operation, interactionBlocked });
    this.listeners.forEach((listener) => listener());
    if (interactionBlocked) {
      const deadline = Math.min(...blockingDeadlines);
      this.timer = this.setTimer(() => this.publish(), Math.max(0, deadline - now));
    }
  }
}

export const LoadingCoordinatorContext = createContext<LoadingCoordinator | null>(null);

export function useLoadingCoordinator() {
  const coordinator = useContext(LoadingCoordinatorContext);
  if (!coordinator) throw new Error('LoadingCoordinatorContext is not available');
  return coordinator;
}

export function useLoadingSnapshot(coordinator: LoadingCoordinator) {
  return useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot);
}

export function installKeyboardInteractionGate(coordinator: LoadingCoordinator, target: EventTarget = window) {
  const block = (event: Event) => {
    if (!coordinator.isInteractionBlocked()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  target.addEventListener('keydown', block, { capture: true });
  return () => target.removeEventListener('keydown', block, { capture: true });
}

export function presentedToast(transientToast: ToastState | null, loading: LoadingOperation | null): ToastState | null {
  return transientToast ?? (loading ? { message: loading.message } : null);
}
