import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ReleaseReconciliation, ReleaseStageState } from '../releaseApi';
import { ReconciliationSummary, ReleaseStage } from './ReleaseTab';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

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
