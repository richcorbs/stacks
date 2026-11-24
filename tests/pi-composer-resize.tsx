import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { PiGuiView } from '../src/components/PiGuiView';
import type { Project, TerminalEntry, WorkspaceEntry } from '../src/types';
import '../src/styles.css';

mockWindows('main');
mockIPC(() => null);
const noop = () => {};
const root = createRoot(document.getElementById('fixture')!);
let fontSize = 13;
let mountId = 0;

function render() {
  root.render(<PiGuiView
    key={mountId}
    terminal={{ id: 'composer-resize-test' } as TerminalEntry}
    workspace={{ id: 'workspace', cwd: '/tmp' } as WorkspaceEntry}
    project={{ id: 'project', path: '/tmp' } as Project}
    active visible maximized={false} canToggleMaximize={false} restartRequestNonce={0} fontSize={fontSize}
    onFocus={noop} onClose={noop} onSplitTerminal={noop} onEditTerminal={noop} onToggleMaximize={noop}
  />);
}

Object.assign(window, { composerTest: {
  mount: () => flushSync(() => { mountId += 1; render(); }),
  setFontSize: (next: number) => flushSync(() => { fontSize = next; render(); }),
} });
render();
