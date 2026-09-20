import { describe, expect, it, vi } from 'vitest';
import { createEventBroker } from './eventBroker';

type Events = { first: number; second: string };

describe('event broker', () => {
  it('delivers synchronously in subscription order to multiple subscribers', () => {
    const broker = createEventBroker<Events>();
    const calls: string[] = [];
    broker.subscribe('first', (value) => calls.push(`a:${value}`));
    broker.subscribe('first', (value) => calls.push(`b:${value}`));
    broker.publish('first', 3);
    expect(calls).toEqual(['a:3', 'b:3']);
  });

  it('returns an idempotent deterministic unsubscribe', () => {
    const broker = createEventBroker<Events>();
    const subscriber = vi.fn();
    const unsubscribe = broker.subscribe('first', subscriber);
    unsubscribe();
    unsubscribe();
    broker.publish('first', 1);
    expect(subscriber).not.toHaveBeenCalled();
  });

  it('honors unsubscribe during delivery', () => {
    const broker = createEventBroker<Events>();
    const second = vi.fn();
    let unsubscribeSecond = () => {};
    broker.subscribe('first', () => unsubscribeSecond());
    unsubscribeSecond = broker.subscribe('first', second);
    broker.publish('first', 1);
    expect(second).not.toHaveBeenCalled();
  });

  it('isolates event keys', () => {
    const broker = createEventBroker<Events>();
    const subscriber = vi.fn();
    broker.subscribe('second', subscriber);
    broker.publish('first', 1);
    expect(subscriber).not.toHaveBeenCalled();
  });
});
