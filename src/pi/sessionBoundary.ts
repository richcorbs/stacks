import type { PiSessionBoundary } from '../types';

const PREFIX = 'stacks.pi-session-boundary.';

function storage() {
  try { return globalThis.localStorage; } catch { return null; }
}

export function loadPiSessionBoundary(paneId: string): PiSessionBoundary | null {
  const raw = storage()?.getItem(`${PREFIX}${paneId}`);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PiSessionBoundary>;
    return typeof value.sessionId === 'string' && value.sessionId.length > 0
      && typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)
      ? { sessionId: value.sessionId, timestamp: value.timestamp } : null;
  } catch { return null; }
}

export function savePiSessionBoundary(paneId: string, boundary: PiSessionBoundary | null) {
  const target = storage();
  if (!target) return;
  try {
    if (boundary) target.setItem(`${PREFIX}${paneId}`, JSON.stringify(boundary));
    else target.removeItem(`${PREFIX}${paneId}`);
  } catch { /* persistence is best effort */ }
}
