import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { invoke } from '@tauri-apps/api/core';
import type { Project, TerminalEntry, WorkspaceEntry } from '../types';
import { PiGuiView } from './PiGuiView';

const pi = vi.hoisted(() => ({
  context: { contextPercent: null }, commands: [], messages: [], tools: [],
  queuedFollowUps: [], queuedSteering: [], effectiveModels: [], availableThinkingLevels: [],
  starting: false, stopped: false, isStreaming: false, streamingText: '',
  setViewOpen: vi.fn(), prompt: vi.fn(), steer: vi.fn(), followUp: vi.fn(),
  dismissStructuredUiRequest: vi.fn(), restart: vi.fn(),
}));
vi.mock('../pi/usePiSession', () => ({ usePiSession: () => pi }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ listen: async () => () => {} }) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ readText: vi.fn(), writeText: vi.fn() }));

let renderer: TestRenderer.ReactTestRenderer;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(pi, { commands: [], messages: [] });
  pi.dismissStructuredUiRequest.mockResolvedValue(undefined);
  pi.prompt.mockResolvedValue(undefined);
  vi.mocked(writeText).mockResolvedValue(undefined);
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), setTimeout, clearTimeout });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

async function mount(composerDraftKey?: string, initialText: string | null = 'hello world') {
  const input = {
    value: '', selectionStart: 0, selectionEnd: 0, style: {}, offsetHeight: 23, scrollHeight: 23,
    closest: () => null, focus: vi.fn(), ownerDocument: { activeElement: null as unknown },
    setSelectionRange: vi.fn((start: number, end: number) => {
      input.selectionStart = start;
      input.selectionEnd = end;
    }),
  };
  input.ownerDocument.activeElement = input;
  await act(async () => {
    renderer = TestRenderer.create(<PiGuiView
      composerDraftKey={composerDraftKey}
      terminal={{ id: 'clipboard-test' } as TerminalEntry}
      workspace={{ id: 'workspace', cwd: '/tmp' } as WorkspaceEntry}
      project={{ id: 'project', path: '/tmp' } as Project}
      active visible maximized={false} canToggleMaximize={false} restartRequestNonce={0} fontSize={13}
      onFocus={vi.fn()} onClose={vi.fn()} onSplitTerminal={vi.fn()} onEditTerminal={vi.fn()} onToggleMaximize={vi.fn()}
    />, { createNodeMock: (element) => element.type === 'textarea' ? input : null });
  });
  const textarea = () => renderer.root.findByType('textarea');
  if (initialText !== null) act(() => {
    input.value = initialText;
    input.selectionStart = 6;
    input.selectionEnd = 11;
    textarea().props.onChange({ target: input });
  });
  input.setSelectionRange.mockClear();
  const key = (key: string) => ({
    key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
    nativeEvent: { isComposing: false }, currentTarget: input,
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
  });
  return { input, textarea, key };
}

function expectNoSubmission() {
  expect(pi.prompt).not.toHaveBeenCalled();
  expect(pi.steer).not.toHaveBeenCalled();
  expect(pi.followUp).not.toHaveBeenCalled();
  expect(pi.dismissStructuredUiRequest).not.toHaveBeenCalled();
}

describe('card composer integration', () => {
  function escape() {
    return { key: 'Escape', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
      preventDefault: vi.fn(), stopPropagation: vi.fn() };
  }

  it.each(['card-escape', undefined])('lets unhandled Escape through without changing text or submitting (%s)', async (draftKey) => {
    const { textarea } = await mount(draftKey);
    const event = escape();
    act(() => textarea().props.onKeyDown(event));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(textarea().props.value).toBe('hello world');
    expect(textarea().props['data-card-composer']).toBe(draftKey ? '' : undefined);
    expectNoSubmission();
  });

  it('consumes slash autocomplete Escape once before allowing card close', async () => {
    Object.assign(pi, { commands: [{ name: 'example', description: 'Example', source: 'extension' }] });
    const { textarea } = await mount('card-slash', '/ex');
    const first = escape();
    act(() => textarea().props.onKeyDown(first));
    expect(first.preventDefault).toHaveBeenCalledOnce();
    const second = escape();
    act(() => textarea().props.onKeyDown(second));
    expect(second.preventDefault).not.toHaveBeenCalled();
    expectNoSubmission();
  });

  it('consumes path autocomplete Escape once before allowing card close', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === 'discover_pi_paths' ? [{ path: 'src/main.tsx', isDir: false }] : null as never);
    const { textarea } = await mount('card-path', '@src');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(renderer.root.findAllByProps({ 'aria-label': 'Workspace files' })).toHaveLength(1);
    const first = escape();
    act(() => textarea().props.onKeyDown(first));
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(renderer.root.findAllByProps({ 'aria-label': 'Workspace files' })).toHaveLength(0);
    const second = escape();
    act(() => textarea().props.onKeyDown(second));
    expect(second.preventDefault).not.toHaveBeenCalled();
    expectNoSubmission();
  });

  it('exits prompt history to the exact original draft before allowing card close', async () => {
    Object.assign(pi, { messages: [{ role: 'user', content: 'previous prompt', timestamp: 1 }] });
    const { textarea, key } = await mount('card-history');
    act(() => textarea().props.onKeyDown({ ...key('ArrowUp'), metaKey: false, ctrlKey: true }));
    expect(textarea().props.value).toBe('previous prompt');
    const first = escape();
    act(() => textarea().props.onKeyDown(first));
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(textarea().props.value).toBe('hello world');
    const second = escape();
    act(() => textarea().props.onKeyDown(second));
    expect(second.preventDefault).not.toHaveBeenCalled();
    expectNoSubmission();
  });

  it.each([true, false])('clears only successfully submitted card drafts (%s)', async (success) => {
    const id = `card-send-${success}`;
    const original = '  hello\n world  ';
    const { textarea, key } = await mount(id, original);
    if (!success) pi.prompt.mockRejectedValueOnce(new Error('failed'));
    await act(async () => textarea().props.onKeyDown({ ...key('Enter'), metaKey: false }));
    expect(pi.prompt).toHaveBeenCalledWith(original.trim(), []);
    expect(textarea().props.value).toBe(success ? '' : original);
    act(() => renderer.unmount());
    const reopened = await mount(id, null);
    expect(reopened.textarea().props.value).toBe(success ? '' : original);
  });
});

describe('PiGuiView clipboard integration', () => {
  it('updates the controlled draft and collapses the caret after a successful cut without submitting', async () => {
    const { textarea, input, key } = await mount();
    let resolve!: () => void;
    vi.mocked(writeText).mockReturnValue(new Promise<void>((done) => { resolve = done; }));
    act(() => textarea().props.onKeyDown(key('x')));
    expect(textarea().props.value).toBe('hello world');
    expect(input.setSelectionRange).not.toHaveBeenCalled();
    await act(async () => { resolve(); });
    expect(writeText).toHaveBeenCalledExactlyOnceWith('world');
    expect(textarea().props.value).toBe('hello ');
    expect(input.setSelectionRange).toHaveBeenCalledExactlyOnceWith(6, 6);
    expectNoSubmission();
  });

  it('copies the selection without changing the controlled draft or caret', async () => {
    const { textarea, input, key } = await mount();
    await act(async () => textarea().props.onKeyDown(key('c')));
    expect(writeText).toHaveBeenCalledExactlyOnceWith('world');
    expect(textarea().props.value).toBe('hello world');
    expect(input.setSelectionRange).not.toHaveBeenCalled();
    expectNoSubmission();
  });

  it('preserves text and selection and shows an error after a failed cut', async () => {
    const { textarea, input, key } = await mount();
    vi.mocked(writeText).mockRejectedValue(new Error('denied'));
    await act(async () => textarea().props.onKeyDown(key('x')));
    expect(textarea().props.value).toBe('hello world');
    expect([input.selectionStart, input.selectionEnd]).toEqual([6, 11]);
    expect(input.setSelectionRange).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ className: 'piComposerError' }).children.join('')).toContain('Could not cut: Error: denied');
    expectNoSubmission();
  });

  it('retains the existing explicit paste path', async () => {
    const { textarea, input, key } = await mount();
    vi.mocked(readText).mockResolvedValue('there');
    await act(async () => textarea().props.onKeyDown(key('v')));
    expect(readText).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
    expect(textarea().props.value).toBe('hello there');
    expect(input.setSelectionRange).toHaveBeenCalledWith(11, 11);
    expectNoSubmission();
  });
});
