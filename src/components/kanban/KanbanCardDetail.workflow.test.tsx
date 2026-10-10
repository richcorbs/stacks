import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanCardDetail } from './KanbanCardDetail';
import { CardDetailTabs } from './CardDetailChrome';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('./CardChatView', () => ({ CardChatView: () => null }));
vi.mock('./CardTerminalView', () => ({ CardTerminalView: () => null }));
vi.mock('./CardOverview', () => ({ CardOverview: () => null }));
vi.mock('./CardDiffView', () => ({ CardDiffView: () => null }));
vi.mock('./CardServiceTerminal', () => ({ CardServiceTerminal: () => null }));
vi.mock('../DiffTab', () => ({ DiffTab: () => null }));
vi.mock('../../kanban/useCardTerminalWorkspace', () => ({ useCardTerminalWorkspace: () => ({ focusedShellPane: null, pendingCloseShellPane: null, setPendingCloseShellPane: vi.fn(), closeShellPane: vi.fn(), applyEnvironment: vi.fn() }) }));

const project = { id: 'p', name: 'P', path: '/repo', server_command: 'echo server', console_command: 'echo console', delivery_workflow: 'local_merge', target_branch: 'main' };
const baseCard = { id: 'local:1', provider: 'local', external_id: '1', title: 'Card', content: '', board_id: '', board_title: '', list_id: '', list_title: '', card_url: '', assignee_names: [], status: 'ready', workflow_revision: 1, record_revision: 1, project_id: 'p', parent: null, child_count: 0, children: [], hierarchy_finalized: false, environment: { worktree_path: '/repo' }, created_at: 1, updated_at: 1, sort_order: 0, events: [] };
let keyboard: (event: KeyboardEvent) => void;
let modalOpen = false;
beforeEach(() => {
  vi.stubGlobal('window', { addEventListener: (type: string, listener: typeof keyboard) => { if (type === 'keydown') keyboard = listener; }, removeEventListener: vi.fn(), confirm: vi.fn(() => true) });
  vi.stubGlobal('document', { querySelector: () => modalOpen ? {} : null, activeElement: null });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  modalOpen = false;
});
afterEach(() => vi.unstubAllGlobals());

async function mount(options: { initialView?: 'overview' | 'chat' | 'diff' | 'terminal' | 'server' | 'console'; capabilities?: { action: string; available: boolean; disabled_reason?: string }[]; onStartWork?: () => Promise<boolean>; onUpdate?: () => Promise<never> } = {}) {
  const card = { ...baseCard, capabilities: options.capabilities ?? [{ action: 'return_to_refinement', available: true }, { action: 'start_work', available: true }] };
  const onStartWork = options.onStartWork ?? vi.fn(async () => false);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<KanbanCardDetail card={card as never} cards={[]} cardServices={{} as never} projects={[project as never]} terminalFontSize={13} terminalFontFamily="monospace" terminalScrollback={1000} copyOnSelect={false} initialView={options.initialView} gitChangeSummary={null} detailLoadError={null} detailRefreshError={null} requireActionPreflight={false} hasOlderEvents={false} onLoadOlderEvents={async () => {}} onRecheckEnvironment={async () => ({} as never)} onClose={() => {}} onUpdate={options.onUpdate ?? (async () => card as never)} onAction={async () => {}} onStopRefinement={async () => {}} onOpenChat={async () => {}} onRefine={async () => true} onStartWork={onStartWork} onCleanup={async () => {}} onDelete={async () => {}} onReload={async () => card as never} onRetryRefresh={async () => {}} onCardUpdated={() => {}} onNavigate={() => {}} onToggleServer={() => {}} />); });
  return { renderer, onStartWork };
}
function key(metaKey = true, shiftKey = false) {
  const event = { key: 'Enter', metaKey, shiftKey, ctrlKey: false, altKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  keyboard(event as unknown as KeyboardEvent);
  return event;
}

describe('card workflow shortcut', () => {
  it.each(['overview', 'chat', 'diff'] as const)('invokes the sole styled primary on %s, not plain Enter', async (initialView) => {
    const { renderer, onStartWork } = await mount({ initialView });
    expect(renderer.root.findAllByProps({ 'aria-label': 'Workflow actions' })).toHaveLength(1);
    const buttons = renderer.root.findAllByType('button').filter((button) => button.props['aria-label'] === 'Start work' || button.props['aria-label'] === 'Return to refinement');
    expect(buttons.filter((button) => button.props.className?.includes('primaryAction')).map((button) => button.props['aria-label'])).toEqual(['Start work']);
    expect(key(false).preventDefault).not.toHaveBeenCalled();
    expect(key(false, true).preventDefault).not.toHaveBeenCalled();
    await act(async () => { expect(key().preventDefault).toHaveBeenCalledOnce(); await Promise.resolve(); });
    expect(onStartWork).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });

  it.each(['terminal', 'server', 'console'] as const)('hides workflow and ignores shortcut on %s', async (initialView) => {
    const { renderer, onStartWork } = await mount({ initialView });
    expect(renderer.root.findAllByProps({ 'aria-label': 'Workflow actions' })).toHaveLength(0);
    expect(key().preventDefault).not.toHaveBeenCalled();
    expect(onStartWork).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('keeps a disabled primary styled without promoting an enabled alternative', async () => {
    const { renderer, onStartWork } = await mount({ capabilities: [{ action: 'return_to_refinement', available: true }, { action: 'start_work', available: false, disabled_reason: 'Blocked' }] });
    const button = renderer.root.findAllByType('button').find((item) => item.props['aria-label'] === 'Start work')!;
    expect(button.props.className).toContain('primaryAction');
    expect(button.props.disabled).toBe(true);
    expect(key().preventDefault).not.toHaveBeenCalled();
    expect(onStartWork).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('does not trigger twice while busy or behind a dialog', async () => {
    let finish!: (value: boolean) => void;
    const onStartWork = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { renderer } = await mount({ onStartWork });
    modalOpen = true;
    expect(key().preventDefault).not.toHaveBeenCalled();
    modalOpen = false;
    act(() => { key(); key(); });
    expect(onStartWork).toHaveBeenCalledOnce();
    await act(async () => { finish(false); await Promise.resolve(); });
    act(() => renderer.unmount());
  });

  it('keeps editing Cmd+Enter bound to Save instead of the workflow action', async () => {
    const onUpdate = vi.fn(async () => ({ ...baseCard, capabilities: [] }) as never);
    const { renderer, onStartWork } = await mount({ onUpdate, initialView: 'overview' });
    act(() => renderer.root.findByProps({ 'aria-label': 'Edit card' }).props.onClick());
    expect(renderer.root.findByType(CardDetailTabs).props.activeView).toBe('overview');
    await act(async () => { expect(key().preventDefault).toHaveBeenCalledOnce(); await Promise.resolve(); });
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onStartWork).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('shares click-path confirmation for a lone close action', async () => {
    const { renderer } = await mount({ capabilities: [{ action: 'close', available: true }] });
    const button = renderer.root.findAllByType('button').find((item) => item.props['aria-label'] === 'Close without delivery')!;
    expect(button.props.className).toContain('primaryAction');
    await act(async () => { button.props.onClick(); await Promise.resolve(); });
    expect(window.confirm).toHaveBeenCalledOnce();
    await act(async () => { key(); await Promise.resolve(); });
    expect(window.confirm).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  it('does not render an empty action row', async () => {
    const { renderer } = await mount({ capabilities: [] });
    expect(renderer.root.findAllByProps({ 'aria-label': 'Workflow actions' })).toHaveLength(0);
    expect(key().preventDefault).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
