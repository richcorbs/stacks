import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseConfig, ReleaseDraft, ReleaseOperation, ReleaseReconciliation, ReleaseStageState } from '../releaseApi';
import { CommandPreview, ReconciliationSummary, ReleaseStage, ReleaseTab } from './ReleaseTab';

const invoke = vi.hoisted(() => vi.fn());
const eventListeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const polling = vi.hoisted(() => ({ callback: null as null | (() => void) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn((name: string, listener: (event: { payload: unknown }) => void) => {
  eventListeners.set(name, listener);
  return Promise.resolve(() => eventListeners.delete(name));
}) }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal('window', {
  setInterval: vi.fn((callback: () => void) => { polling.callback = callback; return 1; }),
  clearInterval: vi.fn(),
  confirm: vi.fn(() => true),
});
beforeEach(() => { invoke.mockReset(); eventListeners.clear(); polling.callback = null; });

function stage(overrides: Partial<ReleaseStageState> = {}): ReleaseStageState {
  return {
    id: 'publish',
    name: 'Publish artifacts',
    status: 'completed',
    attempt: 2,
    attemptToken: null,
    startedAt: 100,
    completedAt: 105,
    error: null,
    logPath: null,
    log: 'Published https://example.com/release',
    truncated: true,
    ...overrides,
  };
}

function reconciliation(overrides: Partial<ReleaseReconciliation> = {}): ReleaseReconciliation {
  return { protocolVersion: 1, disposition: 'resumableDraft', requestedVersion: '1.2.4', latestPublishedVersion: '1.2.3', sourceRevision: 'source', headRevision: 'head', preparedRevision: 'abcdef1234567890', preparedParent: 'source', approvedPaths: [], localTagRevision: null, remoteTagRevision: 'abcdef1234567890', release: { id: 7, tag: 'v1.2.4', revision: 'abcdef1234567890', title: 'Stacks v1.2.4', notes: '# Notes', target: 'abcdef1234567890', draft: true, prerelease: false, url: 'https://example.com/draft' }, expectedAssets: [], existingAssets: [], missingAssets: [], extraAssets: [], conflictingAssets: [], artifact: {}, identity: { tag: 'v1.2.4' }, issues: [], permittedActions: ['approve'], provenStages: ['prepare', 'build', 'draft'], ...overrides };
}

function config(overrides: Partial<ReleaseConfig> = {}): ReleaseConfig {
  return {
    currentVersion: 'current-version',
    preflight: 'check-project',
    reconciliation: { protocolVersion: 1, command: 'reconcile' },
    stages: [
      { id: 'prepare', name: 'Prepare', run: 'run-prepare', verify: 'verify-prepare', repositoryAccess: 'exclusive', approval: { instructions: 'Review it' } },
      { id: 'publish', name: 'Publish', run: 'run-publish', repositoryAccess: 'read' },
    ],
    ...overrides,
  };
}

describe('command preview', () => {
  it('renders independently accessible steps collapsed by default', () => {
    const markup = renderToStaticMarkup(<CommandPreview config={config()} />);

    expect(markup).toContain('0. Preflight');
    expect(markup).toContain('1. Prepare');
    expect(markup).toContain('2. Publish');
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(3);
    expect(markup.match(/aria-controls="release-preview-step-/g)).toHaveLength(3);
    expect(markup).not.toContain('check-project');
    expect(markup).not.toContain('repository access');
    expect(markup).not.toContain('run-prepare');
  });

  it('omits preflight when it is not configured', () => {
    const markup = renderToStaticMarkup(<CommandPreview config={config({ preflight: null })} />);
    expect(markup).not.toContain('Preflight');
    expect(markup).toContain('1. Prepare');
  });

  it('shows preflight and stage details while keeping multiple steps open', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<CommandPreview config={config()} />); });
    const buttons = renderer.root.findAllByType('button');

    act(() => buttons[0].props.onClick());
    act(() => buttons[1].props.onClick());

    expect(buttons[0].props['aria-expanded']).toBe(true);
    expect(buttons[1].props['aria-expanded']).toBe(true);
    expect(renderer.root.findAllByProps({ className: 'releasePreviewDetails' })).toHaveLength(2);
    expect(renderer.root.findAllByType('code').map((node) => node.children.join(''))).toEqual(['check-project', 'run-prepare', 'verify-prepare']);
    expect(renderer.root.findByProps({ className: 'releasePreviewMetadata' }).children.join('')).toBe('exclusive repository access · approval required');
    expect(renderer.root.findAllByProps({ className: 'releasePreviewDetails' })[0].props.id).toBe(buttons[0].props['aria-controls']);
  });
});

function draft(overrides: Partial<ReleaseDraft> = {}): ReleaseDraft {
  return { valid: true, error: null, configPath: '/repo/.stacks/release.json', currentVersion: '1.2.3', suggestedVersion: '1.2.4', generatedNotes: 'original notes', targetBranch: 'main', sourceRevision: 'source', config: config({ generateNotes: 'generate-notes' }), reconciliation: reconciliation(), ...overrides };
}

function operation(overrides: Partial<ReleaseOperation> = {}): ReleaseOperation {
  return { id: 'operation', projectId: 'project', projectPath: '/repo', repositoryIdentity: '/repo/.git', configPath: '/repo/.stacks/release.json', config: config({ stages: [] }), previousVersion: '1.2.3', version: '1.2.4', notes: 'persisted notes', targetBranch: 'main', initialRevision: 'abcdef1234567890', expectedRevision: 'abcdef1234567890', preparedRevision: null, preparedParent: null, approvedPaths: [], reconciliation: reconciliation({ permittedActions: [] }), identityFingerprint: '', artifactEvidence: null, releaseUrl: null, adopted: false, status: 'failed', stages: [], createdAt: 100, updatedAt: 105, completedAt: null, revision: 1, ...overrides };
}

async function renderReleaseTab(history: ReleaseOperation[] = [], releaseDraft = draft()) {
  invoke.mockImplementation((command: string) => {
    if (command === 'release_inspect') return Promise.resolve(releaseDraft);
    if (command === 'release_history') return Promise.resolve(history);
    return Promise.resolve(undefined);
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<ReleaseTab project={{ id: 'project', name: 'Project', path: '/repo' }} />); });
  return renderer;
}

describe('release durations', () => {
  it('uses compact lowercase durations for operation summaries and release history', async () => {
    const active = operation({ id: 'active', completedAt: 163 });
    const completed = operation({ id: 'completed', status: 'completed', createdAt: 200, updatedAt: 263, completedAt: 263 });
    const renderer = await renderReleaseTab([active, completed]);

    const durations = renderer.root.findAllByProps({ className: 'releaseDuration' });
    expect(durations.map((node) => node.children.join(''))).toEqual(['1m3s', '1m3s']);
  });
});

describe('release status refresh', () => {
  it('refreshes history immediately when the backend reports an operation change', async () => {
    const renderer = await renderReleaseTab([operation({ status: 'running' })]);
    const recovered = operation({ status: 'awaitingApproval', stages: [stage({ status: 'awaitingApproval' })], config: config({ stages: [{ id: 'publish', name: 'Publish artifacts', run: 'publish', repositoryAccess: 'read', approval: { instructions: 'Smoke test' } }] }) });
    invoke.mockImplementation((command: string) => command === 'release_history' ? Promise.resolve([recovered]) : Promise.resolve(draft()));

    await act(async () => { eventListeners.get('release-operation-changed')?.({ payload: 'operation' }); await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(renderer.root.findByProps({ className: 'releaseStatus awaitingApproval' }).children.join('')).toBe('Awaiting smoke-test approval');
  });

  it('retains polling as a fallback while an operation is active', async () => {
    await renderReleaseTab([operation({ status: 'running' })]);
    const callsBeforePoll = invoke.mock.calls.filter(([command]) => command === 'release_history').length;

    await act(async () => { polling.callback?.(); await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(invoke.mock.calls.filter(([command]) => command === 'release_history').length).toBe(callsBeforePoll + 1);
  });

  it('shows recovery diagnostics and keeps Retry release available after inconclusive recovery', async () => {
    const failed = operation({ reconciliation: reconciliation({ disposition: 'conflict', permittedActions: ['refresh'] }), stages: [stage({ status: 'failed', error: 'Settlement failed\nRecovery reconciliation conflicted' })], config: config({ stages: [{ id: 'publish', name: 'Publish artifacts', run: 'publish', repositoryAccess: 'read' }] }) });
    const renderer = await renderReleaseTab([failed]);

    expect(renderer.root.findByProps({ className: 'releaseStageError' }).children.join('')).toContain('Recovery reconciliation conflicted');
    expect(renderer.root.findAllByType('button').some((button) => button.children.join('') === 'Retry release')).toBe(true);
  });

  it('atomically replaces edited notes with regenerated notes and matching evidence', async () => {
    const renderer = await renderReleaseTab();
    act(() => renderer.root.findByType('textarea').props.onChange({ target: { value: 'edited notes' } }));
    const refreshed = reconciliation({ disposition: 'available', requestedVersion: '1.2.4', permittedActions: ['start'] });
    invoke.mockImplementation((command: string, args: unknown) => {
      if (command === 'release_reconcile_preview') {
        expect(args).toEqual({ projectId: 'project', version: '1.2.4', notes: 'edited notes' });
        return Promise.resolve({ notes: 'regenerated notes', reconciliation: refreshed });
      }
      if (command === 'release_history') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    const refresh = renderer.root.findAllByType('button').find((button) => button.children.join('') === 'Refresh release status')!;
    await act(async () => { refresh.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(renderer.root.findByType('textarea').props.value).toBe('regenerated notes');
    expect(renderer.root.findByProps({ className: 'releaseReconciliation available' })).toBeDefined();
    expect(renderer.root.findByType(ReconciliationSummary).props.reconciliation).toBe(refreshed);
  });

  it('keeps the existing notes and evidence when the combined refresh fails', async () => {
    const existing = reconciliation({ disposition: 'conflict' });
    const renderer = await renderReleaseTab([], draft({ reconciliation: existing }));
    invoke.mockImplementation((command: string) => command === 'release_reconcile_preview' ? Promise.reject(new Error('reconciliation failed')) : Promise.resolve([]));

    const refresh = renderer.root.findAllByType('button').find((button) => button.children.join('') === 'Refresh release status')!;
    await act(async () => { refresh.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(renderer.root.findByType('textarea').props.value).toBe('original notes');
    expect(renderer.root.findByType(ReconciliationSummary).props.reconciliation).toBe(existing);
    expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('reconciliation failed');
  });

  it('uses the new label for setup and active-operation refresh actions', async () => {
    const renderer = await renderReleaseTab([operation()]);
    const labels = renderer.root.findAllByType('button').map((button) => button.children.join(''));
    expect(labels.filter((label) => label === 'Refresh release status')).toHaveLength(2);
    expect(labels).not.toContain('Refresh reconciliation');
  });
});

describe('release reconciliation summary', () => {
  it('identifies a resumable draft and opens its GitHub URL', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<ReconciliationSummary reconciliation={reconciliation()} />); });
    expect(renderer.root.findByType('strong').children.join('')).toBe('Draft release found');
    act(() => renderer.root.findByProps({ className: 'releaseLink' }).props.onClick());
    expect(invoke).toHaveBeenCalledWith('open_url', { url: 'https://example.com/draft' });
  });
  it('renders actionable conflict details and revisions', () => {
    const markup = renderToStaticMarkup(<ReconciliationSummary reconciliation={reconciliation({ disposition: 'conflict', issues: ['Remote tag points elsewhere.'], permittedActions: ['refresh'] })} />);
    expect(markup).toContain('Release conflict'); expect(markup).toContain('Remote tag points elsewhere.'); expect(markup).toContain('abcdef123456');
  });
});

describe('ReleaseStage', () => {
  it('renders compact lowercase durations in interactive step headings', () => {
    const minuteMarkup = renderToStaticMarkup(<ReleaseStage stage={stage({ completedAt: 163 })} index={0} />);
    const secondsMarkup = renderToStaticMarkup(<ReleaseStage stage={stage()} index={0} />);

    expect(minuteMarkup).toContain('<small class="releaseDuration">1m3s</small>');
    expect(minuteMarkup).toContain('<button class="releaseStageHeading releaseStageDisclosure"');
    expect(secondsMarkup).toContain('<small class="releaseDuration">5s</small>');
  });

  it('collapses output by default and makes the full heading a disclosure button', () => {
    const markup = renderToStaticMarkup(<ReleaseStage stage={stage()} index={0} />);

    expect(markup).toContain('<button class="releaseStageHeading releaseStageDisclosure"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('Attempt 2');
    expect(markup).not.toContain('releaseLog');
    expect(markup).not.toContain('Attempt 2 log');
  });

  it('keeps an opened stage open when refreshed stage data is rendered', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<ReleaseStage stage={stage()} index={0} />); });

    act(() => renderer.root.findByType('button').props.onClick());
    expect(renderer.root.findByType('button').props['aria-expanded']).toBe(true);
    expect(renderer.root.findByProps({ className: 'releaseStageOutputMeta' }).children.join('')).toBe('Attempt 2 (truncated)');

    act(() => renderer.update(<ReleaseStage stage={stage({ status: 'running', completedAt: null, log: 'Updated output' })} index={0} />));
    expect(renderer.root.findByType('button').props['aria-expanded']).toBe(true);
    expect(renderer.root.findByProps({ className: 'releaseLog' }).children).toContain('Updated output');
  });

  it('leaves stages without output non-interactive', () => {
    const markup = renderToStaticMarkup(<ReleaseStage stage={stage({ log: '' })} index={0} />);

    expect(markup).toContain('<div class="releaseStageHeading">');
    expect(markup).not.toContain('aria-expanded');
    expect(markup).not.toContain('releaseStageDisclosureIndicator');
    expect(markup).not.toContain('<button');
  });

  it('opens output URLs without closing the disclosure', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<ReleaseStage stage={stage()} index={0} />); });
    act(() => renderer.root.findByType('button').props.onClick());

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    act(() => renderer.root.findByType('a').props.onClick({ preventDefault, stopPropagation }));

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('open_url', { url: 'https://example.com/release' });
    expect(renderer.root.findByType('button').props['aria-expanded']).toBe(true);
  });
});
