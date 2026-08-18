import { describe, expect, it } from 'vitest';
import { SuperthreadRequestGate } from './requestGate';

describe('SuperthreadRequestGate', () => {
  it('invalidates tree and detail requests when a refresh generation begins', () => {
    const gate = new SuperthreadRequestGate();
    const firstGeneration = gate.beginGeneration();
    const detail = gate.beginDetailRequest();

    gate.beginGeneration();

    expect(gate.isCurrentGeneration(firstGeneration)).toBe(false);
    expect(gate.isCurrentDetailRequest(detail)).toBe(false);
  });

  it('prevents an older card response from replacing a newer card', () => {
    const gate = new SuperthreadRequestGate();
    gate.beginGeneration();
    const firstCard = gate.beginDetailRequest();
    const secondCard = gate.beginDetailRequest();

    expect(gate.isCurrentDetailRequest(firstCard)).toBe(false);
    expect(gate.isCurrentDetailRequest(secondCard)).toBe(true);
  });
});
