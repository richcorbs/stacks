import { useState, type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applicationEvents } from '../applicationEvents';
import { publishWorkPresence } from '../appAttention';
import { workAgentId, workTerminalId, type WorkOwner, type WorkView } from '../directWork';
import { sendTextToPiEditor } from '../pi/editorTextEvent';
import { pasteCodeIntoTarget } from '../terminalCodePaste';
import { requestWorkLeave, type WorkTab } from '../workSurface';
import { WorkSurface, type WorkSurfaceAdapter } from './WorkSurface';
import { WorkTabs } from './WorkTabs';

vi.mock('../terminalCodePaste', () => ({ pasteCodeIntoTarget: vi.fn().mockResolvedValue(true) }));
vi.mock('../pi/editorTextEvent', () => ({ sendTextToPiEditor: vi.fn().mockResolvedValue(true) }));
vi.mock('./ProjectNotesView', () => ({ ProjectNotesView: ({ active }: { active: boolean }) => <div data-notes={String(active)} /> }));
vi.mock('../appAttention', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../appAttention')>();
  return { ...actual, publishWorkPresence: vi.fn(actual.publishWorkPresence) };
});

const owners = ['card', 'project'] as const;

function owner(kind: typeof owners[number]): WorkOwner {
  return kind === 'card' ? { kind, cardId: 'c1' } : { kind, projectId: 'p1' };
}

function views(kind: typeof owners[number]): WorkView[] {
  return kind === 'card'
    ? ['overview', 'agent', 'diff', 'terminal']
    : ['agent', 'notes', 'diff', 'terminal'];
}

const labels: Record<string, string> = { overview: 'Description', agent: 'Agent', notes: 'Notes', diff: 'Diff', terminal: 'Terminal', release: 'RELEASES' };

let refreshDiff: () => void;

function Harness({ owner, initialView = 'agent', available, displayed, pasteAvailable = true, onError = () => {}, onRequestClose = () => {} }: {
  owner: WorkOwner;
  initialView?: WorkView;
  available?: WorkView[];
  displayed?: WorkView[];
  pasteAvailable?: boolean;
  onError?: (message: string) => void;
  onRequestClose?: () => void;
}) {
  const isCard = owner.kind === 'card';
  const allViews = views(owner.kind);
  const navigable = available ?? allViews;
  const shown = displayed ?? allViews;
  const [activeView, setActiveView] = useState<WorkView>(initialView);
  const agentId = workAgentId(owner, isCard ? 'work' : undefined);
  const terminalId = workTerminalId(owner, 'shell');
  const selectView = (view: WorkView) => {
    if (!navigable.includes(view)) return false;
    setActiveView(view);
    return true;
  };
  const tabs: WorkTab[] = shown.map((view) => ({ view, label: labels[view], disabled: !navigable.includes(view) }));
  const adapter: WorkSurfaceAdapter = {
    activeView,
    available: navigable,
    displayed: shown,
    sections: [
      ...(isCard ? [{ view: 'overview' as const, content: (active: boolean) => <div data-overview={String(active)} /> }] : []),
      { view: 'agent' },
      { view: 'notes' },
      { view: 'diff' },
      { view: 'terminal' },
    ],
    selectView,
    renderTabs: () => <WorkTabs activeView={activeView} tabs={tabs} ariaLabel="Work views" onSelect={selectView} onRefreshDiff={refreshDiff} />,
    agent: {
      id: agentId,
      thread: isCard ? 'work' : undefined,
      render: (active, onPaste) => <div data-agent={String(active)}>
        {onPaste && <button onClick={() => { void onPaste('const x = 1;'); }}>Paste</button>}
      </div>,
    },
    diff: {
      reviewKey: 'review',
      canSubmit: true,
      errorMessage: 'Could not send the review.',
      render: ({ active, review, onSubmit }) => <div data-diff={String(active)} data-comment={review.overallComment}>
        <button onClick={() => review.setOverallComment('overall feedback')}>Comment</button>
        <button onClick={onSubmit}>Submit</button>
      </div>,
    },
    notes: isCard ? undefined : { projectId: 'p1' },
    terminal: {
      focusedPaneId: terminalId,
      paneIds: [terminalId],
      cwd: '/repo',
      maximized: false,
      available: true,
      pasteAvailable,
      pasteUnavailableReason: pasteAvailable ? null : 'no terminal',
      render: (active) => <div data-terminal={String(active)} />,
    },
    onError,
  };
  return <WorkSurface owner={owner} tabs={adapter} header={<div data-header />} onRequestClose={onRequestClose} />;
}

async function mount(element: ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(element); });
  return renderer;
}

function button(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAllByType('button').find((candidate) => {
    const children = candidate.props.children;
    return children === label || (Array.isArray(children) && children[0] === label);
  });
}

const viewMarkers: Array<[WorkView, string]> = [
  ['overview', 'data-overview'], ['agent', 'data-agent'], ['notes', 'data-notes'], ['diff', 'data-diff'], ['terminal', 'data-terminal'],
];

function activeView(renderer: TestRenderer.ReactTestRenderer) {
  return viewMarkers.find(([, marker]) => renderer.root.findAllByProps({ [marker]: 'true' }).length > 0)?.[0] ?? 'unknown';
}

beforeEach(() => {
  refreshDiff = vi.fn();
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback());
  vi.mocked(pasteCodeIntoTarget).mockClear();
  vi.mocked(sendTextToPiEditor).mockClear();
  vi.mocked(publishWorkPresence).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  applicationEvents.publish('card-tab-shortcut', {});
});

describe.each(owners)('%s surface', (kind) => {
  it('switches tabs by click and by Cmd-#/Cmd-] routing', async () => {
    const renderer = await mount(<Harness owner={owner(kind)} />);
    // Agents are the default shared first content view.
    expect(renderer.root.findByProps({ 'data-agent': 'true' })).toBeTruthy();
    expect(activeView(renderer)).toBe('agent');

    act(() => button(renderer, 'Diff')!.props.onClick());
    expect(activeView(renderer)).toBe('diff');
    expect(renderer.root.findByProps({ 'data-diff': 'true' })).toBeTruthy();

    act(() => applicationEvents.publish('card-tab-shortcut', { number: 4 }));
    expect(activeView(renderer)).toBe('terminal');
    expect(renderer.root.findByProps({ 'data-terminal': 'true' })).toBeTruthy();

    act(() => applicationEvents.publish('card-tab-shortcut', { direction: -1 }));
    expect(activeView(renderer)).toBe('diff');
    act(() => applicationEvents.publish('card-tab-shortcut', { direction: 1 }));
    expect(activeView(renderer)).toBe('terminal');
    act(() => applicationEvents.publish('card-tab-shortcut', { direction: 1 }));
    expect(activeView(renderer)).toBe(kind === 'card' ? 'overview' : 'agent');
    act(() => renderer.unmount());
  });

  it('numbers a displayed disabled tab without selecting it or entering the cycle', async () => {
    const navigable = views(kind).filter((view) => view !== 'diff');
    const renderer = await mount(<Harness owner={owner(kind)} available={navigable} />);
    act(() => applicationEvents.publish('card-tab-shortcut', { number: 3 }));
    expect(activeView(renderer)).toBe('agent');
    expect(renderer.root.findByProps({ 'data-agent': 'true' })).toBeTruthy();
    // Cycling moves over the available views only, never the disabled Diff.
    act(() => applicationEvents.publish('card-tab-shortcut', { direction: 1 }));
    expect(activeView(renderer)).toBe(navigable[(navigable.indexOf('agent') + 1) % navigable.length]);
    act(() => renderer.unmount());
  });

  it('refreshes the diff from the shared strip', async () => {
    const renderer = await mount(<Harness owner={owner(kind)} />);
    act(() => renderer.root.findByProps({ 'aria-label': 'Refresh diff' }).props.onClick());
    expect(refreshDiff).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });

  it('submits a diff review to this owner agent and resets it', async () => {
    const renderer = await mount(<Harness owner={owner(kind)} initialView="diff" />);
    act(() => button(renderer, 'Comment')!.props.onClick());
    expect(renderer.root.findByProps({ 'data-comment': 'overall feedback' })).toBeTruthy();
    await act(async () => { button(renderer, 'Submit')!.props.onClick(); await Promise.resolve(); });
    expect(sendTextToPiEditor).toHaveBeenCalledOnce();
    expect(vi.mocked(sendTextToPiEditor).mock.calls[0][0]).toBe(workAgentId(owner(kind), kind === 'card' ? 'work' : undefined));
    expect(vi.mocked(sendTextToPiEditor).mock.calls[0][1]).toContain('overall feedback');
    expect(activeView(renderer)).toBe('agent');
    expect(renderer.root.findByProps({ 'data-comment': '' })).toBeTruthy();
    expect(pasteCodeIntoTarget).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('pastes into the focused terminal through the shared surface and reveals it', async () => {
    const renderer = await mount(<Harness owner={owner(kind)} initialView="diff" />);
    act(() => button(renderer, 'Paste')!.props.onClick());
    expect(pasteCodeIntoTarget).toHaveBeenCalledOnce();
    const [code, options] = vi.mocked(pasteCodeIntoTarget).mock.calls[0];
    expect(code).toBe('const x = 1;');
    expect(options.paneId).toBe(workTerminalId(owner(kind), 'shell'));
    expect(options.unavailableReason).toBeNull();
    await act(async () => { expect(await options.switchToTerminal()).toBe(true); });
    expect(activeView(renderer)).toBe('terminal');
    act(() => renderer.unmount());
  });

  it('does not offer paste when the terminal is unavailable', async () => {
    const renderer = await mount(<Harness owner={owner(kind)} pasteAvailable={false} />);
    expect(button(renderer, 'Paste')).toBeUndefined();
    act(() => renderer.unmount());
  });

  it('publishes presence for this owner and its agent/terminal', async () => {
    const renderer = await mount(<Harness owner={owner(kind)} />);
    expect(publishWorkPresence).toHaveBeenCalledWith({
      owner: owner(kind),
      view: 'agent',
      agentThread: kind === 'card' ? 'work' : undefined,
      terminalId: workAgentId(owner(kind), kind === 'card' ? 'work' : undefined),
    });
    act(() => button(renderer, 'Terminal')!.props.onClick());
    expect(publishWorkPresence).toHaveBeenLastCalledWith({
      owner: owner(kind),
      view: 'terminal',
      agentThread: undefined,
      terminalId: workTerminalId(owner(kind), 'shell'),
    });
    act(() => renderer.unmount());
  });
});

describe.each(owners)('%s leave rules', (kind) => {
  it('closes only after this host permits leaving', async () => {
    const close = vi.fn();
    const onFlushError = vi.fn();
    if (kind === 'card') {
      const denied = await requestWorkLeave({ canLeave: () => false, close });
      expect(denied).toBe(false);
      expect(close).not.toHaveBeenCalled();
      expect(await requestWorkLeave({ canLeave: () => true, close })).toBe(true);
      expect(close).toHaveBeenCalledOnce();
      return;
    }
    const failed = await requestWorkLeave({ flushNotes: async () => { throw new Error('save failed'); }, onFlushError, close });
    expect(failed).toBe(false);
    expect(onFlushError).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(await requestWorkLeave({ flushNotes: async () => {}, close })).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });
});
