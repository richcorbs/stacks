// Real production factory, cached ownership, fit and focus paths; no Tauri PTY.
import { createTerminalSession } from '../src/terminalSessionFactory';
import {
  setTerminalSession, getTerminalSession, focusTerminalSession,
  fitSessionPreservingBottom, disposeTerminalSession,
} from '../src/terminalSessionManager';

const ids = ['first', 'second'];
const sessions = ids.map(terminalId => {
  const session = createTerminalSession({
    terminalId, host: document.getElementById(terminalId)!,
    terminalFontFamily: 'monospace', terminalFontSize: 14,
    terminalScrollback: 2000, onInput: () => {},
  });
  setTerminalSession(terminalId, session);
  fitSessionPreservingBottom(session);
  return session;
});

function snapshot() {
  const term = sessions[0].term;
  const buffer = term.buffer.active;
  const lines = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)!);
  // Reconstruct logical lines without discarding significant spaces at wraps.
  const logical: string[] = [];
  for (const line of lines) {
    const text = line.translateToString(true);
    if (line.isWrapped && logical.length) logical[logical.length - 1] += text;
    else logical.push(text);
  }
  return {
    cols: term.cols, rows: term.rows, cursorX: buffer.cursorX, cursorY: buffer.cursorY,
    baseY: buffer.baseY, viewportY: buffer.viewportY, type: buffer.type,
    logical: logical.filter(Boolean),
    physical: lines.map(line => line.translateToString(true)),
  };
}

Object.assign(window, { reflowTest: {
  // Leave the first case unset to check Stacks' actual production default.
  configure(value?: boolean) { if (value !== undefined) sessions[0].term.options.reflowCursorLine = value; },
  defaultValue: sessions[0].term.options.reflowCursorLine,
  write(text: string) { return new Promise<void>(resolve => sessions[0].term.write(text, resolve)); },
  resize(width: number) {
    document.getElementById('first')!.style.width = `${width}px`;
    document.getElementById('second')!.style.width = `${1000 - width}px`;
    fitSessionPreservingBottom(sessions[0]);
    return snapshot();
  },
  focus(index: number) {
    const focused = focusTerminalSession(ids[index], 'reflow-regression');
    return focused && document.activeElement === sessions[index].term.textarea;
  },
  remount() {
    const session = sessions[0];
    const oldHost = document.getElementById('first')!;
    const newHost = oldHost.cloneNode(false) as HTMLElement;
    oldHost.replaceWith(newHost);
    newHost.append(session.term.element!);
    fitSessionPreservingBottom(session);
    return getTerminalSession('first') === session && session.term.element!.parentElement === newHost;
  },
  scrollBack() { sessions[0].term.scrollToTop(); },
  snapshot,
  dispose() { ids.forEach(disposeTerminalSession); },
} });
