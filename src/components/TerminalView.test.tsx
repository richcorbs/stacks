import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const { restart, beginSelectionCopy } = vi.hoisted(() => ({
  restart: vi.fn(() => true),
  beginSelectionCopy: vi.fn(),
}));

vi.mock('../hooks/useTerminalSession', () => ({
  useTerminalSession: () => ({
    hostRef: { current: null },
    termRef: { current: null },
    fitRef: { current: null },
    restartTerminalSessionIfDead: restart,
  }),
}));
vi.mock('../hooks/useTerminalSelectionCopy', () => ({ useTerminalSelectionCopy: () => ({ beginSelectionCopy }) }));
vi.mock('../hooks/useTerminalSearch', () => ({
  useTerminalSearch: () => ({ searchOpen: false, onSearchResultsChange: vi.fn() }),
}));
vi.mock('../hooks/useTerminalOptions', () => ({ useTerminalOptions: vi.fn() }));
vi.mock('../hooks/useTerminalRestartRequest', () => ({ useTerminalRestartRequest: vi.fn() }));
vi.mock('../hooks/useTerminalActivation', () => ({ useTerminalActivation: vi.fn() }));

import { TerminalView } from './TerminalView';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const baseProps = {
  terminal: { id: 'service', workspaceId: 'workspace', temporary: true },
  workspace: { id: 'workspace', name: 'Workspace', cwd: '/tmp' },
  project: { id: 'project', name: 'Project', path: '/tmp' },
  active: true,
  maximized: false,
  visible: true,
  terminalFontSize: 13,
  terminalFontFamily: 'monospace',
  terminalScrollback: 1000,
  copyOnSelect: true,
  searchRequestNonce: 0,
  restartRequestNonce: 0,
  onFocus: vi.fn(),
  onClose: vi.fn(),
  onSplitTerminal: vi.fn(),
  onEditTerminal: vi.fn(),
  onInput: vi.fn(),
  canToggleMaximize: false,
  onToggleMaximize: vi.fn(),
};

describe('TerminalView managed services', () => {
  it('does not restart a stopped managed service when its output is clicked', async () => {
    restart.mockClear();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<TerminalView {...baseProps} managedService />); });

    act(() => { renderer.root.findByProps({ 'data-terminal-pane-id': 'service' }).props.onMouseDown(); });

    expect(beginSelectionCopy).toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it('retains click-to-restart for ordinary workspace terminals', async () => {
    restart.mockClear();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<TerminalView {...baseProps} />); });

    act(() => { renderer.root.findByProps({ 'data-terminal-pane-id': 'service' }).props.onMouseDown(); });

    expect(restart).toHaveBeenCalledOnce();
  });
});
