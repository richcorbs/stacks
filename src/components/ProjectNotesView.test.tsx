import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { invoke } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applicationEvents } from '../applicationEvents';
import { ProjectNotesView } from './ProjectNotesView';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => new Promise(() => {})),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn(),
  writeText: vi.fn(),
}));

type TextareaNode = {
  focus: ReturnType<typeof vi.fn>;
  selectionEnd: number;
  selectionStart: number;
  setSelectionRange: ReturnType<typeof vi.fn>;
  value: string;
};

function keyEvent(control: TextareaNode, key: string) {
  return {
    altKey: false,
    ctrlKey: false,
    currentTarget: control,
    key,
    metaKey: true,
    preventDefault: vi.fn(),
    shiftKey: false,
    stopPropagation: vi.fn(),
  };
}

async function renderReady(notes: string | null = 'hello world', projectId = 'one') {
  if (notes !== null) vi.mocked(invoke).mockResolvedValueOnce({ notes, revision: 1 } as never);
  const control: TextareaNode = {
    focus: vi.fn(),
    selectionEnd: 0,
    selectionStart: 0,
    setSelectionRange: vi.fn(),
    value: '',
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ProjectNotesView projectId={projectId} active />,
      { createNodeMock: (element) => element.type === 'textarea' ? control : null },
    );
    await Promise.resolve();
  });
  control.value = renderer.root.findByProps({ 'aria-label': 'Project notes scratch pad' }).props.value;
  return { control, renderer };
}

function textarea(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByProps({ 'aria-label': 'Project notes scratch pad' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.mocked(readText).mockResolvedValue('');
  vi.mocked(writeText).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ProjectNotesView', () => {
  it('renders a raw multiline project scratch pad and stable inline status area', () => {
    const markup = renderToStaticMarkup(<ProjectNotesView projectId="one" active />);
    expect(markup).toContain('class="projectNotesView cardView active"');
    expect(markup).toContain('<textarea');
    expect(markup).toContain('aria-label="Project notes scratch pad"');
    expect(markup).toContain('class="projectNotesStatus loading"');
    expect(markup).toContain('Loading…');
  });

  it('waits for readiness, then focuses once per request without replacing the draft', async () => {
    let finishLoad!: (value: { notes: string; revision: number }) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => { finishLoad = resolve; }) as never);
    const focus = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ProjectNotesView projectId="one" active focusRequest={1} />,
        { createNodeMock: (element) => element.type === 'textarea' ? { focus } : null },
      );
    });

    expect(focus).not.toHaveBeenCalled();
    await act(async () => {
      finishLoad({ notes: 'Loaded note', revision: 1 });
      await Promise.resolve();
    });
    expect(focus).toHaveBeenCalledTimes(1);

    act(() => textarea(renderer).props.onChange({ target: { value: 'Unsaved draft' } }));
    act(() => renderer.update(<ProjectNotesView projectId="one" active focusRequest={2} />));

    expect(textarea(renderer).props.value).toBe('Unsaved draft');
    expect(focus).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  it('copies selected note text without changing the controlled draft', async () => {
    const { control, renderer } = await renderReady();
    control.selectionStart = 6;
    control.selectionEnd = 11;

    await act(async () => { textarea(renderer).props.onKeyDown(keyEvent(control, 'c')); });

    expect(writeText).toHaveBeenCalledWith('world');
    expect(textarea(renderer).props.value).toBe('hello world');
    expect(control.setSelectionRange).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('cuts through the notes autosave path and restores the saved content when reopened', async () => {
    vi.useFakeTimers();
    let persisted = 'hello world';
    let revision = 1;
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'load_project_notes') return Promise.resolve({ notes: persisted, revision }) as never;
      persisted = String((args as Record<string, unknown>).notes);
      revision += 1;
      return Promise.resolve({ notes: persisted, revision }) as never;
    });
    const { control, renderer } = await renderReady(null);
    control.selectionStart = 5;
    control.selectionEnd = 11;

    await act(async () => { textarea(renderer).props.onKeyDown(keyEvent(control, 'x')); });
    expect(writeText).toHaveBeenCalledWith(' world');
    expect(textarea(renderer).props.value).toBe('hello');
    expect(control.setSelectionRange).toHaveBeenCalledWith(5, 5);
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(persisted).toBe('hello');
    act(() => renderer.unmount());

    const reopened = await renderReady(null);
    expect(textarea(reopened.renderer).props.value).toBe('hello');
    act(() => reopened.renderer.unmount());
  });

  it('leaves the note and clipboard unchanged when cutting without a selection', async () => {
    const { control, renderer } = await renderReady();
    control.selectionStart = control.selectionEnd = 3;

    await act(async () => { textarea(renderer).props.onKeyDown(keyEvent(control, 'x')); });

    expect(writeText).not.toHaveBeenCalled();
    expect(textarea(renderer).props.value).toBe('hello world');
    act(() => renderer.unmount());
  });

  it.each([
    ['at the caret', 'first\nthird', 6, 6, 'second\n', 'first\nsecond\nthird', 13],
    ['over a selection', 'first\nold\nthird', 6, 9, 'new\nlines', 'first\nnew\nlines\nthird', 15],
  ])('pastes multiline content %s and restores the caret', async (_label, notes, start, end, clipboard, expected, caret) => {
    vi.mocked(readText).mockResolvedValue(clipboard);
    const { control, renderer } = await renderReady(notes);
    control.selectionStart = start;
    control.selectionEnd = end;

    await act(async () => { textarea(renderer).props.onKeyDown(keyEvent(control, 'v')); });

    expect(textarea(renderer).props.value).toBe(expected);
    expect(control.focus).toHaveBeenCalled();
    expect(control.setSelectionRange).toHaveBeenCalledWith(caret, caret);
    act(() => renderer.unmount());
  });

  it.each([
    ['cut', 'x', 'write'],
    ['paste', 'v', 'read'],
  ])('preserves note content and shows a toast when %s fails', async (action, key, failure) => {
    const messages: string[] = [];
    const unsubscribe = applicationEvents.subscribe('toast', ({ message }) => messages.push(message));
    const error = new Error('clipboard unavailable');
    if (failure === 'write') vi.mocked(writeText).mockRejectedValue(error);
    else vi.mocked(readText).mockRejectedValue(error);
    const { control, renderer } = await renderReady();
    control.selectionStart = 0;
    control.selectionEnd = 5;

    await act(async () => { textarea(renderer).props.onKeyDown(keyEvent(control, key)); });

    expect(textarea(renderer).props.value).toBe('hello world');
    expect(messages).toContain(`Could not ${action}: clipboard unavailable`);
    unsubscribe();
    act(() => renderer.unmount());
  });

  it('does not let a delayed paste overwrite a newer user edit', async () => {
    let resolveClipboard!: (text: string) => void;
    vi.mocked(readText).mockReturnValue(new Promise((resolve) => { resolveClipboard = resolve; }));
    const { control, renderer } = await renderReady();
    control.selectionStart = control.selectionEnd = 5;
    act(() => { textarea(renderer).props.onKeyDown(keyEvent(control, 'v')); });
    act(() => { textarea(renderer).props.onChange({ target: { value: 'newer edit' } }); });

    await act(async () => { resolveClipboard(' stale'); await Promise.resolve(); });

    expect(textarea(renderer).props.value).toBe('newer edit');
    expect(control.setSelectionRange).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('does not apply a delayed paste after leaving the notes view', async () => {
    let resolveClipboard!: (text: string) => void;
    vi.mocked(readText).mockReturnValue(new Promise((resolve) => { resolveClipboard = resolve; }));
    const { control, renderer } = await renderReady();
    control.selectionStart = control.selectionEnd = 5;
    act(() => { textarea(renderer).props.onKeyDown(keyEvent(control, 'v')); });
    act(() => { renderer.update(<ProjectNotesView projectId="one" active={false} />); });

    await act(async () => { resolveClipboard(' stale'); await Promise.resolve(); });

    expect(textarea(renderer).props.value).toBe('hello world');
    expect(control.setSelectionRange).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('does not apply a delayed paste to a different project notes field', async () => {
    let resolveClipboard!: (text: string) => void;
    vi.mocked(readText).mockReturnValue(new Promise((resolve) => { resolveClipboard = resolve; }));
    const { control, renderer } = await renderReady('first project', 'one');
    control.selectionStart = control.selectionEnd = 5;
    act(() => { textarea(renderer).props.onKeyDown(keyEvent(control, 'v')); });
    vi.mocked(invoke).mockResolvedValueOnce({ notes: 'second project', revision: 1 } as never);
    await act(async () => {
      renderer.update(<ProjectNotesView projectId="two" active />);
      await Promise.resolve();
    });

    await act(async () => { resolveClipboard(' stale'); await Promise.resolve(); });

    expect(textarea(renderer).props.value).toBe('second project');
    expect(control.setSelectionRange).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('does not intercept unrelated textarea shortcuts', async () => {
    const { control, renderer } = await renderReady();
    const event = keyEvent(control, 'z');

    await act(async () => { textarea(renderer).props.onKeyDown(event); });

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
