import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installKeyboardInteractionGate, LOADING_BLOCK_MS, LoadingCoordinator, presentedToast } from './loadingState';

describe('LoadingCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('keeps loading visible but unblocks interaction at exactly ten seconds', () => {
    const loading = new LoadingCoordinator();
    loading.begin('details', 'Loading card details…');
    expect(loading.getSnapshot()).toMatchObject({ operation: { message: 'Loading card details…' }, interactionBlocked: true });

    vi.advanceTimersByTime(LOADING_BLOCK_MS - 1);
    expect(loading.getSnapshot().interactionBlocked).toBe(true);
    vi.advanceTimersByTime(1);
    expect(loading.getSnapshot()).toMatchObject({ operation: { message: 'Loading card details…' }, interactionBlocked: false });
  });

  it('clears completed and failed operations before or after the deadline', () => {
    const loading = new LoadingCoordinator();
    const first = loading.begin('details', 'Loading card details…');
    expect(loading.complete('details', first)).toBe(true);
    expect(loading.getSnapshot()).toEqual({ operation: null, interactionBlocked: false });

    const second = loading.begin('details', 'Loading card details…');
    vi.advanceTimersByTime(LOADING_BLOCK_MS);
    expect(loading.getSnapshot().interactionBlocked).toBe(false);
    expect(loading.complete('details', second)).toBe(true);
    expect(loading.getSnapshot().operation).toBeNull();
  });

  it('treats startup hydration as one operation with one deadline', () => {
    const loading = new LoadingCoordinator();
    const startup = loading.beginStartup();
    vi.advanceTimersByTime(6_000);
    loading.settleStartup('projects');
    expect(loading.getSnapshot().operation?.token).toBe(startup);
    expect(loading.getSnapshot().interactionBlocked).toBe(true);

    vi.advanceTimersByTime(4_000);
    expect(loading.getSnapshot()).toMatchObject({ operation: { message: 'Loading work…', token: startup }, interactionBlocked: false });
    loading.settleStartup('cards');
    expect(loading.getSnapshot().operation).toBeNull();
  });

  it('keeps startup active when the board settles first', () => {
    const loading = new LoadingCoordinator();
    loading.beginStartup();
    loading.settleStartup('cards');
    expect(loading.getSnapshot().operation?.message).toBe('Loading work…');
    loading.settleStartup('projects');
    expect(loading.getSnapshot().operation).toBeNull();
  });

  it('prioritizes card details and prevents stale completion from clearing a replacement', () => {
    const loading = new LoadingCoordinator();
    loading.beginStartup();
    const oldDetails = loading.begin('card-detail', 'Loading card details…', 10);
    expect(loading.getSnapshot().operation?.key).toBe('card-detail');
    const currentDetails = loading.begin('card-detail', 'Loading card details…', 10);
    expect(loading.complete('card-detail', oldDetails)).toBe(false);
    expect(loading.getSnapshot().operation?.token).toBe(currentDetails);
    loading.complete('card-detail', currentDetails);
    expect(loading.getSnapshot().operation?.key).toBe('startup');
  });

  it('lets a transient notification replace loading and restores loading afterward', () => {
    const loading = new LoadingCoordinator();
    loading.begin('details', 'Loading card details…');
    const active = loading.getSnapshot().operation;
    expect(presentedToast({ message: 'Copied to clipboard' }, active)?.message).toBe('Copied to clipboard');
    expect(presentedToast(null, active)?.message).toBe('Loading card details…');
  });

  it('blocks keyboard dispatch only during the interaction deadline', () => {
    const loading = new LoadingCoordinator();
    const target = new EventTarget();
    const shortcut = vi.fn();
    const removeGate = installKeyboardInteractionGate(loading, target);
    target.addEventListener('keydown', shortcut);
    loading.begin('details', 'Loading card details…');

    const blocked = new Event('keydown', { cancelable: true });
    target.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);
    expect(shortcut).not.toHaveBeenCalled();

    vi.advanceTimersByTime(LOADING_BLOCK_MS);
    target.dispatchEvent(new Event('keydown', { cancelable: true }));
    expect(shortcut).toHaveBeenCalledOnce();
    removeGate();
  });
});
