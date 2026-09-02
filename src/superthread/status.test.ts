import { describe, expect, it } from 'vitest';
import { canStartSuperthreadWork } from './status';

describe('canStartSuperthreadWork', () => {
  it.each(['backlog', 'committed'])('allows work to start for %s cards', (status) => {
    expect(canStartSuperthreadWork(status)).toBe(true);
  });

  it.each(['started', 'completed', 'cancelled', undefined])('does not allow work to start for %s cards', (status) => {
    expect(canStartSuperthreadWork(status)).toBe(false);
  });
});
