import type { TerminalSession } from './types';

const MAX_OUTPUT_BATCH_CHARS = 256 * 1024;
const MAX_QUEUED_OUTPUT_CHARS = 4 * 1024 * 1024;

function enqueueTerminalActivityEvent(session: TerminalSession, workspaceId: string, terminalId: string) {
  if (session.outputActivityFrame !== null) return;
  session.outputActivityFrame = window.requestAnimationFrame(() => {
    session.outputActivityFrame = null;
    window.dispatchEvent(new CustomEvent('terminal-output', { detail: { workspaceId, terminalId } }));
  });
}

function nextOutputBatch(session: TerminalSession) {
  let batch = '';
  while (session.outputQueue.length > 0 && (batch.length === 0 || batch.length + session.outputQueue[0].length <= MAX_OUTPUT_BATCH_CHARS)) {
    const chunk = session.outputQueue.shift() ?? '';
    session.outputQueuedChars = Math.max(0, session.outputQueuedChars - chunk.length);
    batch += chunk;
  }
  return batch;
}

function trimOutputQueue(session: TerminalSession) {
  if (session.outputQueuedChars <= MAX_QUEUED_OUTPUT_CHARS) return;

  let dropped = 0;
  while (session.outputQueue.length > 0 && session.outputQueuedChars > MAX_QUEUED_OUTPUT_CHARS) {
    const chunk = session.outputQueue.shift() ?? '';
    dropped += chunk.length;
    session.outputQueuedChars = Math.max(0, session.outputQueuedChars - chunk.length);
  }

  if (dropped <= 0) return;
  session.outputDroppedChars += dropped;
  const notice = `\r\n[Stacks dropped ${dropped.toLocaleString()} queued output characters because the terminal could not render fast enough]\r\n`;
  session.outputQueue.unshift(notice);
  session.outputQueuedChars += notice.length;
}

function flushTerminalOutput(session: TerminalSession, terminalId: string) {
  if (session.outputWriteInProgress) return;
  const batch = nextOutputBatch(session);
  if (!batch) return;
  session.outputWriteInProgress = true;
  session.term.write(batch, () => {
    session.outputWriteInProgress = false;
    window.dispatchEvent(new CustomEvent('terminal-output-rendered', { detail: { terminalId } }));
    flushTerminalOutput(session, terminalId);
  });
}

export function enqueueTerminalOutput(session: TerminalSession, text: string, workspaceId: string, terminalId: string) {
  if (!text) return;
  session.outputQueue.push(text);
  session.outputQueuedChars += text.length;
  trimOutputQueue(session);
  enqueueTerminalActivityEvent(session, workspaceId, terminalId);
  flushTerminalOutput(session, terminalId);
}
