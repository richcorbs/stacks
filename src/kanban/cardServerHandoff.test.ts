import { describe, expect, it, vi } from 'vitest';
import type { KanbanCardSummary } from './types';
import type { CardServices } from './useCardServices';
import { CardServerShutdownError, findConflictingCardServer, handoffCardServer } from './cardServerHandoff';

function card(id: string, projectId: string): KanbanCardSummary {
  return { id, project_id: projectId, external_id: id } as KanbanCardSummary;
}

function services({ starting = false, running = false, consoleActive = false } = {}): CardServices & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  return {
    serverActive: starting || running,
    serverStarting: starting,
    serverRunning: running,
    consoleActive,
    start,
    stop,
  } as unknown as CardServices & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
}

describe('card server handoff', () => {
  it.each([{ starting: true }, { running: true }])('detects a same-project active server (%o)', (state) => {
    const cards = [card('target', 'project-1'), card('conflict', 'project-1')];
    expect(findConflictingCardServer('target', cards, {
      target: services(),
      conflict: services(state),
    })?.id).toBe('conflict');
  });

  it('ignores servers in other projects and console processes', () => {
    const cards = [card('target', 'project-1'), card('other', 'project-2'), card('console', 'project-1')];
    expect(findConflictingCardServer('target', cards, {
      target: services(),
      other: services({ running: true }),
      console: services({ consoleActive: true }),
    })).toBeNull();
  });

  it('starts immediately without a conflict and stops an active target immediately', async () => {
    const cards = [card('target', 'project-1')];
    const inactive = services();
    await handoffCardServer('target', cards, { target: inactive });
    expect(inactive.start).toHaveBeenCalledWith('server');

    const active = services({ running: true });
    await handoffCardServer('target', cards, { target: active });
    expect(active.stop).toHaveBeenCalledWith('server');
    expect(active.start).not.toHaveBeenCalled();
  });

  it('awaits successful shutdown before starting the target', async () => {
    const cards = [card('target', 'project-1'), card('conflict', 'project-1')];
    const order: string[] = [];
    const target = services();
    const conflict = services({ running: true });
    conflict.stop.mockImplementation(async () => { order.push('stop'); });
    target.start.mockImplementation(async () => { order.push('start'); });

    await handoffCardServer('target', cards, { target, conflict });
    expect(order).toEqual(['stop', 'start']);
  });

  it('propagates shutdown failure and does not start the target', async () => {
    const cards = [card('target', 'project-1'), card('conflict', 'project-1')];
    const target = services();
    const conflict = services({ starting: true });
    conflict.stop.mockRejectedValueOnce(new Error('kill failed'));

    await expect(handoffCardServer('target', cards, { target, conflict })).rejects.toBeInstanceOf(CardServerShutdownError);
    expect(target.start).not.toHaveBeenCalled();
  });
});
