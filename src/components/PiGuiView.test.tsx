import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, TerminalEntry, WorkspaceEntry } from '../types';
import { PiGuiView, PiMcpCommandStatus, PiPendingOutput, PiQueuedMessage, useMcpBannerDismissal } from './PiGuiView';

const pi = vi.hoisted(() => ({
  context: { contextPercent: null }, commands: [], messages: [], tools: [], queuedFollowUps: [], queuedSteering: [],
  effectiveModels: [], availableThinkingLevels: [], starting: false, stopped: false,
  isStreaming: false, streamingText: '', mcpStatus: 'connected', uiRequest: null as unknown,
  setViewOpen: vi.fn(), restart: vi.fn(), prompt: vi.fn(async () => {}),
  dismissStructuredUiRequest: vi.fn(async () => {}),
}));
vi.mock('../pi/usePiSession', () => ({ usePiSession: () => pi }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async (command: string) => command === 'pi_mcp_local_status' ? { local_config_present: true, trusted: false } : false) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ listen: async () => () => {} }) }));
vi.mock('./ConfirmationBoundary', () => ({ ConfirmationBoundary: ({ children }: { children: React.ReactNode }) => children }));

// These tests exercise production controls and focus scheduling, not native browser focus.
describe('PiGuiView MCP dismissal focus', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let frames: Array<() => void>;
  let nextId = 0;
  beforeEach(() => {
    frames = [];
    pi.starting = false;
    pi.uiRequest = null;
    vi.clearAllMocks();
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });
  afterEach(() => {
    if (renderer) act(() => renderer.unmount());
    vi.unstubAllGlobals();
  });
  function flushFrames() { act(() => { frames.splice(0).forEach((frame) => frame()); }); }
  async function mount(kind: 'persistent' | 'command') {
    const input = { value: '', selectionStart: 0, selectionEnd: 0, style: {}, offsetHeight: 23, scrollHeight: 23, closest: () => null, focus: vi.fn(), setSelectionRange: vi.fn() };
    const terminalId = `focus-mcp-${++nextId}`;
    let active = true;
    let visible = true;
    const view = () => <PiGuiView
      terminal={{ id: terminalId } as TerminalEntry} workspace={{ id: 'workspace', cwd: '/tmp' } as WorkspaceEntry}
      project={{ id: 'project', path: '/tmp', enable_mcp: true } as Project}
      active={active} visible={visible} maximized={false} canToggleMaximize={false} restartRequestNonce={0} fontSize={13}
      onFocus={vi.fn()} onClose={vi.fn()} onSplitTerminal={vi.fn()} onEditTerminal={vi.fn()} onToggleMaximize={vi.fn()}
    />;
    await act(async () => { renderer = TestRenderer.create(view(), { createNodeMock: (element) => element.type === 'textarea' ? input : null }); });
    const textarea = () => renderer.root.findByType('textarea');
    const change = (text: string) => act(() => { input.value = text; textarea().props.onChange({ target: input }); });
    if (kind === 'command') {
      change('/mcp');
      await act(async () => { textarea().props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault: vi.fn() }); });
    }
    change('hello world');
    flushFrames();
    input.focus.mockClear();
    input.setSelectionRange.mockClear();
    const close = () => renderer.root.findByProps({ 'aria-label': kind === 'persistent' ? 'Dismiss MCP status' : 'Dismiss MCP command status' });
    const update = (state: { active?: boolean; visible?: boolean }) => act(() => {
      active = state.active ?? active;
      visible = state.visible ?? visible;
      renderer.update(view());
    });
    return { input, textarea, close, update };
  }

  describe.each(['persistent', 'command'] as const)('%s banner', (kind) => {
    it.each([[5, 5], [3, 8]])('preserves the draft and selection %i–%i on mouse dismissal', async (start, end) => {
      const { input, textarea, close } = await mount(kind);
      input.selectionStart = start;
      input.selectionEnd = end;
      const preventDefault = vi.fn();
      act(() => close().props.onMouseDown({ preventDefault }));
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(input.focus).not.toHaveBeenCalled();
      act(() => close().props.onClick());
      flushFrames();
      expect(input.focus).toHaveBeenCalledOnce();
      expect(textarea().props.value).toBe('hello world');
      expect([input.selectionStart, input.selectionEnd]).toEqual([start, end]);
      expect(input.setSelectionRange).not.toHaveBeenCalled();
      expect(renderer.root.findAllByProps({ 'aria-label': kind === 'persistent' ? 'Dismiss MCP status' : 'Dismiss MCP command status' })).toHaveLength(0);
      // The other banner has independent dismissal state.
      if (kind === 'command') expect(renderer.root.findAllByProps({ 'aria-label': 'Dismiss MCP status' })).toHaveLength(1);
    });

    it('retains native keyboard button semantics and restores focus after activation', async () => {
      const { input, textarea, close } = await mount(kind);
      input.selectionStart = 2;
      input.selectionEnd = 7;
      expect(close().type).toBe('button');
      expect(close().props.type).toBe('button');
      expect(close().props.tabIndex).toBeUndefined();
      // Enter and Space both produce click on a native button; no custom key handler.
      expect(close().props.onKeyDown).toBeUndefined();
      act(() => close().props.onClick());
      expect(input.focus).not.toHaveBeenCalled();
      flushFrames();
      expect(input.focus).toHaveBeenCalledOnce();
      expect(textarea().props.value).toBe('hello world');
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
      expect(input.setSelectionRange).not.toHaveBeenCalled();
    });

    it.each([
      ['inactive', false], ['hidden', false], ['starting', false], ['modal', false],
      ['inactive', true], ['hidden', true], ['starting', true], ['modal', true],
    ] as const)('does not focus while %s (dismissal already queued: %s)', async (guard, queued) => {
      const { input, close, update } = await mount(kind);
      if (queued) act(() => close().props.onClick());
      if (guard === 'inactive') update({ active: false });
      if (guard === 'hidden') update({ visible: false });
      if (guard === 'starting') { pi.starting = true; update({}); }
      if (guard === 'modal') { pi.uiRequest = { method: 'input', id: 'modal', title: 'Input' }; update({}); }
      if (!queued) act(() => close().props.onClick());
      flushFrames();
      expect(input.focus).not.toHaveBeenCalled();
    });

    it.each(['trust', 'restart'] as const)('leaves an open %s confirmation intact', async (confirmation) => {
      const { input, close, update } = await mount(kind);
      if (confirmation === 'restart') { pi.uiRequest = { method: 'input', id: 'modal', title: 'Input' }; update({}); }
      const label = confirmation === 'trust' ? 'Trust this directory for Pi' : 'Restart Pi to apply setting';
      act(() => renderer.root.findAllByType('button').find((button) => button.children.join('') === label)!.props.onClick());
      pi.uiRequest = null;
      update({});
      flushFrames();
      input.focus.mockClear();
      act(() => close().props.onClick());
      flushFrames();
      expect(renderer.root.findAllByProps({ role: 'alertdialog' })).toHaveLength(1);
      expect(input.focus).not.toHaveBeenCalled();
      expect(pi.restart).not.toHaveBeenCalled();
    });
  });
});

function McpBannerHarness({ terminalId }: { terminalId: string }) {
  const [dismissed, dismiss] = useMcpBannerDismissal(terminalId);
  return dismissed ? null : <div className="piMcpStatus"><button aria-label="Dismiss MCP status" onClick={dismiss}>×</button></div>;
}

describe('Pi MCP banner dismissal', () => {
  it('survives a session restart and view remount, but is scoped to the terminal ID', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    const banner = () => renderer.root.findAllByProps({ className: 'piMcpStatus' });
    act(() => { renderer = TestRenderer.create(<McpBannerHarness terminalId="mcp-test-a" />); });
    expect(banner()).toHaveLength(1);
    act(() => renderer.root.findByProps({ 'aria-label': 'Dismiss MCP status' }).props.onClick());
    expect(banner()).toHaveLength(0);
    // A Pi restart does not change the pane ID or re-show the banner.
    act(() => renderer.update(<McpBannerHarness terminalId="mcp-test-a" />));
    expect(banner()).toHaveLength(0);
    act(() => renderer.update(<McpBannerHarness terminalId="mcp-test-b" />));
    expect(banner()).toHaveLength(1);
    act(() => renderer.update(<McpBannerHarness terminalId="mcp-test-a" />));
    expect(banner()).toHaveLength(0);
    act(() => renderer.unmount());
    act(() => { renderer = TestRenderer.create(<McpBannerHarness terminalId="mcp-test-a" />); });
    expect(banner()).toHaveLength(0);
    act(() => renderer.update(<McpBannerHarness terminalId="mcp-test-b" />));
    expect(banner()).toHaveLength(1);
    act(() => renderer.unmount());
  });
});

describe('Pi MCP command output', () => {
  it('shows the sanitized RPC status independently of a dismissed MCP banner', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<PiMcpCommandStatus status="connected" notice="MCP datadog: connected (reported by Pi)." onDismiss={() => renderer.unmount()} />); });
    expect(renderer.root.findByProps({ className: 'piMcpCommandStatus' }).props.role).toBe('status');
    expect(renderer.root.findByType('span').children.join('')).toBe('MCP connection: connected. MCP datadog: connected (reported by Pi).');
    act(() => renderer.root.findByProps({ 'aria-label': 'Dismiss MCP command status' }).props.onClick());
    expect(renderer.toJSON()).toBeNull();
  });
});

describe('PiGuiView queued messages', () => {
  it('renders the thinking indicator before steering and follow-up messages', () => {
    const markup = renderToStaticMarkup(
      <PiPendingOutput
        isStreaming
        hasActiveStreamingText={false}
        queuedSteering={['**Steer** here']}
        queuedFollowUps={['Follow <em>up</em>']}
      />,
    );

    const thinkingIndex = markup.indexOf('aria-label="Pi is thinking"');
    const steeringIndex = markup.indexOf('aria-label="Queued steering message"');
    const followUpIndex = markup.indexOf('aria-label="Queued follow-up"');
    expect(thinkingIndex).toBeGreaterThanOrEqual(0);
    expect(thinkingIndex).toBeLessThan(steeringIndex);
    expect(steeringIndex).toBeLessThan(followUpIndex);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('<strong>Steer</strong> here');
    expect(markup).toContain('Follow <em>up</em>');
  });

  it('does not show the thinking indicator while assistant text is actively streaming', () => {
    const markup = renderToStaticMarkup(
      <PiPendingOutput
        isStreaming
        hasActiveStreamingText
        queuedSteering={['Still queued']}
        queuedFollowUps={[]}
      />,
    );

    expect(markup).not.toContain('aria-label="Pi is thinking"');
    expect(markup).toContain('aria-label="Queued steering message"');
  });

  it.each([
    ['steering' as const, 'Queued steering message', 'Steering', 'piQueuedSteering'],
    ['follow-up' as const, 'Queued follow-up', 'Follow up', 'piQueuedFollowUp'],
  ])('renders queued %s content with the shared mixed-content renderer', (kind, ariaLabel, label, className) => {
    const markup = renderToStaticMarkup(
      <PiQueuedMessage kind={kind}>**Markdown** and &lt;em&gt;HTML&lt;/em&gt;</PiQueuedMessage>,
    );

    expect(markup).toContain(`aria-label="${ariaLabel}"`);
    expect(markup).toContain(className);
    expect(markup).toContain(`<small>${label}</small>`);
    expect(markup).toContain('class="piQueuedMessageContent piMarkdown"');
    expect(markup).toContain('<strong>Markdown</strong> and <em>HTML</em>');
  });
});
