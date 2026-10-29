import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { PiGuiView } from '../src/components/PiGuiView';
import { CardChatView } from '../src/components/kanban/CardChatView';
import type { KanbanCard } from '../src/kanban/types';
import type { Project, TerminalEntry, WorkspaceEntry } from '../src/types';
import { updateSession } from './pi-chat-scroll-session';
import '../src/styles.css';

mockWindows('main');
mockIPC(() => null);
const noop = () => {};
const root = createRoot(document.getElementById('fixture')!);
let mountId = 0;
function mount(card: boolean) {
  root.render(<React.Fragment key={++mountId}>{card ? <div className="modalBackdrop kanbanDetailBackdrop"><section className="kanbanDetail cardWorkspace chatActive">
    <header><h2>Card chat scroll test</h2></header><nav className="cardWorkspaceTabs"><button>CHAT</button></nav>
    <CardChatView card={{ id: 'scroll-test', external_id: '291' } as KanbanCard} project={{ id: 'project', path: '/tmp' } as Project} cardPath="/tmp" thread="work" active deploymentOutput="" />
    <footer><button>Card action</button></footer>
  </section></div> : <PiGuiView key={String(card)}
    terminal={{ id: 'scroll-test' } as TerminalEntry}
    workspace={{ id: 'workspace', cwd: '/tmp' } as WorkspaceEntry}
    project={{ id: 'project', path: '/tmp' } as Project}
    active visible maximized={false} canToggleMaximize={false} restartRequestNonce={0} fontSize={13}
    onFocus={noop} onClose={noop} onSplitTerminal={noop} onEditTerminal={noop} onToggleMaximize={noop}
  />}</React.Fragment>);
}
Object.assign(window, { chatTest: {
  mount: (card: boolean) => flushSync(() => mount(card)),
  updateSession: (patch: Parameters<typeof updateSession>[0]) => flushSync(() => updateSession(patch)),
} });
mount(false);
