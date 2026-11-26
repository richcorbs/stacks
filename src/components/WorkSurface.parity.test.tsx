import type { ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { KanbanCardDetail } from './kanban/KanbanCardDetail';
import { CardChatView } from './kanban/CardChatView';
import { CardTerminalView } from './kanban/CardTerminalView';
import { DirectProjectWork } from './DirectProjectWork';
import { WorkAgentView } from './WorkAgentView';
import { pasteCodeIntoTarget } from '../terminalCodePaste';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('../terminalCodePaste', () => ({ pasteCodeIntoTarget: vi.fn().mockResolvedValue(true) }));
vi.mock('./kanban/CardChatView', () => ({ CardChatView: () => null }));
vi.mock('./kanban/CardTerminalView', () => ({ CardTerminalView: () => null }));
vi.mock('./kanban/CardOverview', () => ({ CardOverview: () => null }));
vi.mock('./kanban/CardDiffView', () => ({ CardDiffView: () => null }));
vi.mock('./WorkAgentView', () => ({ WorkAgentView: () => null }));
vi.mock('./WorkDiffView', () => ({ WorkDiffView: () => null }));
vi.mock('./WorkspaceShellView', () => ({ WorkspaceShellView: () => null }));
vi.mock('./ProjectNotesView', () => ({ ProjectNotesView: () => null }));
vi.mock('./PiGuiView', () => ({ PiGuiView: () => null }));
vi.mock('../hooks/useServicePanes', () => ({ useServicePanes: () => ({ controls: undefined, running: false, context: undefined }) }));
vi.mock('../hooks/useDirectProjectShell', () => ({
  useDirectProjectShell: () => ({
    owner: { kind: 'project', projectId: 'p' },
    workspaceId: 'project-direct:p',
    controller: { cancelClose: vi.fn(), close: vi.fn() },
    shell: { focusedPaneId: 'project-direct:p:terminal:shell', paneIds: ['project-direct:p:terminal:shell'], maximizedPaneId: null, pendingClosePaneId: null },
    loading: false,
    error: null,
  }),
}));
vi.mock('../kanban/useCardTerminalWorkspace', () => ({
  useCardTerminalWorkspace: () => ({
    controller: {},
    focusedShellPane: 'kanban-card:c:terminal:shell',
    shellTerminalIds: ['kanban-card:c:terminal:shell'],
    maximizedShellPane: null,
    pendingCloseShellPane: null,
    setPendingCloseShellPane: vi.fn(),
    closeShellPane: vi.fn(),
    applyEnvironment: vi.fn(),
  }),
}));

const project = { id: 'p', name: 'Project', path: '/repo', workspaces: [] };
const card = {
  id: 'c', provider: 'local', external_id: '352', title: 'Card', content: '', status: 'agent_working',
  workflow_revision: 1, record_revision: 1, project_id: 'p', capabilities: [],
  environment: { worktree_path: '/worktree', target_branch: 'main' },
};

function noop() {}
const cardProps = {
  card: card as never, cards: [], projects: [project], terminalFontSize: 13, terminalFontFamily: 'monospace', terminalScrollback: 1000, copyOnSelect: false,
  gitChangeSummary: null, detailLoadError: null, detailRefreshError: null, requireActionPreflight: false, hasOlderEvents: false,
  onLoadOlderEvents: async () => {}, onRecheckEnvironment: async () => ({} as never), onRefreshGit: async () => {},
  onClose: noop, onUpdate: async () => card as never, onAction: async () => {}, onStopRefinement: async () => {},
  onOpenChat: async () => {}, onRefine: async () => true, onStartWork: async () => true, onCleanup: async () => {},
  onDelete: async () => {}, onReload: async () => card as never, onRetryRefresh: async () => {}, onCardUpdated: noop, onNavigate: noop,
};

beforeEach(() => {
  vi.stubGlobal('window', {
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    setInterval: () => 1, clearInterval: vi.fn(), setTimeout: () => 1, clearTimeout: vi.fn(),
  });
  vi.stubGlobal('document', { querySelector: () => null, activeElement: null });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback());
  vi.mocked(pasteCodeIntoTarget).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(invoke).mockResolvedValue(null);
});

async function mount(element: ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(element); });
  return renderer;
}

describe.each(['card', 'project'] as const)('paste into terminal from the %s surface', (kind) => {
  it('offers the same action and targets the owner terminal', async () => {
    const renderer = kind === 'card'
      ? await mount(<KanbanCardDetail {...cardProps} initialView="chat" />)
      : await mount(<DirectProjectWork project={project as never} terminalFontSize={13} terminalFontFamily="monospace" terminalScrollback={1000} copyOnSelect={false} onClose={noop} />);
    const onPaste = kind === 'card'
      ? renderer.root.findByType(CardChatView).props.onPasteIntoTerminal
      : renderer.root.findByType(WorkAgentView).props.onPasteIntoTerminal;
    expect(onPaste).toBeTypeOf('function');
    await act(async () => { await onPaste('const x = 1;'); });
    expect(pasteCodeIntoTarget).toHaveBeenCalledOnce();
    const [code, options] = vi.mocked(pasteCodeIntoTarget).mock.calls[0];
    expect(code).toBe('const x = 1;');
    expect(options.paneId).toBe(kind === 'card' ? 'kanban-card:c:terminal:shell' : 'project-direct:p:terminal:shell');
    await act(async () => { expect(await options.switchToTerminal()).toBe(true); });
    if (kind === 'card') expect(renderer.root.findByType(CardTerminalView).props.active).toBe(true);
    else expect(renderer.root.findByProps({ className: 'cardTerminalView cardView active' })).toBeTruthy();
    act(() => renderer.unmount());
  });
});
