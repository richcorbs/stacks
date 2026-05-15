import { describe, expect, it } from 'vitest';
import { countSearchMatchesInLines } from './terminalSearch';

describe('countSearchMatchesInLines', () => {
  it('counts case-insensitive matches across lines', () => {
    expect(countSearchMatchesInLines(['Alpha beta alpha', 'ALPHA'], 'alpha')).toBe(3);
  });

  it('counts non-overlapping matches', () => {
    expect(countSearchMatchesInLines(['aaaa'], 'aa')).toBe(2);
  });

  it('returns zero for an empty query', () => {
    expect(countSearchMatchesInLines(['anything'], '')).toBe(0);
  });

  it('returns zero when no matches exist', () => {
    expect(countSearchMatchesInLines(['one', 'two'], 'three')).toBe(0);
  });
});
