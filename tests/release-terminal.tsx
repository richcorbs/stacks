// Real ReleaseTab/TerminalView/session factory. Only native transport is stubbed;
// sustained harmless output is written to the cached release session, never a PTY.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReleaseTab } from '../src/components/ReleaseTab';
import { createTerminalSession } from '../src/terminalSessionFactory';
import { setTerminalSession } from '../src/terminalSessionManager';
import '../src/styles.css';

const terminalId = 'release-border-fixture';
const cwd = '/harmless-release-fixture';
Object.assign(window, { __TAURI_INTERNALS__: {
  invoke: async (command: string) => {
    if (command === 'release_setup') return { cwd, terminalId };
    if (command === 'release_latest') return 'fixture only — no release execution';
    if (command === 'resize_pty') return;
    throw new Error(`Unexpected native command: ${command}`);
  },
} });
const session = createTerminalSession({ terminalId, host: document.createElement('div'), terminalFontFamily: 'Menlo, monospace', terminalFontSize: 13, terminalScrollback: 10000, onInput: () => {} });
Object.assign(session, { spawned: true, running: true, startupCwd: cwd, startupConfiguredCommand: 'harmless fixture output' });
setTerminalSession(terminalId, session);
let line = 0;
setInterval(() => session.term.write(Array.from({ length: 8 }, () => `Harmless release output ${++line}: héllo 世界\r\n`).join('')), 30);
function Fixture() {
  const [active, setActive] = useState(true);
  return <div className="modalBackdrop kanbanDetailBackdrop"><article className="kanbanDetail cardWorkspace directProjectWork">
    <header>Release output border fixture</header>
    <nav className="cardWorkspaceTabs"><button onClick={() => setActive(true)}>RELEASE</button><button onClick={() => setActive(false)}>Other tab</button></nav>
    <ReleaseTab project={{ id: 'fixture', name: 'Fixture', path: cwd }} active={active} copyOnSelect={false} />
    {!active && <section style={{ flex: 1 }}>Other tab (output keeps running)</section>}
  </article></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
Object.assign(window, { releaseTerminalTest: { session } });
