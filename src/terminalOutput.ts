import type { PaneSession } from './types';

const MAX_OUTPUT_BATCH_CHARS = 256 * 1024;

function enqueuePaneActivityEvent(session: PaneSession, terminalId: string, paneId: string) {
  if (session.outputActivityFrame !== null) return;
  session.outputActivityFrame = window.requestAnimationFrame(() => {
    session.outputActivityFrame = null;
    window.dispatchEvent(new CustomEvent('pane-output', { detail: { terminalId, paneId } }));
  });
}

function nextOutputBatch(queue: string[]) {
  let batch = '';
  while (queue.length > 0 && (batch.length === 0 || batch.length + queue[0].length <= MAX_OUTPUT_BATCH_CHARS)) {
    batch += queue.shift();
  }
  return batch;
}

function flushPaneOutput(session: PaneSession) {
  if (session.outputWriteInProgress) return;
  const batch = nextOutputBatch(session.outputQueue);
  if (!batch) return;
  session.outputWriteInProgress = true;
  session.term.write(batch, () => {
    session.outputWriteInProgress = false;
    flushPaneOutput(session);
  });
}

export function enqueuePaneOutput(session: PaneSession, text: string, terminalId: string, paneId: string) {
  if (!text) return;
  session.outputQueue.push(text);
  enqueuePaneActivityEvent(session, terminalId, paneId);
  flushPaneOutput(session);
}
