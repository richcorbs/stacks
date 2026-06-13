import type { TerminalSession } from './types';

const MAX_OUTPUT_BATCH_CHARS = 256 * 1024;

function enqueueTerminalActivityEvent(session: TerminalSession, workspaceId: string, terminalId: string) {
  if (session.outputActivityFrame !== null) return;
  session.outputActivityFrame = window.requestAnimationFrame(() => {
    session.outputActivityFrame = null;
    window.dispatchEvent(new CustomEvent('terminal-output', { detail: { workspaceId, terminalId } }));
  });
}

function nextOutputBatch(queue: string[]) {
  let batch = '';
  while (queue.length > 0 && (batch.length === 0 || batch.length + queue[0].length <= MAX_OUTPUT_BATCH_CHARS)) {
    batch += queue.shift();
  }
  return batch;
}

function flushTerminalOutput(session: TerminalSession) {
  if (session.outputWriteInProgress) return;
  const batch = nextOutputBatch(session.outputQueue);
  if (!batch) return;
  session.outputWriteInProgress = true;
  session.term.write(batch, () => {
    session.outputWriteInProgress = false;
    flushTerminalOutput(session);
  });
}

export function enqueueTerminalOutput(session: TerminalSession, text: string, workspaceId: string, terminalId: string) {
  if (!text) return;
  session.outputQueue.push(text);
  enqueueTerminalActivityEvent(session, workspaceId, terminalId);
  flushTerminalOutput(session);
}
